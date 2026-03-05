/**
 * JetPayment - Main Gateway Orchestrator
 *
 * Wires together Discovery, P2P, Negotiation, and Settlement
 * into a unified agent-facing API with Function Calling interface.
 */

import { EventEmitter } from 'events';
import { Keypair, PublicKey } from '@solana/web3.js';
import { DiscoveryService, type MoltbookConfig } from '../discovery';
import { P2PService, type P2PConfig } from '../p2p';
import { NegotiationEngine } from '../negotiation/engine';
import { MessageBuilder } from '../negotiation/message-builder';
import { SettlementService, type SettlementConfig } from '../settlement';
import { PolicyEngine } from './policy-engine';
import { bytesToHex, hexToBytes } from '../crypto';
import {
  GatewayEvent,
  type GatewayPolicy,
  type GatewayEventPayload,
  type InitiateDealParams,
  type EvaluateProposalParams,
  type SignTransactionParams,
  type OfferContent,
  type NegotiationMessage,
  type SafetyCheckResult,
} from '../types';

export interface JetPaymentConfig {
  moltbook: MoltbookConfig;
  p2p: P2PConfig;
  settlement: SettlementConfig;
  policy: GatewayPolicy;
}

/**
 * JetPaymentGateway is the main entry point for AI agents.
 *
 * It exposes three Function Calling tools:
 * - initiate_deal: Start a new trade
 * - evaluate_proposal: Respond to incoming proposals
 * - sign_transaction: Authorize on-chain settlement
 *
 * The gateway enforces Defense-in-Depth policies between
 * the AI's decisions and actual blockchain execution.
 */
export class JetPaymentGateway extends EventEmitter {
  private discovery: DiscoveryService;
  private p2p: P2PService;
  private negotiation: NegotiationEngine;
  private settlement: SettlementService;
  private policyEngine: PolicyEngine;
  private walletKeypair: Keypair;
  private config: JetPaymentConfig;

  // Maps P2P session IDs to conversation IDs and vice versa
  private sessionToConversation: Map<string, string> = new Map();
  private conversationToSession: Map<string, string> = new Map();

  constructor(config: JetPaymentConfig, walletKeypair: Keypair) {
    super();
    this.config = config;
    this.walletKeypair = walletKeypair;

    const pubkeyHex = bytesToHex(walletKeypair.publicKey.toBytes());
    const secretBytes = walletKeypair.secretKey;

    // Initialize sub-services
    this.discovery = new DiscoveryService(
      config.moltbook,
      walletKeypair.publicKey.toBytes(),
      secretBytes.slice(0, 32)
    );

    this.p2p = new P2PService(
      config.p2p,
      walletKeypair.publicKey.toBytes(),
      secretBytes.slice(0, 32)
    );

    this.negotiation = new NegotiationEngine(
      secretBytes.slice(0, 32),
      pubkeyHex,
      config.policy
    );

    this.settlement = new SettlementService(config.settlement, walletKeypair);

    this.policyEngine = new PolicyEngine(config.policy);

    this.wireEvents();
  }

  // ============================================================
  // Agent Function Calling Interface
  // ============================================================

  /**
   * Tool: initiate_deal
   *
   * Start a new trade with a target agent. This function:
   * 1. Creates an ephemeral Libp2p node
   * 2. Encrypts connection info for the target
   * 3. Posts the invitation to Moltbook
   * 4. Begins listening for the target's connection
   * 5. Sends a CFP once the P2P channel is established
   */
  async initiateDeal(
    params: InitiateDealParams
  ): Promise<{ conversationId: string; sessionId: string }> {
    const targetPubkeyBytes = hexToBytes(params.targetId);

    // Create ephemeral P2P node
    const { sessionId, multiaddr } =
      await this.p2p.createEphemeralNode(
        require('../crypto').generateSessionToken()
      );

    // Create encrypted invitation
    const { invitation, connectionInfo } = this.discovery.createInvitation(
      targetPubkeyBytes,
      multiaddr
    );

    // Start negotiation
    const { conversationId, message } = this.negotiation.startNegotiation(
      params.targetId,
      params.initialTerms,
      bytesToHex(this.walletKeypair.publicKey.toBytes())
    );

    // Link session to conversation
    this.sessionToConversation.set(sessionId, conversationId);
    this.conversationToSession.set(conversationId, sessionId);

    // Publish invitation to Moltbook
    // (In production, resolve target's Moltbook handle from their pubkey)
    try {
      await this.discovery.publishInvitation(params.targetId, invitation);
    } catch (err) {
      // Log but don't fail — the invitation can also be delivered out-of-band
      this.emitEvent(GatewayEvent.SAFETY_CHECK_FAILED, sessionId, {
        error: 'Failed to publish invitation to Moltbook',
        details: err,
      });
    }

    this.emitEvent(GatewayEvent.INVITATION_RECEIVED, sessionId, {
      conversationId,
      targetId: params.targetId,
    });

    return { conversationId, sessionId };
  }

