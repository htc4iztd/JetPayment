/**
 * Tests for JetPayment Off-chain Negotiation Layer
 *
 * Covers: State machine transitions, message building,
 * deal_id computation, and policy enforcement.
 */

import {
  NegotiationStateMachine,
  InvalidTransitionError,
} from '../src/negotiation/state-machine';
import { MessageBuilder } from '../src/negotiation/message-builder';
import { NegotiationEngine } from '../src/negotiation/engine';
import { PolicyEngine } from '../src/gateway/policy-engine';
import {
  NegotiationState,
  Performative,
  type NegotiationSession,
  type OfferContent,
  type GatewayPolicy,
} from '../src/types';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex } from '../src/crypto';

// Test fixtures
const secretKeyA = ed25519.utils.randomPrivateKey();
const publicKeyA = ed25519.getPublicKey(secretKeyA);
const pubkeyHexA = bytesToHex(publicKeyA);

const secretKeyB = ed25519.utils.randomPrivateKey();
const publicKeyB = ed25519.getPublicKey(secretKeyB);
const pubkeyHexB = bytesToHex(publicKeyB);

const testOffer: OfferContent = {
  give_asset: 'USDC_MINT_ADDRESS',
  give_amount: 100_000_000,
  take_asset: 'NFT_MINT_ADDRESS',
  take_amount: 1,
};

function createSession(
  overrides: Partial<NegotiationSession> = {}
): NegotiationSession {
  return {
    conversationId: 'conv-test',
    state: NegotiationState.IDLE,
    messages: [],
    initiator: pubkeyHexA,
    responder: pubkeyHexB,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    maxRounds: 20,
    currentRound: 0,
    ...overrides,
  };
}

describe('NegotiationStateMachine', () => {
  it('should transition IDLE → CFP_SENT on sending CFP', () => {
    const sm = new NegotiationStateMachine(createSession());
    const next = sm.transitionOnSend(Performative.CFP);
    expect(next).toBe(NegotiationState.CFP_SENT);
  });

  it('should transition CFP_SENT → PROPOSAL_RECEIVED on receiving PROPOSE', () => {
    const session = createSession({ state: NegotiationState.CFP_SENT });
    const sm = new NegotiationStateMachine(session);
    const next = sm.transitionOnReceive(Performative.PROPOSE);
    expect(next).toBe(NegotiationState.PROPOSAL_RECEIVED);
  });

  it('should transition PROPOSAL_RECEIVED → ACCEPTED on sending ACCEPT', () => {
    const session = createSession({
      state: NegotiationState.PROPOSAL_RECEIVED,
    });
    const sm = new NegotiationStateMachine(session);
    const next = sm.transitionOnSend(Performative.ACCEPT_PROPOSAL);
    expect(next).toBe(NegotiationState.ACCEPTED);
  });

  it('should transition PROPOSAL_RECEIVED → COUNTER_SENT on sending COUNTER', () => {
    const session = createSession({
      state: NegotiationState.PROPOSAL_RECEIVED,
    });
    const sm = new NegotiationStateMachine(session);
    const next = sm.transitionOnSend(Performative.COUNTER_OFFER);
    expect(next).toBe(NegotiationState.COUNTER_SENT);
  });

  it('should support multi-round counter-offer exchange', () => {
    const session = createSession({ state: NegotiationState.CFP_SENT });
    const sm = new NegotiationStateMachine(session);

    // Receive PROPOSE
    sm.transitionOnReceive(Performative.PROPOSE);
    expect(session.state).toBe(NegotiationState.PROPOSAL_RECEIVED);

    // Send COUNTER
    sm.transitionOnSend(Performative.COUNTER_OFFER);
    expect(session.state).toBe(NegotiationState.COUNTER_SENT);

    // Receive COUNTER
    sm.transitionOnReceive(Performative.COUNTER_OFFER);
    expect(session.state).toBe(NegotiationState.COUNTER_RECEIVED);

    // Send ACCEPT
    sm.transitionOnSend(Performative.ACCEPT_PROPOSAL);
    expect(session.state).toBe(NegotiationState.ACCEPTED);
  });

  it('should throw InvalidTransitionError for invalid transitions', () => {
    const sm = new NegotiationStateMachine(createSession());
    expect(() => sm.transitionOnSend(Performative.ACCEPT_PROPOSAL)).toThrow(
      InvalidTransitionError
    );
  });

  it('should throw when in terminal state', () => {
    const session = createSession({ state: NegotiationState.ACCEPTED });
    const sm = new NegotiationStateMachine(session);
    expect(() => sm.transitionOnSend(Performative.CFP)).toThrow(
      'terminal state'
    );
  });

  it('should trigger circuit breaker on max rounds', () => {
    const session = createSession({ maxRounds: 2, currentRound: 2 });
    const sm = new NegotiationStateMachine(session);
    expect(() => sm.transitionOnSend(Performative.CFP)).toThrow(
      'circuit breaker'
    );
    expect(session.state).toBe(NegotiationState.TIMED_OUT);
  });

  it('should report correct valid send performatives', () => {
    const session = createSession({
      state: NegotiationState.PROPOSAL_RECEIVED,
    });
    const sm = new NegotiationStateMachine(session);
    const valid = sm.getValidSendPerformatives();
    expect(valid).toContain(Performative.ACCEPT_PROPOSAL);
    expect(valid).toContain(Performative.REJECT_PROPOSAL);
    expect(valid).toContain(Performative.COUNTER_OFFER);
  });

  it('should return empty performatives for terminal states', () => {
    const session = createSession({ state: NegotiationState.REJECTED });
    const sm = new NegotiationStateMachine(session);
    expect(sm.getValidSendPerformatives()).toEqual([]);
  });
});

