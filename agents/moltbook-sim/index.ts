/**
 * JetPayment - Moltbook Simulator
 *
 * A local in-memory simulation of the Moltbook SNS platform
 * for testing agent-to-agent communication without a real API.
 *
 * Features:
 * - In-memory post store with mention detection
 * - Simulated polling delays
 * - Message delivery between agents via event bus
 * - Timeline visualization for debugging
 */

import { EventEmitter } from 'events';

export interface MoltbookPost {
  id: string;
  author: string;
  content: string;
  type: string;
  metadata: Record<string, string>;
  createdAt: number;
  mentions: string[];
}

/**
 * MoltbookSimulator provides a local mock of the Moltbook SNS API.
 *
 * Agents can post to and poll from this simulated platform,
 * enabling end-to-end testing of the Discovery phase.
 */
export class MoltbookSimulator extends EventEmitter {
  private posts: MoltbookPost[] = [];
  private nextId = 1;
  private registeredAgents: Map<string, string> = new Map(); // handle → pubkey

  /**
   * Register an agent with the simulator.
   */
  registerAgent(handle: string, pubkey: string): void {
    this.registeredAgents.set(handle, pubkey);
    this.log(`Agent registered: @${handle} (${pubkey.slice(0, 12)}...)`);
  }

  /**
   * Create a post (simulates POST /api/v1/posts).
   */
  createPost(
    authorHandle: string,
    content: string,
    type: string,
    metadata: Record<string, string> = {}
  ): MoltbookPost {
    // Extract mentions (@handle)
    const mentionRegex = /@([\w-]+)/g;
    const mentions: string[] = [];
    let match;
    while ((match = mentionRegex.exec(content)) !== null) {
      mentions.push(match[1]);
    }

    const post: MoltbookPost = {
      id: `post-${this.nextId++}`,
      author: authorHandle,
      content,
      type,
      metadata,
      createdAt: Date.now(),
      mentions,
    };

    this.posts.push(post);

    // Emit for visualization
    this.emit('post_created', post);

    // Notify mentioned agents
    for (const mentioned of mentions) {
      this.emit(`mention:${mentioned}`, post);
    }

    this.log(
      `📝 @${authorHandle} posted [${type}] mentioning: ${mentions.map((m) => '@' + m).join(', ') || 'none'}`
    );

    return post;
  }

  /**
   * Get mentions for a specific handle (simulates GET /api/v1/mentions).
   */
  getMentions(handle: string, type?: string, since?: number): MoltbookPost[] {
    return this.posts.filter((post) => {
      if (!post.mentions.includes(handle)) return false;
      if (type && post.type !== type) return false;
      if (since && post.createdAt <= since) return false;
      return true;
    });
  }

  /**
   * Get all posts (timeline view).
   */
  getTimeline(): MoltbookPost[] {
    return [...this.posts].sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Print a formatted timeline of all posts.
   */
  printTimeline(): void {
    console.log('\n\x1b[1m═══════════════════════════════════════════════════\x1b[0m');
    console.log('\x1b[1m  Moltbook Timeline\x1b[0m');
    console.log('\x1b[1m═══════════════════════════════════════════════════\x1b[0m');

    for (const post of this.getTimeline()) {
      const time = new Date(post.createdAt).toISOString().slice(11, 23);
      const contentPreview =
        post.content.length > 60
          ? post.content.slice(0, 57) + '...'
          : post.content;
      console.log(
        `  \x1b[90m${time}\x1b[0m  \x1b[36m@${post.author}\x1b[0m  ${contentPreview}`
      );
    }

    console.log(
      `\x1b[1m═══════════════════════════════════════════════════\x1b[0m\n`
    );
  }

  /**
   * Reset the simulator state.
   */
  reset(): void {
    this.posts = [];
    this.nextId = 1;
    this.registeredAgents.clear();
    this.removeAllListeners();
  }

  private log(message: string): void {
    const time = new Date().toISOString().slice(11, 23);
    console.log(`\x1b[90m[${time}] [Moltbook]\x1b[0m ${message}`);
  }
}

/**
 * Create a mock MoltbookConfig that points to the simulator.
 * For use in test agents that would normally call the real Moltbook API.
 */
export function createSimulatorConfig(
  agentHandle: string,
  sim: MoltbookSimulator
): {
  apiBaseUrl: string;
  agentHandle: string;
  apiToken: string;
  pollIntervalMs: number;
} {
  return {
    apiBaseUrl: 'http://localhost:0', // Not used — simulator intercepts calls
    agentHandle,
    apiToken: 'sim-token',
    pollIntervalMs: 1000,
  };
}
