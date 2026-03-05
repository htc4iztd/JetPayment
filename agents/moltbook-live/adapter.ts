/**
 * JetPayment - Moltbook Live Discovery Adapter
 *
 * Bridges the JetPayment Discovery protocol to the real Moltbook API.
 *
 * Key adaptations from the original DiscoveryService design:
 *
 *   Original assumption          →  Real Moltbook API
 *   ─────────────────────────────────────────────────────
 *   POST /api/v1/posts           →  POST /posts (to submolt)
 *   GET /api/v1/mentions         →  GET /posts?submolt=jetpayment&sort=new
 *   type: jetpayment_invitation  →  🔐 prefix in post body
 *   @handle mention              →  @agent_name in post title
 *   30min post rate limit        →  Comment-based fallback
 *
 * Strategy for invitation delivery:
 *
 *   PRIMARY: Post to s/jetpayment submolt
 *     Title: "🔐 @target-agent"
 *     Body:  Base64-encoded ECIES invitation
 *
 *   FALLBACK (rate-limited): Comment on target's latest post
 *     Body:  "🔐 <base64 invitation>"
 *
 *   POLLING: Fetch new posts from s/jetpayment, filter for @our-name
 */

import { EventEmitter } from 'events';
import {
  MoltbookClient,
  MoltbookRateLimitError,
  type MoltbookLiveConfig,
  type MoltbookPost,
} from './client';
import {
  eciesEncrypt,
  eciesDecrypt,
  ed25519PubkeyToX25519,
  ed25519SecretToX25519,
  generateSessionToken,
  bytesToHex,
  hexToBytes,
} from '../../src/crypto';
import type { ConnectionInfo, EncryptedInvitation } from '../../src/types';

// ============================================================
// Adapter
// ============================================================

export interface LiveDiscoveryConfig extends MoltbookLiveConfig {
  /** Polling interval in ms for checking new invitations */
  pollIntervalMs?: number;
  /** Submolt for JetPayment invitations */
  submolt?: string;
}

export class MoltbookDiscoveryAdapter extends EventEmitter {
  private client: MoltbookClient;
  private config: LiveDiscoveryConfig;
  private solanaPubkey: Uint8Array;
  private solanaSecret: Uint8Array;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private processedPostIds: Set<string> = new Set();
  private lastPollTime: number = 0;

  constructor(
    config: LiveDiscoveryConfig,
    solanaPubkey: Uint8Array,
    solanaSecret: Uint8Array
  ) {
    super();
    this.config = config;
    this.solanaPubkey = solanaPubkey;
    this.solanaSecret = solanaSecret;
    this.client = new MoltbookClient(config);
  }

  /**
   * Get the underlying MoltbookClient for direct API access.
   */
  getClient(): MoltbookClient {
    return this.client;
  }

  // ============================================================
  // Invitation Creation (same crypto as original DiscoveryService)
  // ============================================================

  /**
   * Create an ECIES-encrypted invitation for a target agent.
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
      ttlSeconds: 300,
    };

    const plaintext = new TextEncoder().encode(JSON.stringify(connectionInfo));
    const targetX25519Pubkey = ed25519PubkeyToX25519(targetSolanaPubkey);
    const invitation = eciesEncrypt(targetX25519Pubkey, plaintext);

    return { invitation, connectionInfo };
  }

  /**
   * Decrypt a received invitation.
   */
  decryptInvitation(invitation: EncryptedInvitation): ConnectionInfo {
    const x25519Secret = ed25519SecretToX25519(this.solanaSecret);
    const plaintext = eciesDecrypt(x25519Secret, invitation);
    const json = new TextDecoder().decode(plaintext);
    const connectionInfo: ConnectionInfo = JSON.parse(json);

    const elapsed = (Date.now() - connectionInfo.createdAt) / 1000;
    if (elapsed > connectionInfo.ttlSeconds) {
      throw new Error(
        `Invitation expired: ${elapsed.toFixed(0)}s elapsed, TTL=${connectionInfo.ttlSeconds}s`
      );
    }

    return connectionInfo;
  }

  // ============================================================
  // Serialization (same format as original)
  // ============================================================

