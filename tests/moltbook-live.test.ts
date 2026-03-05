/**
 * Tests for MoltbookClient and MoltbookDiscoveryAdapter
 *
 * These tests mock fetch to verify correct API usage
 * without hitting the real Moltbook API.
 */

import {
  MoltbookClient,
  MoltbookApiError,
  MoltbookRateLimitError,
} from '../agents/moltbook-live/client';
import { MoltbookDiscoveryAdapter } from '../agents/moltbook-live/adapter';
import { ed25519 } from '@noble/curves/ed25519';

// ── Mock fetch ──

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

function mockResponse(body: any, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: {
      get: (key: string) => headers[key] || null,
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

beforeEach(() => {
  mockFetch.mockReset();
});

// ============================================================
// MoltbookClient Tests
// ============================================================

describe('MoltbookClient', () => {
  const client = new MoltbookClient({
    apiKey: 'moltbook_test_key',
    agentName: 'test-agent',
  });

  it('should call GET /agents/me with auth header', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ name: 'test-agent', description: 'A test agent' })
    );

    const me = await client.getMe();
    expect(me.name).toBe('test-agent');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://www.moltbook.com/api/v1/agents/me');
    expect(init.headers.Authorization).toBe('Bearer moltbook_test_key');
    expect(init.method).toBe('GET');
  });

  it('should POST /posts with correct body', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ id: 'post-123', title: 'test', author: 'test-agent' })
    );

    const post = await client.createPost('Test Title', 'Test Body', 'jetpayment');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://www.moltbook.com/api/v1/posts');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.title).toBe('Test Title');
    expect(body.body).toBe('Test Body');
    expect(body.submolt).toBe('jetpayment');
  });

  it('should GET /posts with query params', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse([]));

    await client.getPosts({ submolt: 'jetpayment', sort: 'new', limit: 10 });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('/posts?');
    expect(url).toContain('sort=new');
    expect(url).toContain('limit=10');
    expect(url).toContain('submolt=jetpayment');
  });

  it('should search with encoded query', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ posts: [], agents: [], communities: [] })
    );

    await client.search('🔐 @test-agent', 10);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('/search?q=');
    expect(url).toContain(encodeURIComponent('🔐 @test-agent'));
  });

  it('should POST comment with parent_id', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ id: 'comment-1', body: 'test', author: 'test-agent' })
    );

    await client.addComment('post-1', 'test body', 'parent-1');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain('/posts/post-1/comments');
    const body = JSON.parse(init.body);
    expect(body.body).toBe('test body');
    expect(body.parent_id).toBe('parent-1');
  });

  it('should throw MoltbookApiError on non-200', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ error: 'Not found' }, 404)
    );

    await expect(client.getPost('nonexistent')).rejects.toThrow(MoltbookApiError);
  });

  it('should throw MoltbookRateLimitError on 429', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ error: 'Too many requests' }, 429, { 'Retry-After': '60' })
    );

    await expect(client.getMe()).rejects.toThrow(MoltbookRateLimitError);
  });

  it('should update rate limit tracking from headers', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ name: 'test' }, 200, {
        'X-RateLimit-Limit': '100',
        'X-RateLimit-Remaining': '42',
        'X-RateLimit-Reset': '1700000000',
      })
    );

    await client.getMe();
    const rl = client.getRateLimit();
    expect(rl.limit).toBe(100);
    expect(rl.remaining).toBe(42);
    expect(rl.resetAt).toBe(1700000000);
  });

  it('should track post rate limit separately', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ id: 'post-1' }, 200, {
        'X-RateLimit-Limit': '1',
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 1800),
      })
    );

    await client.createPost('test', 'body', 'jetpayment');
    expect(client.canPost()).toBe(false);
    expect(client.secondsUntilCanPost()).toBeGreaterThan(0);
  });
});

// ============================================================
// MoltbookDiscoveryAdapter Tests
// ============================================================

