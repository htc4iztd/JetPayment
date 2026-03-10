/**
 * JetPayment - Base Discovery Provider
 *
 * Contains transport-agnostic cryptographic operations shared across
 * all discovery providers (ECIES encryption, invitation serialization).
 *
 * Concrete providers (Moltbook, Webhook, DHT, etc.) extend this class
 * and implement the transport-specific publishInvitation() and polling logic.
 */

import { EventEmitter } from 'events';
import {
  eciesEncrypt,
  eciesDecrypt,
  ed25519PubkeyToX25519,
  ed25519SecretToX25519,
  generateSessionToken,
  bytesToHex,
} from '@jetpayment/core';
import type {
  IDiscoveryService,
  ConnectionInfo,
  EncryptedInvitation,
} from '@jetpayment/core';

/**
 * BaseDiscoveryProvider implements the cryptographic core of Discovery:
 * - ECIES invitation encryption/decryption
 * - Serialization/deserialization
 * - TTL validation
 *
 * Subclasses must implement:
 * - publishInvitation(): post the invitation to a signaling channel
 * - startPolling() / stopPolling(): listen for incoming invitations
 */
export abstract class BaseDiscoveryProvider
  extends EventEmitter
  implements IDiscoveryService
{
  protected solanaPubkey: Uint8Array;
  protected solanaSecret: Uint8Array;

  constructor(solanaPubkey: Uint8Array, solanaSecret: Uint8Array) {
    super();
    this.solanaPubkey = solanaPubkey;
    this.solanaSecret = solanaSecret;
  }

  /**
   * Create an encrypted invitation for a target agent.
   *
   * Steps:
   * 1. Generate one-time session token (CSPRNG)
   * 2. Convert target's Ed25519 pubkey → X25519
   * 3. ECIES encrypt the connection info
   */
  createInvitation(
    targetSolanaPubkey: Uint8Array,
    multiaddr: string
  ): { invitation: EncryptedInvitation; connectionInfo: ConnectionInfo } {
    const sessionToken = generateSessionToken();
    const now = Date.now();

    const connectionInfo: ConnectionInfo = {
      multiaddr,
      sessionToken,
      initiatorPubkey: bytesToHex(this.solanaPubkey),
      createdAt: now,
      ttlSeconds: 300, // 5 minute TTL
    };

    // Serialize connection info to JSON
    const plaintext = new TextEncoder().encode(JSON.stringify(connectionInfo));

    // Convert target's Ed25519 public key to X25519 for ECDH
    const targetX25519Pubkey = ed25519PubkeyToX25519(targetSolanaPubkey);

    // ECIES encrypt
    const invitation = eciesEncrypt(targetX25519Pubkey, plaintext);

    return { invitation, connectionInfo };
  }

  /**
   * Decrypt a received invitation using our Solana secret key.
   */
  decryptInvitation(invitation: EncryptedInvitation): ConnectionInfo {
    // Convert our Ed25519 secret to X25519
    const x25519Secret = ed25519SecretToX25519(this.solanaSecret);

    // ECIES decrypt
    const plaintext = eciesDecrypt(x25519Secret, invitation);
    const json = new TextDecoder().decode(plaintext);
    const connectionInfo: ConnectionInfo = JSON.parse(json);

    // Validate TTL
    const elapsed = (Date.now() - connectionInfo.createdAt) / 1000;
    if (elapsed > connectionInfo.ttlSeconds) {
      throw new Error(
        `Invitation expired: ${elapsed.toFixed(0)}s elapsed, TTL=${connectionInfo.ttlSeconds}s`
      );
    }

    return connectionInfo;
  }

  /**
   * Serialize an invitation to a transport-safe format (base64).
   */
  serializeInvitation(invitation: EncryptedInvitation): string {
    const payload = {
      c: Buffer.from(invitation.ciphertext).toString('base64'),
      e: Buffer.from(invitation.ephemeralPublicKey).toString('base64'),
      n: Buffer.from(invitation.nonce).toString('base64'),
      t: Buffer.from(invitation.authTag).toString('base64'),
      v: 1, // Protocol version
    };
    return Buffer.from(JSON.stringify(payload)).toString('base64');
  }

  /**
   * Deserialize a transport string back into an EncryptedInvitation.
   */
  deserializeInvitation(encoded: string): EncryptedInvitation {
    const json = Buffer.from(encoded, 'base64').toString('utf-8');
    const payload = JSON.parse(json);

    if (payload.v !== 1) {
      throw new Error(`Unsupported invitation protocol version: ${payload.v}`);
    }

    return {
      ciphertext: Uint8Array.from(Buffer.from(payload.c, 'base64')),
      ephemeralPublicKey: Uint8Array.from(Buffer.from(payload.e, 'base64')),
      nonce: Uint8Array.from(Buffer.from(payload.n, 'base64')),
      authTag: Uint8Array.from(Buffer.from(payload.t, 'base64')),
    };
  }

  /** Publish an invitation via the provider's signaling channel. */
  abstract publishInvitation(
    targetHandle: string,
    invitation: EncryptedInvitation
  ): Promise<string>;

  /** Start listening for incoming invitations. */
  abstract startPolling(): void;

  /** Stop listening for incoming invitations. */
  abstract stopPolling(): void;

  destroy(): void {
    this.stopPolling();
    this.removeAllListeners();
  }
}