  serializeInvitation(invitation: EncryptedInvitation): string {
    const payload = {
      c: Buffer.from(invitation.ciphertext).toString('base64'),
      e: Buffer.from(invitation.ephemeralPublicKey).toString('base64'),
      n: Buffer.from(invitation.nonce).toString('base64'),
      t: Buffer.from(invitation.authTag).toString('base64'),
      v: 1,
    };
    return Buffer.from(JSON.stringify(payload)).toString('base64');
  }

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

  // ============================================================
  // Publishing — Real Moltbook API
  // ============================================================

  /**
   * Publish an encrypted invitation to Moltbook.
   *
   * Posts to the s/jetpayment submolt with the target's name in the title.
   * Falls back to commenting on the target's latest post if rate-limited.
   */
  async publishInvitation(
    targetAgentName: string,
    invitation: EncryptedInvitation
  ): Promise<{ postId: string; method: 'post' | 'comment' }> {
    const serialized = this.serializeInvitation(invitation);

    // Try primary method: post to s/jetpayment
    if (this.client.canPost()) {
      try {
        const post = await this.client.createPost(
          `🔐 @${targetAgentName}`,
          serialized,
          this.config.submolt || 'jetpayment'
        );
        this.log(
          `Published invitation as post ${post.id} to s/${this.config.submolt || 'jetpayment'}`
        );
        return { postId: post.id, method: 'post' };
      } catch (err) {
        if (!(err instanceof MoltbookRateLimitError)) throw err;
        this.log(`Post rate limited, falling back to comment method`);
      }
    }

    // Fallback: search for target agent's latest post and comment on it
    const searchResult = await this.client.search(targetAgentName, 5);
    const targetPost = searchResult.posts.find(
      (p) => p.author === targetAgentName
    );

    if (!targetPost) {
      const wait = this.client.secondsUntilCanPost();
      throw new Error(
        `Cannot deliver invitation: post rate-limited (${wait}s remaining) and no posts from @${targetAgentName} found for comment fallback.`
      );
    }

    const comment = await this.client.addComment(
      targetPost.id,
      `🔐 ${serialized}`
    );
    this.log(
      `Published invitation as comment ${comment.id} on post ${targetPost.id}`
    );
    return { postId: comment.id, method: 'comment' };
  }

  // ============================================================
  // Polling — Check for incoming invitations
  // ============================================================

  /**
   * Start polling s/jetpayment for posts mentioning our agent name.
   */
  startPolling(): void {
    if (this.pollingTimer) return;

    const interval = this.config.pollIntervalMs || 5000;
    this.log(`Polling s/${this.config.submolt || 'jetpayment'} every ${interval}ms`);

    // Initial check
    this.pollForInvitations().catch((err) => this.emit('error', err));

    this.pollingTimer = setInterval(async () => {
      try {
        await this.pollForInvitations();
      } catch (err) {
        this.emit('error', err);
      }
    }, interval);

    this.emit('polling_started');
  }