  /**
   * Tool: evaluate_proposal
   *
   * Respond to an incoming proposal or counter-offer.
   * The AI agent calls this after reasoning about the terms.
   */
  evaluateProposal(params: EvaluateProposalParams): NegotiationMessage {
    const conversationId = this.sessionToConversation.get(params.sessionId);
    if (!conversationId) {
      throw new Error(`No conversation found for session ${params.sessionId}`);
    }

    // Anomaly detection: check for infinite counter-offer loops
    if (params.decision === 'COUNTER') {
      if (this.policyEngine.checkCounterOfferAnomaly(conversationId)) {
        this.negotiation.terminateSession(
          conversationId,
          'Circuit breaker: excessive counter-offers'
        );
        throw new Error('Circuit breaker triggered: too many counter-offers');
      }
    }

    const message = this.negotiation.respond(
      conversationId,
      params.decision,
      params.counterTerms,
      params.reasoning
    );

    // Send the message over P2P
    const sessionId = params.sessionId;
    const messageBytes = new TextEncoder().encode(JSON.stringify(message));
    this.p2p.sendMessage(sessionId, messageBytes).catch((err) => {
      this.emitEvent(GatewayEvent.SETTLEMENT_FAILED, sessionId, { error: err });
    });

    return message;
  }

  /**
   * Tool: sign_transaction
   *
   * Authorize on-chain settlement after deal acceptance.
   * This is where Defense-in-Depth kicks in — the policy engine
   * validates everything before the private key is used.
   */
  async signTransaction(
    params: SignTransactionParams
  ): Promise<SafetyCheckResult & { transactionSignature?: string }> {
    const conversationId = this.sessionToConversation.get(params.sessionId);
    if (!conversationId) {
      throw new Error(`No conversation found for session ${params.sessionId}`);
    }

    const session = this.negotiation.getSession(conversationId);
    if (!session) {
      throw new Error(`Negotiation session not found: ${conversationId}`);
    }

    // === Defense in Depth: Policy Validation ===
    const safetyResult = this.policyEngine.validateTransaction(
      params.agreedTerms,
      session
    );

    if (!safetyResult.approved) {
      this.emitEvent(GatewayEvent.SAFETY_CHECK_FAILED, params.sessionId, {
        reason: safetyResult.reason,
        requiresHumanApproval: safetyResult.requiresHumanApproval,
      });
      return safetyResult;
    }

    // === Execute On-chain Settlement ===
    try {
      const dealId = this.settlement.computeDealId(params.agreedTerms);
      const responderPubkey = new PublicKey(hexToBytes(session.responder));
      const mintPubkey = new PublicKey(params.agreedTerms.give_asset);

      const result = await this.settlement.initializeDeal(
        responderPubkey,
        mintPubkey,
        BigInt(params.agreedTerms.give_amount),
        dealId
      );

      this.emitEvent(GatewayEvent.SETTLEMENT_COMPLETE, params.sessionId, {
        transactionSignature: result.transactionSignature,
        dealId,
      });

      return {
        approved: true,
        transactionSignature: result.transactionSignature,
      };
    } catch (err) {
      this.emitEvent(GatewayEvent.SETTLEMENT_FAILED, params.sessionId, {
        error: err,
      });
      return {
        approved: false,
        reason: `Settlement failed: ${err}`,
      };
    }
  }

  // ============================================================
  // Lifecycle
  // ============================================================

  /**
   * Start the gateway: begin polling Moltbook and listening for P2P.
   */
  async start(): Promise<void> {
    this.discovery.startPolling();
    this.emit('started');
  }

  /**
   * Gracefully shut down the gateway.
   */
  async stop(): Promise<void> {
    this.discovery.destroy();
    await this.p2p.destroyAll();
    this.negotiation.destroy();
    await this.settlement.destroy();
    this.removeAllListeners();
    this.emit('stopped');
  }

