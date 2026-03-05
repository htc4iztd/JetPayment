/**
 * JetPayment - Negotiation Engine
 *
 * Orchestrates the off-chain negotiation process:
 * - Manages negotiation sessions
 * - Coordinates state machine transitions
 * - Provides the AI agent interface (Function Calling)
 * - Enforces TTL and circuit breaker policies
 */

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { NegotiationStateMachine } from './state-machine';
import { MessageBuilder } from './message-builder';
import {
  NegotiationState,
  Performative,
  type NegotiationMessage,
  type NegotiationSession,
  type OfferContent,
  type GatewayPolicy,
} from '../types';

export class NegotiationEngine extends EventEmitter {
  private sessions: Map<string, NegotiationStateMachine> = new Map();
  private messageBuilder: MessageBuilder;
  private policy: GatewayPolicy;
  private sessionTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(
    gatewaySecretKey: Uint8Array,
    gatewayPubkeyHex: string,
    policy: GatewayPolicy
  ) {
    super();
    this.messageBuilder = new MessageBuilder(gatewaySecretKey, gatewayPubkeyHex);
    this.policy = policy;
  }

  /**
   * Start a new negotiation as Initiator by sending a CFP.
   */
  startNegotiation(
    responderPubkey: string,
    initialOffer: OfferContent,
    myPubkey: string
  ): { conversationId: string; message: NegotiationMessage } {
    const conversationId = `conv-${uuidv4().slice(0, 8)}`;

    const session: NegotiationSession = {
      conversationId,
      state: NegotiationState.IDLE,
      messages: [],
      initiator: myPubkey,
      responder: responderPubkey,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      maxRounds: this.policy.maxNegotiationRounds,
      currentRound: 0,
    };

    const sm = new NegotiationStateMachine(session);
    this.sessions.set(conversationId, sm);

    // Build CFP message
    const message = this.messageBuilder.buildCFP(
      conversationId,
      responderPubkey,
      initialOffer,
      this.policy.sessionTtlSeconds
    );

    // Transition state
    sm.transitionOnSend(Performative.CFP);
    session.messages.push(message);

    // Start TTL timer
    this.startSessionTimer(conversationId);

    this.emit('negotiation_started', { conversationId, message });
    return { conversationId, message };
  }

  /**
   * Handle an incoming negotiation message from the P2P stream.
   */
  handleIncomingMessage(message: NegotiationMessage): void {
    const { conversation_id, performative } = message.envelope;

    let sm = this.sessions.get(conversation_id);

    // If this is a CFP we haven't seen, create a new session as Responder
    if (!sm && performative === Performative.CFP) {
      const session: NegotiationSession = {
        conversationId: conversation_id,
        state: NegotiationState.CFP_RECEIVED,
        messages: [message],
        initiator: message.envelope.sender,
        responder: message.envelope.receiver,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        maxRounds: this.policy.maxNegotiationRounds,
        currentRound: 0,
      };

      sm = new NegotiationStateMachine(session);
      this.sessions.set(conversation_id, sm);
      this.startSessionTimer(conversation_id);

      this.emit('cfp_received', { conversationId: conversation_id, message });
      return;
    }

    if (!sm) {
      this.emit('error', {
        error: `Unknown conversation: ${conversation_id}`,
      });
      return;
    }

    // Transition state based on received performative
    try {
      sm.transitionOnReceive(performative as Performative);
      sm.getSession().messages.push(message);

      if (sm.getSession().state === NegotiationState.ACCEPTED) {
        this.clearSessionTimer(conversation_id);
        this.emit('deal_accepted', {
          conversationId: conversation_id,
          agreedTerms: sm.getSession().agreedTerms,
          dealId: sm.getSession().dealId,
        });
      } else if (sm.getSession().state === NegotiationState.REJECTED) {
        this.clearSessionTimer(conversation_id);
        this.emit('deal_rejected', { conversationId: conversation_id, message });
      } else {
        // Proposal or counter-offer received — notify agent for decision
        this.emit('proposal_received', {
          conversationId: conversation_id,
          message,
          validResponses: sm.getValidSendPerformatives(),
        });
      }
    } catch (err) {
      this.emit('error', { conversationId: conversation_id, error: err });
    }
  }

