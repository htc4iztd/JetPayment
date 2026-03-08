/**
 * JetPayment
 *
 * Open-source gateway for autonomous AI agent payments.
 *
 * Architecture:
 *   Phase 1: Discovery    — Pluggable signaling with ECIES-encrypted invitations
 *   Phase 2: Secure P2P   — Libp2p Noise XX with session token verification
 *   Phase 3: Negotiation  — FIPA ACL off-chain structured messaging (zero gas)
 *   Phase 4: Settlement   — Solana Anchor PDA escrow with atomic swap
 *
 * The gateway enforces Defense-in-Depth policies: the AI agent (LLM)
 * is treated as an untrusted requester and cannot directly access
 * private keys or execute on-chain transactions.
 */

// Core Gateway
export { JetPaymentGateway, type JetPaymentConfig } from './gateway/gateway';
export { PolicyEngine } from './gateway/policy-engine';

// Discovery Layer
export {
  BaseDiscoveryProvider,
  MoltbookDiscoveryProvider,
  DiscoveryService, // backward-compatible alias
  type MoltbookConfig,
  type IDiscoveryService,
} from './discovery';

// Secure P2P Layer
export { P2PService, type P2PConfig } from './p2p';

// Negotiation Layer
export { NegotiationEngine } from './negotiation/engine';
export { NegotiationStateMachine, InvalidTransitionError } from './negotiation/state-machine';
export { MessageBuilder } from './negotiation/message-builder';

// Settlement Layer
export { SettlementService, type SettlementConfig } from './settlement';

// Cryptographic Utilities
export {
  ed25519PubkeyToX25519,
  ed25519SecretToX25519,
  eciesEncrypt,
  eciesDecrypt,
  generateSessionToken,
  ed25519Sign,
  ed25519Verify,
  sha256Hash,
  signNoiseStaticKey,
  verifyNoiseStaticKey,
  bytesToHex,
  hexToBytes,
} from './crypto';

// Types
export * from './types';
