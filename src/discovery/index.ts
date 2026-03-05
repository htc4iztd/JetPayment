/**
 * JetPayment - Phase 1: Discovery Layer
 *
 * Handles Moltbook-based signaling: creating encrypted invitations,
 * ephemeral port allocation, and invitation parsing.
 *
 * The Discovery phase uses the public Moltbook SNS purely as a
 * "signaling layer" — encrypted invitations ensure only the intended
 * recipient can decode the P2P connection details.
 */

import { EventEmitter } from 'events';
import {
  eciesEncrypt,
  eciesDecrypt,
  ed25519PubkeyToX25519,
  ed25519SecretToX25519,
  generateSessionToken,
  bytesToHex,
  hexToBytes,
} from '../crypto';
import type { ConnectionInfo, EncryptedInvitation } from '../types';

/** Configuration for the Moltbook API client */
export interface MoltbookConfig {
  /** Moltbook API base URL */
  apiBaseUrl: string;
  /** Agent's Moltbook handle/ID */
  agentHandle: string;
  /** API authentication token */
  apiToken: string;
  /** Polling interval in ms for mention detection */
  pollIntervalMs: number;
}

/**
 * DiscoveryService manages the first phase of the JetPayment protocol:
 * publishing encrypted invitations and detecting incoming invitations
 * on the Moltbook platform.
 */
export class DiscoveryService extends EventEmitter {
  private config: MoltbookConfig;
  private solanaPubkey: Uint8Array;
  private solanaSecret: Uint8Array;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private processedMessages: Set<string> = new Set();

  constructor(
    config: MoltbookConfig,
    solanaPubkey: Uint8Array,
    solanaSecret: Uint8Array
  ) {
    super();
    this.config = config;
    this.solanaPubkey = solanaPubkey;
    this.solanaSecret = solanaSecret;
  }

  /**
   * Create an encrypted invitation for a target agent.
   *
   * Steps:
   * 1. Generate ephemeral port / multiaddr for Libp2p
   * 2. Generate one-time session token (CSPRNG)
   * 3. Convert target's Ed25519 pubkey → X25519
   * 4. ECIES encrypt the connection info
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
   * Serialize an invitation to a Moltbook-postable format (base64).
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
   * Deserialize a Moltbook message back into an EncryptedInvitation.
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

  /**
   * Publish an encrypted invitation as a Moltbook post mentioning the target.
   * In production, this calls the Moltbook API. Here we define the interface.
   */
  async publishInvitation(
    targetHandle: string,
    invitation: EncryptedInvitation
  ): Promise<string> {
    const serialized = this.serializeInvitation(invitation);
    const postBody = {
      content: `@${targetHandle} 🔐 ${serialized}`,
      type: 'jetpayment_invitation',
      metadata: {
        protocol: 'jetpayment',
        version: '1.0.0',
      },
    };

    // Moltbook API call
    const response = await fetch(`${this.config.apiBaseUrl}/api/v1/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiToken}`,
      },
      body: JSON.stringify(postBody),
    });

    if (!response.ok) {
      throw new Error(`Moltbook API error: ${response.status} ${response.statusText}`);
    }

    const result = (await response.json()) as { id: string };
    return result.id;
  }

  /**
   * Start polling Moltbook for incoming mentions/invitations.
   */
  startPolling(): void {
    if (this.pollingTimer) return;

    this.pollingTimer = setInterval(async () => {
      try {
        await this.checkMentions();
      } catch (err) {
        this.emit('error', err);
      }
    }, this.config.pollIntervalMs);

    this.emit('polling_started');
  }

  /**
   * Stop polling for mentions.
   */
  stopPolling(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
      this.emit('polling_stopped');
    }
  }

  /**
   * Check Moltbook for new mentions containing JetPayment invitations.
   */
  private async checkMentions(): Promise<void> {
    const response = await fetch(
      `${this.config.apiBaseUrl}/api/v1/mentions?handle=${this.config.agentHandle}&type=jetpayment_invitation`,
      {
        headers: {
          Authorization: `Bearer ${this.config.apiToken}`,
        },
      }
    );

    if (!response.ok) return;

    const mentions = (await response.json()) as Array<{
      id: string;
      content: string;
      author: string;
    }>;

    for (const mention of mentions) {
      if (this.processedMessages.has(mention.id)) continue;
      this.processedMessages.add(mention.id);

      try {
        // Extract the base64 payload from the post
        const match = mention.content.match(/🔐\s+(\S+)/);
        if (!match) continue;

        const invitation = this.deserializeInvitation(match[1]);
        const connectionInfo = this.decryptInvitation(invitation);

        this.emit('invitation_received', {
          messageId: mention.id,
          author: mention.author,
          connectionInfo,
        });
      } catch (err) {
        // Invitation was not for us, or corrupted — silently skip
        this.emit('invitation_decrypt_failed', {
          messageId: mention.id,
          error: err,
        });
      }
    }
  }

  destroy(): void {
    this.stopPolling();
    this.removeAllListeners();
  }
}
