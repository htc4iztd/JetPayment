/**
 * @jetpayment/core
 *
 * Shared foundation for all JetPayment protocol implementations.
 * Contains cryptographic utilities, type definitions, and policy engine.
 */

// Types
export * from './types';

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

// Policy Engine
export { PolicyEngine } from './policy/policy-engine';
