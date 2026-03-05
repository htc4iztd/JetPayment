/**
 * JetPayment - Moltbook Live API Client
 *
 * Typed client for the real Moltbook API (https://www.moltbook.com/api/v1).
 * Handles authentication, rate limiting, and all endpoints needed
 * for JetPayment's Discovery phase.
 *
 * Moltbook API reference: https://github.com/moltbook/api
 */

// ============================================================
// Types
// ============================================================

export interface MoltbookAgent {
  name: string;
  description?: string;
  api_key?: string;
  claim_url?: string;
  verification_code?: string;
}

export interface MoltbookPost {
  id: string;
  title: string;
  body?: string;
  url?: string;
  author: string;
  submolt: string;
  score: number;
  comment_count: number;
  created_at: string;
}

export interface MoltbookComment {
  id: string;
  body: string;
  author: string;
  post_id: string;
  parent_id?: string;
  score: number;
  created_at: string;
}

export interface MoltbookSubmolt {
  name: string;
  description: string;
  subscriber_count: number;
}

export interface MoltbookSearchResult {
  posts: MoltbookPost[];
  agents: MoltbookAgent[];
  communities: MoltbookSubmolt[];
}

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  resetAt: number; // Unix timestamp
}

export interface MoltbookLiveConfig {
  /** API key (moltbook_xxx format) */
  apiKey: string;
  /** Agent name on Moltbook */
  agentName: string;
  /** Base URL — defaults to https://www.moltbook.com/api/v1 */
  baseUrl?: string;
  /** Submolt to post invitations to — defaults to "jetpayment" */
  submolt?: string;
}

// ============================================================
// Client
// ============================================================

const DEFAULT_BASE_URL = 'https://www.moltbook.com/api/v1';
const DEFAULT_SUBMOLT = 'jetpayment';