  /**
   * Get the Function Calling tool definitions for an AI agent SDK.
   */
  getToolDefinitions(): object[] {
    return [
      {
        name: 'initiate_deal',
        description:
          'Start a new trade with a target AI agent. Creates an encrypted P2P channel and sends initial terms.',
        parameters: {
          type: 'object',
          properties: {
            targetId: {
              type: 'string',
              description: "Target agent's Solana public key (hex)",
            },
            initialTerms: {
              type: 'object',
              description: 'Initial trade terms',
              properties: {
                give_asset: { type: 'string', description: 'Token mint address to offer' },
                give_amount: { type: 'number', description: 'Amount to offer (in base units)' },
                take_asset: { type: 'string', description: 'Token mint address to request' },
                take_amount: { type: 'number', description: 'Amount to request (in base units)' },
              },
              required: ['give_asset', 'give_amount', 'take_asset', 'take_amount'],
            },
          },
          required: ['targetId', 'initialTerms'],
        },
      },
      {
        name: 'evaluate_proposal',
        description:
          'Respond to an incoming trade proposal. Accept, reject, or counter-offer.',
        parameters: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', description: 'Active P2P session ID' },
            decision: {
              type: 'string',
              enum: ['ACCEPT', 'REJECT', 'COUNTER'],
              description: 'Your decision on the proposal',
            },
            counterTerms: {
              type: 'object',
              description: 'Counter-offer terms (required if decision is COUNTER)',
              properties: {
                give_asset: { type: 'string' },
                give_amount: { type: 'number' },
                take_asset: { type: 'string' },
                take_amount: { type: 'number' },
              },
            },
            reasoning: {
              type: 'string',
              description: 'Explanation for the decision',
            },
          },
          required: ['sessionId', 'decision'],
        },
      },
      {
        name: 'sign_transaction',
        description:
          'Authorize on-chain settlement after a deal is accepted. The gateway will validate all safety policies before signing.',
        parameters: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', description: 'Active P2P session ID' },
            agreedTerms: {
              type: 'object',
              description: 'The final agreed trade terms',
              properties: {
                give_asset: { type: 'string' },
                give_amount: { type: 'number' },
                take_asset: { type: 'string' },
                take_amount: { type: 'number' },
              },
              required: ['give_asset', 'give_amount', 'take_asset', 'take_amount'],
            },
          },
          required: ['sessionId', 'agreedTerms'],
        },
      },
    ];
  }

  // ============================================================
  // Internal Event Wiring
  // ============================================================

  private wireEvents(): void {
    // Discovery → P2P handoff
    this.discovery.on('invitation_received', async (data) => {
      try {
        const sessionId = await this.p2p.connectToAgent(
          data.connectionInfo.multiaddr,
          data.connectionInfo.sessionToken
        );
        this.emitEvent(GatewayEvent.PEER_CONNECTED, sessionId, data);
      } catch (err) {
        this.emit('error', { phase: 'discovery->p2p', error: err });
      }
    });

    // P2P → Negotiation handoff
    this.p2p.on('message', ({ sessionId, data }) => {
      try {
        const json = new TextDecoder().decode(data);
        const message: NegotiationMessage = JSON.parse(json);
        this.negotiation.handleIncomingMessage(message);
      } catch (err) {
        this.emit('error', { phase: 'p2p->negotiation', sessionId, error: err });
      }
    });

    // Negotiation events → Gateway events
    this.negotiation.on('deal_accepted', (data) => {
      const sessionId = this.conversationToSession.get(data.conversationId) || '';
      this.emitEvent(GatewayEvent.DEAL_ACCEPTED, sessionId, data);
    });

    this.negotiation.on('deal_rejected', (data) => {
      const sessionId = this.conversationToSession.get(data.conversationId) || '';
      this.emitEvent(GatewayEvent.DEAL_REJECTED, sessionId, data);
    });

    this.negotiation.on('proposal_received', (data) => {
      const sessionId = this.conversationToSession.get(data.conversationId) || '';
      this.emitEvent(GatewayEvent.PROPOSAL_RECEIVED, sessionId, data);
    });

    this.negotiation.on('session_timeout', (data) => {
      const sessionId = this.conversationToSession.get(data.conversationId) || '';
      this.emitEvent(GatewayEvent.SESSION_TIMEOUT, sessionId, data);

      // Clean up P2P node on timeout
      if (sessionId) {
        this.p2p.destroySession(sessionId).catch(() => {});
      }
    });

    // Settlement events
    this.settlement.on('on_chain_deal_completed', (data) => {
      this.emit('settlement_confirmed', data);

      // Clean up the session after on-chain confirmation
      for (const [sid, cid] of this.sessionToConversation) {
        // Find the matching session and destroy it
        this.p2p.destroySession(sid).catch(() => {});
        break;
      }
    });

    // P2P disconnect → cleanup
    this.p2p.on('peer_disconnected', ({ sessionId }) => {
      this.emitEvent(GatewayEvent.PEER_DISCONNECTED, sessionId, {});
    });
  }

  private emitEvent(
    event: GatewayEvent,
    sessionId: string,
    data: unknown
  ): void {
    const payload: GatewayEventPayload = {
      event,
      sessionId,
      data,
      timestamp: Date.now(),
    };
    this.emit('gateway_event', payload);
    this.emit(event, payload);
  }
}
