/**
 * Tests for JetPayment Cryptographic Utilities
 *
 * Covers: Ed25519→X25519 conversion, ECIES encrypt/decrypt,
 * session token generation, and signing/verification.
 */

import {
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
} from '../src/crypto';
import { ed25519 } from '@noble/curves/ed25519';

describe('Crypto Utilities', () => {
  // Generate a test Ed25519 keypair (simulating a Solana wallet)
  const secretKey = ed25519.utils.randomPrivateKey();
  const publicKey = ed25519.getPublicKey(secretKey);

  describe('Ed25519 → X25519 Key Conversion', () => {
    it('should convert Ed25519 public key to X25519', () => {
      const x25519Pub = ed25519PubkeyToX25519(publicKey);
      expect(x25519Pub).toBeInstanceOf(Uint8Array);
      expect(x25519Pub.length).toBe(32);
    });

    it('should convert Ed25519 secret key to X25519', () => {
      const x25519Sec = ed25519SecretToX25519(secretKey);
      expect(x25519Sec).toBeInstanceOf(Uint8Array);
      expect(x25519Sec.length).toBe(32);

      // Verify clamping: lowest 3 bits should be 0
      expect(x25519Sec[0] & 7).toBe(0);
      // Bit 254 should be set
      expect(x25519Sec[31] & 64).toBe(64);
      // Top bit should be clear
      expect(x25519Sec[31] & 128).toBe(0);
    });

    it('should produce deterministic output for same input', () => {
      const x1 = ed25519PubkeyToX25519(publicKey);
      const x2 = ed25519PubkeyToX25519(publicKey);
      expect(bytesToHex(x1)).toBe(bytesToHex(x2));
    });
  });

  describe('ECIES Encrypt / Decrypt', () => {
    it('should encrypt and decrypt a round-trip message', () => {
      const recipientSecret = ed25519.utils.randomPrivateKey();
      const recipientPublic = ed25519.getPublicKey(recipientSecret);

      const recipientX25519Pub = ed25519PubkeyToX25519(recipientPublic);
      const recipientX25519Sec = ed25519SecretToX25519(recipientSecret);

      const plaintext = new TextEncoder().encode(
        JSON.stringify({
          multiaddr: '/ip4/192.168.1.1/tcp/50775/p2p/QmTest123',
          sessionToken: 'abc123',
        })
      );

      const encrypted = eciesEncrypt(recipientX25519Pub, plaintext);

      expect(encrypted.ciphertext.length).toBeGreaterThan(0);
      expect(encrypted.ephemeralPublicKey.length).toBe(32);
      expect(encrypted.nonce.length).toBe(12);
      expect(encrypted.authTag.length).toBe(16);

      const decrypted = eciesDecrypt(recipientX25519Sec, encrypted);
      expect(new TextDecoder().decode(decrypted)).toBe(
        new TextDecoder().decode(plaintext)
      );
    });

    it('should fail to decrypt with wrong key', () => {
      const recipientSecret = ed25519.utils.randomPrivateKey();
      const recipientPublic = ed25519.getPublicKey(recipientSecret);
      const recipientX25519Pub = ed25519PubkeyToX25519(recipientPublic);

      const wrongSecret = ed25519.utils.randomPrivateKey();
      const wrongX25519Sec = ed25519SecretToX25519(wrongSecret);

      const plaintext = new TextEncoder().encode('secret data');
      const encrypted = eciesEncrypt(recipientX25519Pub, plaintext);

      expect(() => eciesDecrypt(wrongX25519Sec, encrypted)).toThrow();
    });
  });

  describe('Session Token Generation', () => {
    it('should generate a 64-character hex token', () => {
      const token = generateSessionToken();
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should generate unique tokens', () => {
      const t1 = generateSessionToken();
      const t2 = generateSessionToken();
      expect(t1).not.toBe(t2);
    });
  });

  describe('Ed25519 Signing / Verification', () => {
    it('should sign and verify a message', () => {
      const message = new TextEncoder().encode('test message');
      const signature = ed25519Sign(message, secretKey);

      expect(signature.length).toBe(64);
      expect(ed25519Verify(signature, message, publicKey)).toBe(true);
    });

    it('should reject tampered message', () => {
      const message = new TextEncoder().encode('original');
      const signature = ed25519Sign(message, secretKey);

      const tampered = new TextEncoder().encode('modified');
      expect(ed25519Verify(signature, tampered, publicKey)).toBe(false);
    });

    it('should reject wrong public key', () => {
      const message = new TextEncoder().encode('test');
      const signature = ed25519Sign(message, secretKey);

      const otherPublicKey = ed25519.getPublicKey(
        ed25519.utils.randomPrivateKey()
      );
      expect(ed25519Verify(signature, message, otherPublicKey)).toBe(false);
    });
  });

  describe('Noise Static Key Signing (mTLS-like)', () => {
    it('should sign and verify noise static key binding', () => {
      const noiseStaticPubkey = new Uint8Array(32).fill(0xab);

      const signature = signNoiseStaticKey(noiseStaticPubkey, secretKey);
      expect(signature.length).toBe(64);

      const valid = verifyNoiseStaticKey(noiseStaticPubkey, signature, publicKey);
      expect(valid).toBe(true);
    });

    it('should reject mismatched noise key', () => {
      const noiseKey1 = new Uint8Array(32).fill(0xab);
      const noiseKey2 = new Uint8Array(32).fill(0xcd);

      const signature = signNoiseStaticKey(noiseKey1, secretKey);
      expect(verifyNoiseStaticKey(noiseKey2, signature, publicKey)).toBe(false);
    });
  });

  describe('SHA-256 Hash', () => {
    it('should produce consistent 32-byte hashes', () => {
      const data = new TextEncoder().encode('hello world');
      const hash1 = sha256Hash(data);
      const hash2 = sha256Hash(data);

      expect(hash1.length).toBe(32);
      expect(bytesToHex(hash1)).toBe(bytesToHex(hash2));
    });
  });

  describe('Hex Encoding', () => {
    it('should round-trip bytes through hex', () => {
      const original = new Uint8Array([0, 1, 127, 128, 255]);
      const hex = bytesToHex(original);
      const decoded = hexToBytes(hex);
      expect(Array.from(decoded)).toEqual(Array.from(original));
    });
  });
});