export class MoltbookClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly agentName: string;
  private readonly submolt: string;
  private rateLimit: RateLimitInfo = { limit: 100, remaining: 100, resetAt: 0 };
  private postRateLimit: RateLimitInfo = { limit: 1, remaining: 1, resetAt: 0 };

  constructor(config: MoltbookLiveConfig) {
    this.apiKey = config.apiKey;
    this.agentName = config.agentName;
    this.baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    this.submolt = config.submolt || DEFAULT_SUBMOLT;
  }

  // ── Agent Management ──────────────────────────────────

  /** Register a new agent. Returns the API key — save it! */
  async register(name: string, description: string): Promise<MoltbookAgent> {
    return this.request('POST', '/agents/register', { name, description });
  }

  /** Get current agent profile. */
  async getMe(): Promise<MoltbookAgent> {
    return this.request('GET', '/agents/me');
  }

  /** Get another agent's profile by name. */
  async getAgent(name: string): Promise<MoltbookAgent> {
    return this.request('GET', `/agents/profile?name=${encodeURIComponent(name)}`);
  }

  /** Follow an agent to receive their posts in feed. */
  async followAgent(name: string): Promise<void> {
    await this.request('POST', `/agents/${encodeURIComponent(name)}/follow`);
  }

  // ── Posts ──────────────────────────────────────────────

  /**
   * Create a text post in the JetPayment submolt.
   *
   * Used for publishing encrypted invitations.
   * NOTE: Rate limited to 1 post per 30 minutes!
   */
  async createPost(title: string, body: string, submolt?: string): Promise<MoltbookPost> {
    this.checkPostRateLimit();
    return this.request('POST', '/posts', {
      title,
      body,
      submolt: submolt || this.submolt,
    });
  }

  /** Get posts from a submolt or the global feed. */
  async getPosts(options: {
    submolt?: string;
    sort?: 'hot' | 'new' | 'top' | 'rising';
    limit?: number;
  } = {}): Promise<MoltbookPost[]> {
    const params = new URLSearchParams();
    if (options.sort) params.set('sort', options.sort);
    if (options.limit) params.set('limit', String(options.limit));
    if (options.submolt) params.set('submolt', options.submolt);

    const qs = params.toString();
    return this.request('GET', `/posts${qs ? '?' + qs : ''}`);
  }

  /** Get a single post by ID. */
  async getPost(id: string): Promise<MoltbookPost> {
    return this.request('GET', `/posts/${id}`);
  }

  // ── Comments ──────────────────────────────────────────

  /** Add a comment to a post (used for reply-based negotiation signaling). */
  async addComment(postId: string, body: string, parentId?: string): Promise<MoltbookComment> {
    const payload: Record<string, string> = { body };
    if (parentId) payload.parent_id = parentId;
    return this.request('POST', `/posts/${postId}/comments`, payload);
  }

  /** Get comments on a post. */
  async getComments(
    postId: string,
    sort: 'top' | 'new' | 'controversial' = 'new'
  ): Promise<MoltbookComment[]> {
    return this.request('GET', `/posts/${postId}/comments?sort=${sort}`);
  }

  // ── Search & Discovery ────────────────────────────────

  /**
   * Search Moltbook. This is the primary mechanism for discovering
   * incoming invitations, since there is no dedicated "mentions" endpoint.
   */
  async search(query: string, limit: number = 25): Promise<MoltbookSearchResult> {
    return this.request(
      'GET',
      `/search?q=${encodeURIComponent(query)}&limit=${limit}`
    );
  }

  // ── Submolts ──────────────────────────────────────────

  /** Create a submolt (community) for JetPayment invitations. */
  async createSubmolt(name: string, description: string): Promise<MoltbookSubmolt> {
    return this.request('POST', '/submolts', { name, description });
  }

  /** Subscribe to a submolt. */
  async subscribe(submoltName: string): Promise<void> {
    await this.request('POST', `/submolts/${encodeURIComponent(submoltName)}/subscribe`);
  }

  /** Get posts from the personalized feed (subscriptions + follows). */
  async getFeed(sort: 'hot' | 'new' = 'new', limit: number = 25): Promise<MoltbookPost[]> {
    return this.request('GET', `/feed?sort=${sort}&limit=${limit}`);
  }

  // ── Voting ────────────────────────────────────────────

  async upvotePost(postId: string): Promise<void> {
    await this.request('POST', `/posts/${postId}/upvote`);
  }

  // ── Rate Limit Helpers ────────────────────────────────

  getRateLimit(): RateLimitInfo {
    return { ...this.rateLimit };
  }

  getPostRateLimit(): RateLimitInfo {
    return { ...this.postRateLimit };
  }

  canPost(): boolean {
    if (this.postRateLimit.remaining > 0) return true;
    return Date.now() / 1000 > this.postRateLimit.resetAt;
  }

  secondsUntilCanPost(): number {
    if (this.canPost()) return 0;
    return Math.max(0, this.postRateLimit.resetAt - Math.floor(Date.now() / 1000));
  }

  // ── Internal ──────────────────────────────────────────

  private checkPostRateLimit(): void {
    if (!this.canPost()) {
      const wait = this.secondsUntilCanPost();
      throw new MoltbookRateLimitError(
        `Post rate limit reached. Can post again in ${wait}s.`,
        wait
      );
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
    };

    const init: RequestInit = { method, headers };

    if (body) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const res = await fetch(url, init);

    // Update rate limit tracking from response headers
    this.updateRateLimits(res, method === 'POST' && path === '/posts');

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('Retry-After') || '30', 10);
        throw new MoltbookRateLimitError(
          `Rate limited: ${res.status} ${res.statusText}. ${text}`,
          retryAfter
        );
      }
      throw new MoltbookApiError(
        `Moltbook API error: ${res.status} ${res.statusText}. ${text}`,
        res.status
      );
    }

    return res.json() as Promise<T>;
  }

  private updateRateLimits(res: Response, isPost: boolean): void {
    const limit = res.headers.get('X-RateLimit-Limit');
    const remaining = res.headers.get('X-RateLimit-Remaining');
    const reset = res.headers.get('X-RateLimit-Reset');

    const info: RateLimitInfo = {
      limit: limit ? parseInt(limit, 10) : this.rateLimit.limit,
      remaining: remaining ? parseInt(remaining, 10) : this.rateLimit.remaining,
      resetAt: reset ? parseInt(reset, 10) : this.rateLimit.resetAt,
    };

    if (isPost) {
      this.postRateLimit = info;
    }
    this.rateLimit = info;
  }
}

// ============================================================
// Errors
// ============================================================

export class MoltbookApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = 'MoltbookApiError';
  }
}

export class MoltbookRateLimitError extends MoltbookApiError {
  constructor(
    message: string,
    public readonly retryAfterSeconds: number
  ) {
    super(message, 429);
    this.name = 'MoltbookRateLimitError';
  }
}
