/**
 * JetPayment - Cryptographic Utilities
 *
 * Handles Ed25519↔X25519 key conversion, ECIES encryption/decryption,
 * and session token generation using audited @noble libraries.
 */

import { ed25519 } from '@noble/curves/ed25519';
import { x25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { hkdf } from '@noble/hashes/hkdf';
import { randomBytes } from '@noble/hashes/utils';
import { gcm } from '@noble/ciphers/aes';
import type { EncryptedInvitation, ConnectionInfo } from '../types';

// ============================================================
// Ed25519 → X25519 Key Conversion
// Birational equivalence: Edwards curve ↔ Montgomery curve
// ============================================================

/**
 * Convert an Ed25519 public key to X25519 (Montgomery form).
 * Uses the birational map: u = (1 + y) / (1 - y)
 *
 * This enables ECDH key exchange using Solana wallet keys which
 * are natively Ed25519 (signature-only).
 */
export function ed25519PubkeyToX25519(ed25519Pubkey: Uint8Array): Uint8Array {
  // Decode the Edwards point to get the Y coordinate
  const point = ed25519.ExtendedPoint.fromHex(ed25519Pubkey);

  // Birational map: u = (1 + y) / (1 - y) mod p
  const p = BigInt('57896044618658097711785492504343953926634992332820282019728792003956564819949');
  const y = point.ey;
  const one = BigInt(1);

  const numerator = mod(one + y, p);
  const denominator = mod(one - y, p);
  const denominatorInv = modInverse(denominator, p);
  const u = mod(numerator * denominatorInv, p);

  // Encode u as 32-byte little-endian
  return bigintToBytes32LE(u);
}

/**
 * Convert Ed25519 secret key to X25519 secret key.
 * Per RFC 7748: SHA-512 hash + clamping (clear bottom 3 bits, set bit 254).
 */
export function ed25519SecretToX25519(ed25519Secret: Uint8Array): Uint8Array {
  // Hash the 32-byte seed with SHA-512
  const seed = ed25519Secret.slice(0, 32);
  const h = sha512(seed);
  const scalar = new Uint8Array(h.slice(0, 32));

  // Clamping per RFC 7748
  scalar[0] &= 248;    // Clear bottom 3 bits
  scalar[31] &= 127;   // Clear top bit
  scalar[31] |= 64;    // Set bit 254

  return scalar;
}

// ============================================================
// ECIES (Elliptic Curve Integrated Encryption Scheme)
// Pipeline: X25519 ECDH → HKDF-SHA256 → AES-256-GCM
// ============================================================

/**
 * Encrypt connection info for a specific recipient using ECIES.
 *
 * 1. Generate ephemeral X25519 keypair
 * 2. ECDH with recipient's X25519 public key → shared secret
 * 3. HKDF-SHA256 to derive AES key
 * 4. AES-256-GCM encrypt the payload
 */
export function eciesEncrypt(
  recipientX25519Pubkey: Uint8Array,
  plaintext: Uint8Array
): EncryptedInvitation {
  // Step 1: Generate ephemeral X25519 keypair
  const ephemeralSecret = x25519.utils.randomPrivateKey();
  const ephemeralPublicKey = x25519.getPublicKey(ephemeralSecret);

  // Step 2: ECDH - compute shared secret
  const sharedSecret = x25519.getSharedSecret(ephemeralSecret, recipientX25519Pubkey);

  // Step 3: HKDF-SHA256 key derivation
  const aesKey = hkdf(sha256, sharedSecret, undefined, 'jetpayment-ecies-v1', 32);

  // Step 4: AES-256-GCM encryption with random nonce
  const nonce = randomBytes(12);
  const cipher = gcm(aesKey, nonce);
  const encrypted = cipher.encrypt(plaintext);

  // GCM appends the 16-byte auth tag to the ciphertext
  const ciphertext = encrypted.slice(0, encrypted.length - 16);
  const authTag = encrypted.slice(encrypted.length - 16);

  return {
    ciphertext,
    ephemeralPublicKey,
    nonce,
    authTag,
  };
}

/**
 * Decrypt an ECIES-encrypted invitation using recipient's X25519 secret key.
 */
export function eciesDecrypt(
  recipientX25519Secret: Uint8Array,
  invitation: EncryptedInvitation
): Uint8Array {
  // ECDH with sender's ephemeral public key
  const sharedSecret = x25519.getSharedSecret(
    recipientX25519Secret,
    invitation.ephemeralPublicKey
  );

  // Derive the same AES key
  const aesKey = hkdf(sha256, sharedSecret, undefined, 'jetpayment-ecies-v1', 32);

  // Reconstruct ciphertext + auth tag for GCM
  const encryptedWithTag = new Uint8Array(
    invitation.ciphertext.length + invitation.authTag.length
  );
  encryptedWithTag.set(invitation.ciphertext);
  encryptedWithTag.set(invitation.authTag, invitation.ciphertext.length);

  // Decrypt
  const cipher = gcm(aesKey, invitation.nonce);
  return cipher.decrypt(encryptedWithTag);
}

// ============================================================
// Session Token Generation
// ============================================================

/**
 * Generate a cryptographically secure one-time session token.
 * Used for first-packet inspection to filter unauthorized connections.
 */
export function generateSessionToken(): string {
  const bytes = randomBytes(32);
  return bytesToHex(bytes);
}

// ============================================================
// Signing & Verification Utilities
// ============================================================

/**
 * Sign a message with an Ed25519 secret key (Solana wallet).
 */
export function ed25519Sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return ed25519.sign(message, secretKey.slice(0, 32));
}

/**
 * Verify an Ed25519 signature.
 */
export function ed25519Verify(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array
): boolean {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

/**
 * Compute SHA-256 hash of arbitrary data.
 */
export function sha256Hash(data: Uint8Array): Uint8Array {
  return sha256(data);
}

/**
 * Sign the Noise static key with Solana wallet for mTLS-like identity binding.
 * Format: "noise-libp2p-static-key:" + noise_static_pubkey
 */
export function signNoiseStaticKey(
  noiseStaticPubkey: Uint8Array,
  solanaSecretKey: Uint8Array
): Uint8Array {
  const prefix = new TextEncoder().encode('noise-libp2p-static-key:');
  const payload = new Uint8Array(prefix.length + noiseStaticPubkey.length);
  payload.set(prefix);
  payload.set(noiseStaticPubkey, prefix.length);
  return ed25519Sign(payload, solanaSecretKey);
}

/**
 * Verify a Noise static key signature against a Solana public key.
 */
export function verifyNoiseStaticKey(
  noiseStaticPubkey: Uint8Array,
  signature: Uint8Array,
  solanaPubkey: Uint8Array
): boolean {
  const prefix = new TextEncoder().encode('noise-libp2p-static-key:');
  const payload = new Uint8Array(prefix.length + noiseStaticPubkey.length);
  payload.set(prefix);
  payload.set(noiseStaticPubkey, prefix.length);
  return ed25519Verify(signature, payload, solanaPubkey);
}

// ============================================================
// Math Helpers
// ============================================================

function mod(a: bigint, m: bigint): bigint {
  return ((a % m) + m) % m;
}

function modInverse(a: bigint, m: bigint): bigint {
  // Extended Euclidean Algorithm
  let [old_r, r] = [a, m];
  let [old_s, s] = [BigInt(1), BigInt(0)];

  while (r !== BigInt(0)) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }

  return mod(old_s, m);
}

function bigintToBytes32LE(n: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let val = n;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(val & BigInt(0xff));
    val >>= BigInt(8);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}