  stopPolling(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
      this.emit('polling_stopped');
    }
  }

  /**
   * Poll for new invitation posts on Moltbook.
   *
   * Checks two sources:
   * 1. New posts in s/jetpayment containing @our-name
   * 2. Search results for our agent name with 🔐 prefix
   */
  private async pollForInvitations(): Promise<void> {
    const myName = this.config.agentName;

    // Method 1: Fetch latest posts from the jetpayment submolt
    try {
      const posts = await this.client.getPosts({
        submolt: this.config.submolt || 'jetpayment',
        sort: 'new',
        limit: 25,
      });

      for (const post of posts) {
        await this.processPost(post, myName);
      }
    } catch (err) {
      // submolt may not exist yet — fall through to search
      this.emit('poll_error', { source: 'submolt', error: err });
    }

    // Method 2: Search for our name (catches comments too)
    try {
      const results = await this.client.search(`🔐 @${myName}`, 10);
      for (const post of results.posts) {
        await this.processPost(post, myName);
      }
    } catch (err) {
      this.emit('poll_error', { source: 'search', error: err });
    }

    this.lastPollTime = Date.now();
  }

  /**
   * Process a Moltbook post, checking if it contains an invitation for us.
   */
  private async processPost(post: MoltbookPost, myName: string): Promise<void> {
    if (this.processedPostIds.has(post.id)) return;
    // Skip our own posts
    if (post.author === myName) return;

    // Check if the post mentions us (in title or body)
    const mentionsUs =
      post.title.includes(`@${myName}`) ||
      (post.body && post.body.includes(`@${myName}`));

    // Check for invitation marker
    const hasInvitation =
      post.title.includes('🔐') ||
      (post.body && post.body.includes('🔐'));

    if (!mentionsUs && !hasInvitation) return;

    this.processedPostIds.add(post.id);

    // Extract the base64 payload
    // Could be in body (post method) or in title
    const content = post.body || post.title;
    const invitationData = this.extractInvitationPayload(content);

    if (!invitationData) {
      // Check comments on this post for invitation data
      try {
        const comments = await this.client.getComments(post.id, 'new');
        for (const comment of comments) {
          if (this.processedPostIds.has(`comment-${comment.id}`)) continue;
          this.processedPostIds.add(`comment-${comment.id}`);

          const commentData = this.extractInvitationPayload(comment.body);
          if (commentData) {
            await this.handleInvitationPayload(commentData, post.author, post.id);
          }
        }
      } catch {
        // Ignore comment fetch errors
      }
      return;
    }

    await this.handleInvitationPayload(invitationData, post.author, post.id);
  }

  /**
   * Extract base64-encoded invitation from post content.
   */
  private extractInvitationPayload(content: string): string | null {
    // Pattern 1: "🔐 <base64>" (post body is purely the invitation)
    const match = content.match(/🔐\s*(\S+)/);
    if (match) return match[1];

    // Pattern 2: Body is purely base64 (no 🔐 prefix, title had the marker)
    if (/^[A-Za-z0-9+/=]+$/.test(content.trim()) && content.trim().length > 50) {
      return content.trim();
    }

    return null;
  }

  /**
   * Attempt to decrypt an invitation payload and emit event on success.
   */
  private async handleInvitationPayload(
    payload: string,
    author: string,
    postId: string
  ): Promise<void> {
    try {
      const invitation = this.deserializeInvitation(payload);
      const connectionInfo = this.decryptInvitation(invitation);

      this.log(
        `Decrypted invitation from @${author} (post ${postId}): ` +
        `multiaddr=${connectionInfo.multiaddr.slice(0, 30)}...`
      );

      this.emit('invitation_received', {
        messageId: postId,
        author,
        connectionInfo,
      });
    } catch (err) {
      // Invitation was not for us (wrong key) or corrupted — silently skip
      this.emit('invitation_decrypt_failed', {
        messageId: postId,
        author,
        error: err,
      });
    }
  }

  // ============================================================
  // Setup Helpers
  // ============================================================

  /**
   * Ensure the JetPayment submolt exists. Creates it if not found.
   */
  async ensureSubmoltExists(): Promise<void> {
    const submoltName = this.config.submolt || 'jetpayment';
    try {
      await this.client.subscribe(submoltName);
      this.log(`Subscribed to s/${submoltName}`);
    } catch {
      try {
        await this.client.createSubmolt(
          submoltName,
          'JetPayment: Autonomous AI agent payment protocol. ' +
          'Encrypted invitations for P2P negotiation and Solana settlement.'
        );
        await this.client.subscribe(submoltName);
        this.log(`Created and subscribed to s/${submoltName}`);
      } catch (err) {
        this.log(`s/${submoltName} may already exist, continuing`);
      }
    }
  }

  /**
   * Verify that the API key works by fetching our profile.
   */
  async verifyConnection(): Promise<MoltbookPost | null> {
    try {
      const me = await this.client.getMe();
      this.log(`Connected as @${(me as any).name || this.config.agentName}`);
      return null;
    } catch (err) {
      throw new Error(
        `Moltbook connection failed: ${err}. Check your API key.`
      );
    }
  }

  // ============================================================
  // Lifecycle
  // ============================================================

  destroy(): void {
    this.stopPolling();
    this.processedPostIds.clear();
    this.removeAllListeners();
  }

  private log(message: string): void {
    const time = new Date().toISOString().slice(11, 23);
    console.log(`\x1b[90m[${time}] [Moltbook-Live]\x1b[0m ${message}`);
  }
}