describe('MoltbookDiscoveryAdapter', () => {
  const secret = ed25519.utils.randomPrivateKey();
  const pubkey = ed25519.getPublicKey(secret);
  const targetSecret = ed25519.utils.randomPrivateKey();
  const targetPubkey = ed25519.getPublicKey(targetSecret);

  function createAdapter() {
    return new MoltbookDiscoveryAdapter(
      {
        apiKey: 'moltbook_test',
        agentName: 'test-buyer',
        submolt: 'jetpayment',
        pollIntervalMs: 60000, // Long interval to prevent auto-polling in tests
      },
      pubkey,
      secret
    );
  }

  it('should create and serialize invitation', () => {
    const adapter = createAdapter();
    const { invitation, connectionInfo } = adapter.createInvitation(
      targetPubkey,
      '/ip4/127.0.0.1/tcp/1234'
    );

    expect(invitation.ciphertext.length).toBeGreaterThan(0);
    expect(connectionInfo.multiaddr).toBe('/ip4/127.0.0.1/tcp/1234');

    const serialized = adapter.serializeInvitation(invitation);
    expect(typeof serialized).toBe('string');
    expect(serialized.length).toBeGreaterThan(50);

    adapter.destroy();
  });

  it('should round-trip serialize/deserialize invitation', () => {
    const adapter = createAdapter();
    const { invitation } = adapter.createInvitation(
      targetPubkey,
      '/ip4/10.0.0.1/tcp/5678'
    );

    const serialized = adapter.serializeInvitation(invitation);
    const deserialized = adapter.deserializeInvitation(serialized);

    expect(deserialized.ciphertext).toEqual(invitation.ciphertext);
    expect(deserialized.ephemeralPublicKey).toEqual(invitation.ephemeralPublicKey);
    expect(deserialized.nonce).toEqual(invitation.nonce);
    expect(deserialized.authTag).toEqual(invitation.authTag);

    adapter.destroy();
  });

  it('should decrypt invitation with target key', () => {
    const adapter = createAdapter();
    const targetAdapter = new MoltbookDiscoveryAdapter(
      { apiKey: 'x', agentName: 'target', pollIntervalMs: 60000 },
      targetPubkey,
      targetSecret
    );

    const { invitation } = adapter.createInvitation(
      targetPubkey,
      '/ip4/192.168.1.1/tcp/9999'
    );

    const decrypted = targetAdapter.decryptInvitation(invitation);
    expect(decrypted.multiaddr).toBe('/ip4/192.168.1.1/tcp/9999');

    adapter.destroy();
    targetAdapter.destroy();
  });

  it('should publish invitation via post', async () => {
    const adapter = createAdapter();

    mockFetch.mockResolvedValueOnce(
      mockResponse({ id: 'post-42', title: 'test', author: 'test-buyer' })
    );

    const { invitation } = adapter.createInvitation(
      targetPubkey,
      '/ip4/127.0.0.1/tcp/0'
    );

    const result = await adapter.publishInvitation('target-seller', invitation);
    expect(result.method).toBe('post');
    expect(result.postId).toBe('post-42');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain('/posts');
    const body = JSON.parse(init.body);
    expect(body.title).toContain('🔐');
    expect(body.title).toContain('@target-seller');
    expect(body.submolt).toBe('jetpayment');

    adapter.destroy();
  });

  it('should fall back to comment when rate-limited', async () => {
    const adapter = createAdapter();

    // First call: post → 429
    mockFetch.mockResolvedValueOnce(
      mockResponse({ error: 'rate limited' }, 429, { 'Retry-After': '1800' })
    );

    // Second call: search for target's posts
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        posts: [{ id: 'target-post-1', author: 'target-seller', title: 'hi' }],
        agents: [],
        communities: [],
      })
    );

    // Third call: comment on target's post
    mockFetch.mockResolvedValueOnce(
      mockResponse({ id: 'comment-99', body: 'invite', author: 'test-buyer' })
    );

    const { invitation } = adapter.createInvitation(
      targetPubkey,
      '/ip4/127.0.0.1/tcp/0'
    );

    // Mark that we can't post (simulate the rate limit)
    // The adapter should catch the 429 and try comment fallback
    const result = await adapter.publishInvitation('target-seller', invitation);
    expect(result.method).toBe('comment');
    expect(result.postId).toBe('comment-99');

    adapter.destroy();
  });
});
