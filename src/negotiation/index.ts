/**
 * JetPayment - Phase 3: Off-chain Negotiation Layer
 *
 * Implements FIPA ACL-based structured messaging for AI agent negotiation.
 * All negotiation happens off-chain (zero gas), with a deterministic
 * state machine and gateway signature verification.
 */

export { NegotiationEngine } from './engine';
export { NegotiationStateMachine } from './state-machine';
export { MessageBuilder } from './message-builder';