describe('MessageBuilder', () => {
  const builder = new MessageBuilder(secretKeyA, pubkeyHexA);

  it('should build a CFP message with correct structure', () => {
    const msg = builder.buildCFP('conv-1', pubkeyHexB, testOffer, 300);
    expect(msg.envelope.performative).toBe(Performative.CFP);
    expect(msg.envelope.sender).toBe(pubkeyHexA);
    expect(msg.envelope.receiver).toBe(pubkeyHexB);
    expect(msg.envelope.message_id).toMatch(/^msg-/);
    expect(msg.envelope.gateway_signature).toBeTruthy();
    expect(msg.content.offer).toEqual(testOffer);
    expect(msg.content.ttl_seconds).toBe(300);
  });

  it('should build ACCEPT with deal_id hash', () => {
    const msg = builder.buildAccept('conv-1', 'msg-prev', pubkeyHexB, testOffer);
    expect(msg.envelope.performative).toBe(Performative.ACCEPT_PROPOSAL);
    expect(msg.content.deal_id).toBeTruthy();
    expect(msg.content.deal_id!.length).toBe(64); // SHA-256 hex
  });

  it('should produce deterministic deal_id for same terms', () => {
    const id1 = builder.computeDealId(testOffer);
    const id2 = builder.computeDealId(testOffer);
    expect(id1).toBe(id2);
  });

  it('should produce different deal_id for different terms', () => {
    const id1 = builder.computeDealId(testOffer);
    const id2 = builder.computeDealId({ ...testOffer, give_amount: 200_000_000 });
    expect(id1).not.toBe(id2);
  });
});

describe('PolicyEngine', () => {
  const policy: GatewayPolicy = {
    maxTransactionAmount: BigInt(1_000_000_000),
    allowedAssets: ['USDC_MINT_ADDRESS', 'NFT_MINT_ADDRESS'],
    maxNegotiationRounds: 10,
    maxDealsPerMinute: 5,
    humanApprovalThreshold: BigInt(500_000_000),
    sessionTtlSeconds: 300,
  };

  it('should approve valid transactions', () => {
    const engine = new PolicyEngine(policy);
    const session = createSession({
      state: NegotiationState.ACCEPTED,
      agreedTerms: testOffer,
      dealId: new MessageBuilder(secretKeyA, pubkeyHexA).computeDealId(testOffer),
    });

    const result = engine.validateTransaction(testOffer, session);
    expect(result.approved).toBe(true);
  });

  it('should reject transactions exceeding max amount', () => {
    const engine = new PolicyEngine(policy);
    const bigOffer = { ...testOffer, give_amount: 2_000_000_000 };
    const session = createSession();

    const result = engine.validateTransaction(bigOffer, session);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('exceeds maximum');
  });

  it('should reject non-whitelisted assets', () => {
    const engine = new PolicyEngine(policy);
    const badOffer = { ...testOffer, give_asset: 'UNKNOWN_TOKEN' };
    const session = createSession();

    const result = engine.validateTransaction(badOffer, session);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('not in the approved whitelist');
  });

  it('should flag for human approval above threshold', () => {
    const engine = new PolicyEngine(policy);
    const highOffer = { ...testOffer, give_amount: 600_000_000 };
    const session = createSession();

    const result = engine.validateTransaction(highOffer, session);
    expect(result.approved).toBe(false);
    expect(result.requiresHumanApproval).toBe(true);
  });

  it('should detect deal_id mismatch (anti-hallucination)', () => {
    const engine = new PolicyEngine(policy);
    const session = createSession({
      state: NegotiationState.ACCEPTED,
      agreedTerms: testOffer,
      dealId: 'wrong_deal_id_hash_pretending_to_be_real_0000000000000000',
    });

    const result = engine.validateTransaction(testOffer, session);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('hallucination or tampering');
  });

  it('should enforce rate limits', () => {
    const engine = new PolicyEngine({ ...policy, maxDealsPerMinute: 2 });
    const session = createSession();

    engine.validateTransaction(testOffer, session); // 1
    engine.validateTransaction(testOffer, session); // 2
    const result = engine.validateTransaction(testOffer, session); // 3 → blocked
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('Rate limit exceeded');
  });

  it('should detect counter-offer anomalies', () => {
    const engine = new PolicyEngine({ ...policy, maxNegotiationRounds: 3 });

    expect(engine.checkCounterOfferAnomaly('conv-1')).toBe(false); // 1
    expect(engine.checkCounterOfferAnomaly('conv-1')).toBe(false); // 2
    expect(engine.checkCounterOfferAnomaly('conv-1')).toBe(false); // 3
    expect(engine.checkCounterOfferAnomaly('conv-1')).toBe(true);  // 4 → circuit breaker
  });
});

