/**
 * JetPayment - Negotiation State Machine
 *
 * Deterministic FIPA ACL state machine that governs valid
 * performative transitions during off-chain negotiation.
 * Prevents invalid state transitions and enforces protocol rules.
 */

import {
  NegotiationState,
  Performative,
  type NegotiationMessage,
  type NegotiationSession,
  type OfferContent,
} from '@jetpayment/core';

/** Valid state transitions: [currentState, performative] → nextState */
const TRANSITION_TABLE: Record<string, NegotiationState> = {
  // Initiator sends CFP
  [`${NegotiationState.IDLE}:${Performative.CFP}`]: NegotiationState.CFP_SENT,

  // Responder receives CFP and can PROPOSE, COUNTER, or REJECT
  [`${NegotiationState.CFP_RECEIVED}:${Performative.PROPOSE}`]: NegotiationState.PROPOSAL_SENT,
  [`${NegotiationState.CFP_RECEIVED}:${Performative.COUNTER_OFFER}`]: NegotiationState.COUNTER_SENT,
  [`${NegotiationState.CFP_RECEIVED}:${Performative.REJECT_PROPOSAL}`]: NegotiationState.REJECTED,

  // Initiator receives PROPOSE and can ACCEPT, REJECT, or COUNTER
  [`${NegotiationState.PROPOSAL_RECEIVED}:${Performative.ACCEPT_PROPOSAL}`]: NegotiationState.ACCEPTED,
  [`${NegotiationState.PROPOSAL_RECEIVED}:${Performative.REJECT_PROPOSAL}`]: NegotiationState.REJECTED,
  [`${NegotiationState.PROPOSAL_RECEIVED}:${Performative.COUNTER_OFFER}`]: NegotiationState.COUNTER_SENT,

  // Either side receives COUNTER and can ACCEPT, REJECT, or COUNTER again
  [`${NegotiationState.COUNTER_RECEIVED}:${Performative.ACCEPT_PROPOSAL}`]: NegotiationState.ACCEPTED,
  [`${NegotiationState.COUNTER_RECEIVED}:${Performative.REJECT_PROPOSAL}`]: NegotiationState.REJECTED,
  [`${NegotiationState.COUNTER_RECEIVED}:${Performative.COUNTER_OFFER}`]: NegotiationState.COUNTER_SENT,

  // CFP_SENT → receive PROPOSE, COUNTER, or REJECT from responder
  [`${NegotiationState.CFP_SENT}:receive:${Performative.PROPOSE}`]: NegotiationState.PROPOSAL_RECEIVED,
  [`${NegotiationState.CFP_SENT}:receive:${Performative.COUNTER_OFFER}`]: NegotiationState.COUNTER_RECEIVED,
  [`${NegotiationState.CFP_SENT}:receive:${Performative.REJECT_PROPOSAL}`]: NegotiationState.REJECTED,

  // PROPOSAL_SENT → receive response from initiator
  [`${NegotiationState.PROPOSAL_SENT}:receive:${Performative.ACCEPT_PROPOSAL}`]: NegotiationState.ACCEPTED,
  [`${NegotiationState.PROPOSAL_SENT}:receive:${Performative.REJECT_PROPOSAL}`]: NegotiationState.REJECTED,
  [`${NegotiationState.PROPOSAL_SENT}:receive:${Performative.COUNTER_OFFER}`]: NegotiationState.COUNTER_RECEIVED,

  // COUNTER_SENT → receive response
  [`${NegotiationState.COUNTER_SENT}:receive:${Performative.ACCEPT_PROPOSAL}`]: NegotiationState.ACCEPTED,
  [`${NegotiationState.COUNTER_SENT}:receive:${Performative.REJECT_PROPOSAL}`]: NegotiationState.REJECTED,
  [`${NegotiationState.COUNTER_SENT}:receive:${Performative.COUNTER_OFFER}`]: NegotiationState.COUNTER_RECEIVED,
};

/** Terminal states — no further transitions allowed */
const TERMINAL_STATES = new Set([
  NegotiationState.ACCEPTED,
  NegotiationState.REJECTED,
  NegotiationState.TIMED_OUT,
]);

export class NegotiationStateMachine {
  private session: NegotiationSession;

  constructor(session: NegotiationSession) {
    this.session = session;
  }

  /**
   * Attempt a state transition when we SEND a message.
   */
  transitionOnSend(performative: Performative): NegotiationState {
    this.assertNotTerminal();
    this.assertRoundLimit();

    const key = `${this.session.state}:${performative}`;
    const nextState = TRANSITION_TABLE[key];

    if (!nextState) {
      throw new InvalidTransitionError(
        this.session.state,
        performative,
        'send'
      );
    }

    this.session.state = nextState;
    this.session.currentRound++;
    this.session.updatedAt = Date.now();

    return nextState;
  }

  /**
   * Attempt a state transition when we RECEIVE a message.
   */
  transitionOnReceive(performative: Performative): NegotiationState {
    this.assertNotTerminal();

    const key = `${this.session.state}:receive:${performative}`;
    const nextState = TRANSITION_TABLE[key];

    if (!nextState) {
      throw new InvalidTransitionError(
        this.session.state,
        performative,
        'receive'
      );
    }

    this.session.state = nextState;
    this.session.updatedAt = Date.now();

    if (nextState === NegotiationState.ACCEPTED) {
      // Extract agreed terms from the last message
      const lastMsg = this.session.messages[this.session.messages.length - 1];
      if (lastMsg) {
        this.session.agreedTerms = lastMsg.content.offer;
        this.session.dealId = lastMsg.content.deal_id;
      }
    }

    return nextState;
  }

  /**
   * Force transition to TIMED_OUT state.
   */
  timeout(): void {
    if (!TERMINAL_STATES.has(this.session.state)) {
      this.session.state = NegotiationState.TIMED_OUT;
      this.session.updatedAt = Date.now();
    }
  }

  /**
   * Check if the negotiation is in a terminal state.
   */
  isTerminal(): boolean {
    return TERMINAL_STATES.has(this.session.state);
  }

  /**
   * Get valid next performatives that can be sent from current state.
   */
  getValidSendPerformatives(): Performative[] {
    if (this.isTerminal()) return [];

    const performatives: Performative[] = [];
    for (const key of Object.keys(TRANSITION_TABLE)) {
      if (key.startsWith(`${this.session.state}:`) && !key.includes(':receive:')) {
        const perf = key.split(':')[1] as Performative;
        performatives.push(perf);
      }
    }
    return performatives;
  }

  getSession(): NegotiationSession {
    return this.session;
  }

  private assertNotTerminal(): void {
    if (TERMINAL_STATES.has(this.session.state)) {
      throw new Error(
        `Negotiation is in terminal state: ${this.session.state}`
      );
    }
  }

  private assertRoundLimit(): void {
    if (this.session.currentRound >= this.session.maxRounds) {
      this.session.state = NegotiationState.TIMED_OUT;
      throw new Error(
        `Max negotiation rounds (${this.session.maxRounds}) exceeded — circuit breaker triggered`
      );
    }
  }
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly currentState: NegotiationState,
    public readonly performative: Performative,
    public readonly direction: 'send' | 'receive'
  ) {
    super(
      `Invalid ${direction} transition: state=${currentState}, performative=${performative}`
    );
    this.name = 'InvalidTransitionError';
  }
}
