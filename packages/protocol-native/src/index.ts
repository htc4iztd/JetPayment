/**
 * @jetpayment/protocol-native
 *
 * JetPayment's native protocol implementation:
 *   Discovery:   Moltbook SNS signaling (pluggable via IDiscoveryService)
 *   Transport:   Libp2p Noise XX with session token verification
 *   Negotiation: FIPA ACL off-chain structured messaging
 *   Settlement:  Solana Anchor PDA escrow with atomic swap
 */

// Re-export core for convenience
export * from '@jetpayment/core';

// Gateway
export { JetPaymentGateway, type JetPaymentConfig } from './gateway/gateway';

// Discovery Layer
export {
  BaseDiscoveryProvider,
  MoltbookDiscoveryProvider,
  DiscoveryService,
  type MoltbookConfig,
} from './discovery';

// P2P Layer
export { P2PService, type P2PConfig } from './p2p';

// Negotiation Layer
export { NegotiationEngine } from './negotiation/engine';
export { NegotiationStateMachine, InvalidTransitionError } from './negotiation/state-machine';
export { MessageBuilder } from './negotiation/message-builder';

// Settlement Layer
export { SettlementService, type SettlementConfig } from './settlement';