describe('NegotiationEngine', () => {
  const policy: GatewayPolicy = {
    maxTransactionAmount: BigInt(1_000_000_000),
    allowedAssets: ['USDC_MINT_ADDRESS', 'NFT_MINT_ADDRESS'],
    maxNegotiationRounds: 20,
    maxDealsPerMinute: 10,
    humanApprovalThreshold: BigInt(500_000_000),
    sessionTtlSeconds: 300,
  };

  it('should start a negotiation and emit events', () => {
    const engine = new NegotiationEngine(secretKeyA, pubkeyHexA, policy);
    const events: string[] = [];
    engine.on('negotiation_started', () => events.push('started'));

    const { conversationId, message } = engine.startNegotiation(
      pubkeyHexB,
      testOffer,
      pubkeyHexA
    );

    expect(conversationId).toMatch(/^conv-/);
    expect(message.envelope.performative).toBe(Performative.CFP);
    expect(events).toContain('started');

    const session = engine.getSession(conversationId);
    expect(session?.state).toBe(NegotiationState.CFP_SENT);

    engine.destroy();
  });

  it('should handle full negotiation flow', () => {
    const engineA = new NegotiationEngine(secretKeyA, pubkeyHexA, policy);
    const engineB = new NegotiationEngine(secretKeyB, pubkeyHexB, policy);

    // Agent A starts negotiation
    const { conversationId, message: cfp } = engineA.startNegotiation(
      pubkeyHexB,
      testOffer,
      pubkeyHexA
    );

    // Agent B receives CFP
    engineB.handleIncomingMessage(cfp);
    const sessionB = engineB.getSession(conversationId);
    expect(sessionB?.state).toBe(NegotiationState.CFP_RECEIVED);

    // Agent B proposes
    const proposal = engineB.respond(conversationId, 'COUNTER', {
      give_asset: 'USDC_MINT_ADDRESS',
      give_amount: 150_000_000,
      take_asset: 'NFT_MINT_ADDRESS',
      take_amount: 1,
    }, 'Price is too low');

    // Agent A receives counter-offer
    engineA.handleIncomingMessage(proposal);
    const sessionA = engineA.getSession(conversationId);
    expect(sessionA?.state).toBe(NegotiationState.COUNTER_RECEIVED);

    // Agent A accepts
    const accept = engineA.respond(conversationId, 'ACCEPT');
    expect(accept.envelope.performative).toBe(Performative.ACCEPT_PROPOSAL);

    expect(engineA.getSession(conversationId)?.state).toBe(
      NegotiationState.ACCEPTED
    );

    engineA.destroy();
    engineB.destroy();
  });

  it('should list active sessions', () => {
    const engine = new NegotiationEngine(secretKeyA, pubkeyHexA, policy);
    engine.startNegotiation(pubkeyHexB, testOffer, pubkeyHexA);
    engine.startNegotiation(pubkeyHexB, testOffer, pubkeyHexA);

    expect(engine.getActiveSessions().length).toBe(2);
    engine.destroy();
  });
});
