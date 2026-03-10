/**
 * JetPayment - Discovery Layer
 *
 * Provides:
 * - BaseDiscoveryProvider: transport-agnostic base class with ECIES crypto
 * - MoltbookDiscoveryProvider: Moltbook SNS signaling implementation
 * - DiscoveryService: backward-compatible alias for MoltbookDiscoveryProvider
 */

import { BaseDiscoveryProvider } from './base';
import type { EncryptedInvitation } from '@jetpayment/core';

// Re-export base class and types for external use
export { BaseDiscoveryProvider } from './base';
export type { IDiscoveryService, DiscoveryProviderConfig } from '@jetpayment/core';

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
 * MoltbookDiscoveryProvider uses the Moltbook SNS as a signaling layer.
 *
 * Encrypted invitations are posted as Moltbook posts mentioning the target
 * agent, and incoming invitations are detected by polling the mentions API.
 */
export class MoltbookDiscoveryProvider extends BaseDiscoveryProvider {
  private config: MoltbookConfig;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private processedMessages: Set<string> = new Set();

  constructor(
    config: MoltbookConfig,
    solanaPubkey: Uint8Array,
    solanaSecret: Uint8Array
  ) {
    super(solanaPubkey, solanaSecret);
    this.config = config;
  }

  /**
   * Publish an encrypted invitation as a Moltbook post mentioning the target.
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
}

/**
 * Backward-compatible alias.
 * @deprecated Use MoltbookDiscoveryProvider directly or implement IDiscoveryService.
 */
export const DiscoveryService = MoltbookDiscoveryProvider;
export type DiscoveryService = MoltbookDiscoveryProvider;