  /**
   * Agent responds to a received proposal.
   * This is the core Function Calling interface for the AI.
   */
  respond(
    conversationId: string,
    decision: 'ACCEPT' | 'REJECT' | 'COUNTER',
    counterTerms?: OfferContent,
    reasoning?: string
  ): NegotiationMessage {
    const sm = this.sessions.get(conversationId);
    if (!sm) {
      throw new Error(`Unknown conversation: ${conversationId}`);
    }

    const session = sm.getSession();
    const lastMsg = session.messages[session.messages.length - 1];
    if (!lastMsg) {
      throw new Error('No messages in conversation');
    }

    const receiverPubkey = lastMsg.envelope.sender;
    let message: NegotiationMessage;

    switch (decision) {
      case 'ACCEPT':
        message = this.messageBuilder.buildAccept(
          conversationId,
          lastMsg.envelope.message_id,
          receiverPubkey,
          lastMsg.content.offer
        );
        sm.transitionOnSend(Performative.ACCEPT_PROPOSAL);
        this.clearSessionTimer(conversationId);
        break;

      case 'REJECT':
        message = this.messageBuilder.buildReject(
          conversationId,
          lastMsg.envelope.message_id,
          receiverPubkey,
          reasoning || 'Terms not acceptable'
        );
        sm.transitionOnSend(Performative.REJECT_PROPOSAL);
        this.clearSessionTimer(conversationId);
        break;

      case 'COUNTER':
        if (!counterTerms) {
          throw new Error('Counter terms required for COUNTER decision');
        }
        message = this.messageBuilder.buildCounterOffer(
          conversationId,
          lastMsg.envelope.message_id,
          receiverPubkey,
          counterTerms,
          reasoning
        );
        sm.transitionOnSend(Performative.COUNTER_OFFER);
        break;

      default:
        throw new Error(`Invalid decision: ${decision}`);
    }

    session.messages.push(message);
    this.emit('message_sent', { conversationId, message });

    return message;
  }

  /**
   * Get a negotiation session by conversation ID.
   */
  getSession(conversationId: string): NegotiationSession | undefined {
    return this.sessions.get(conversationId)?.getSession();
  }

  /**
   * Get all active (non-terminal) sessions.
   */
  getActiveSessions(): NegotiationSession[] {
    const active: NegotiationSession[] = [];
    for (const sm of this.sessions.values()) {
      if (!sm.isTerminal()) {
        active.push(sm.getSession());
      }
    }
    return active;
  }

  /**
   * Force-terminate a session (circuit breaker).
   */
  terminateSession(conversationId: string, reason: string): void {
    const sm = this.sessions.get(conversationId);
    if (sm) {
      sm.timeout();
      this.clearSessionTimer(conversationId);
      this.emit('session_terminated', { conversationId, reason });
    }
  }

  // ============================================================
  // TTL Management
  // ============================================================

  private startSessionTimer(conversationId: string): void {
    const timer = setTimeout(() => {
      const sm = this.sessions.get(conversationId);
      if (sm && !sm.isTerminal()) {
        sm.timeout();
        this.emit('session_timeout', { conversationId });
      }
    }, this.policy.sessionTtlSeconds * 1000);

    this.sessionTimers.set(conversationId, timer);
  }

  private clearSessionTimer(conversationId: string): void {
    const timer = this.sessionTimers.get(conversationId);
    if (timer) {
      clearTimeout(timer);
      this.sessionTimers.delete(conversationId);
    }
  }

  /**
   * Clean up all resources.
   */
  destroy(): void {
    for (const timer of this.sessionTimers.values()) {
      clearTimeout(timer);
    }
    this.sessionTimers.clear();
    this.sessions.clear();
    this.removeAllListeners();
  }
}
