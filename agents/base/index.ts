/**
 * JetPayment Test Agent - Base Agent Framework
 *
 * Provides the foundational abstraction for autonomous AI agents
 * that trade on Moltbook via the JetPayment protocol.
 *
 * Each agent has:
 * - A Solana wallet identity (Ed25519 keypair)
 * - A personality / negotiation strategy
 * - Budget and risk constraints
 * - An event-driven lifecycle tied to NegotiationEngine
 */

import { EventEmitter } from 'events';
import { ed25519 } from '@noble/curves/ed25519';
import { NegotiationEngine } from '../../src/negotiation/engine';
import { PolicyEngine } from '../../src/gateway/policy-engine';
import { DiscoveryService, type MoltbookConfig } from '../../src/discovery';
import { bytesToHex } from '../../src/crypto';
import type {
  OfferContent,
  NegotiationMessage,
  GatewayPolicy,
  NegotiationSession,
} from '../../src/types';

// ============================================================
// Agent Strategy Types
// ============================================================

export type AgentRole = 'buyer' | 'seller';

export interface AgentProfile {
  name: string;
  role: AgentRole;
  /** System prompt personality description */
  personality: string;
  /** Budget in base token units (e.g. USDC with 6 decimals) */
  budget: number;
  /** Minimum acceptable price (seller) or maximum willingness-to-pay (buyer) */
  priceLimit: number;
  /** How aggressively to negotiate (0.0 = passive, 1.0 = aggressive) */
  aggressiveness: number;
  /** Maximum rounds of counter-offers before giving up */
  maxCounterOffers: number;
}

export interface AgentAsset {
  mintAddress: string;
  symbol: string;
  amount: number;
  decimals: number;
}

export interface NegotiationDecision {
  action: 'ACCEPT' | 'REJECT' | 'COUNTER';
  counterTerms?: OfferContent;
  reasoning: string;
}

// ============================================================
// Logger
// ============================================================

export class AgentLogger {
  private name: string;
  private color: string;

  constructor(name: string, color: string) {
    this.name = name;
    this.color = color;
  }

  log(phase: string, message: string): void {
    const time = new Date().toISOString().slice(11, 23);
    console.log(`${this.color}[${time}] [${this.name}] [${phase}]${RESET} ${message}`);
  }

  success(message: string): void {
    console.log(`${GREEN}[${this.name}] ✓ ${message}${RESET}`);
  }

  warn(message: string): void {
    console.log(`${YELLOW}[${this.name}] ⚠ ${message}${RESET}`);
  }

  error(message: string): void {
    console.log(`${RED}[${this.name}] ✗ ${message}${RESET}`);
  }

  negotiation(direction: 'SEND' | 'RECV', performative: string, detail: string): void {
    const arrow = direction === 'SEND' ? '→' : '←';
    console.log(
      `${this.color}[${this.name}]${RESET} ${arrow} ${BOLD}${performative}${RESET} ${detail}`
    );
  }
}

// ANSI color codes
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';

export const AGENT_COLORS = {
  buyer: CYAN,
  seller: MAGENTA,
};

// ============================================================
// Base Agent Class
// ============================================================

export abstract class BaseAgent extends EventEmitter {
  readonly profile: AgentProfile;
  readonly secretKey: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly pubkeyHex: string;

  protected negotiation: NegotiationEngine;
  protected policyEngine: PolicyEngine;
  protected discovery: DiscoveryService;
  protected logger: AgentLogger;
  protected portfolio: AgentAsset[] = [];
  protected completedDeals: Array<{
    conversationId: string;
    terms: OfferContent;
    counterparty: string;
    timestamp: number;
  }> = [];

  private counterOfferCounts: Map<string, number> = new Map();

  constructor(profile: AgentProfile, moltbookConfig: MoltbookConfig) {
    super();
    this.profile = profile;

    // Generate deterministic-ish keypair from name for reproducibility
    this.secretKey = ed25519.utils.randomPrivateKey();
    this.publicKey = ed25519.getPublicKey(this.secretKey);
    this.pubkeyHex = bytesToHex(this.publicKey);

    const color = AGENT_COLORS[profile.role] || BLUE;
    this.logger = new AgentLogger(profile.name, color);

    const policy: GatewayPolicy = {
      maxTransactionAmount: BigInt(profile.budget * 2),
      allowedAssets: [], // Will be configured per scenario
      maxNegotiationRounds: profile.maxCounterOffers * 2,
      maxDealsPerMinute: 10,
      humanApprovalThreshold: BigInt(profile.budget * 10), // No human-in-the-loop for test
      sessionTtlSeconds: 60,
    };

    this.policyEngine = new PolicyEngine(policy);

    this.negotiation = new NegotiationEngine(
      this.secretKey,
      this.pubkeyHex,
      policy
    );

    this.discovery = new DiscoveryService(
      moltbookConfig,
      this.publicKey,
      this.secretKey
    );

    this.wireNegotiationEvents();
  }

  /**
   * Add an asset to this agent's portfolio.
   */
  addAsset(asset: AgentAsset): void {
    this.portfolio.push(asset);
    this.logger.log('PORTFOLIO', `Added ${asset.amount / (10 ** asset.decimals)} ${asset.symbol}`);
  }

  /**
   * Get the agent's negotiation engine (for direct message passing).
   */
  getNegotiationEngine(): NegotiationEngine {
    return this.negotiation;
  }

  /**
   * Get completed deal history.
   */
  getCompletedDeals() {
    return [...this.completedDeals];
  }

  // ============================================================
  // Abstract: Strategy — must be implemented by each agent type
  // ============================================================

  /**
   * Evaluate a received proposal and decide how to respond.
   * This is the "brain" of the agent.
   */
  abstract evaluateProposal(
    conversationId: string,
    message: NegotiationMessage
  ): NegotiationDecision;

  /**
   * Generate initial terms when initiating a deal.
   */
  abstract generateInitialOffer(targetAsset: AgentAsset): OfferContent;

  // ============================================================
  // Actions
  // ============================================================

  /**
   * Initiate a deal with a counterparty.
   */
  startDeal(
    counterpartyPubkey: string,
    targetAsset: AgentAsset
  ): { conversationId: string; message: NegotiationMessage } {
    const terms = this.generateInitialOffer(targetAsset);
    this.logger.negotiation('SEND', 'CFP', this.formatOffer(terms));
    return this.negotiation.startNegotiation(counterpartyPubkey, terms, this.pubkeyHex);
  }

  /**
   * Respond to a proposal using the agent's strategy.
   */
  respondToProposal(conversationId: string, message: NegotiationMessage): NegotiationMessage | null {
    const decision = this.evaluateProposal(conversationId, message);

    this.logger.log('THINK', `Decision: ${decision.action} — ${decision.reasoning}`);

    // Track counter-offer counts
    if (decision.action === 'COUNTER') {
      const count = (this.counterOfferCounts.get(conversationId) || 0) + 1;
      this.counterOfferCounts.set(conversationId, count);

      if (count > this.profile.maxCounterOffers) {
        this.logger.warn(`Max counter-offers (${this.profile.maxCounterOffers}) reached, rejecting`);
        const rejectMsg = this.negotiation.respond(
          conversationId,
          'REJECT',
          undefined,
          'Maximum negotiation rounds exceeded'
        );
        this.logger.negotiation('SEND', 'REJECT', 'Max rounds exceeded');
        return rejectMsg;
      }
    }

    const responseMsg = this.negotiation.respond(
      conversationId,
      decision.action,
      decision.counterTerms,
      decision.reasoning
    );

    const detail =
      decision.action === 'COUNTER' && decision.counterTerms
        ? this.formatOffer(decision.counterTerms)
        : decision.reasoning;
    this.logger.negotiation('SEND', decision.action, detail);

    return responseMsg;
  }

  // ============================================================
  // Event Wiring
  // ============================================================

  private wireNegotiationEvents(): void {
    this.negotiation.on('cfp_received', ({ conversationId, message }) => {
      this.logger.negotiation('RECV', 'CFP', this.formatOffer(message.content.offer));
      this.emit('cfp_received', { conversationId, message });
    });

    this.negotiation.on('proposal_received', ({ conversationId, message }) => {
      const perf = message.envelope.performative;
      this.logger.negotiation('RECV', perf, this.formatOffer(message.content.offer));
      this.emit('proposal_received', { conversationId, message });
    });

    this.negotiation.on('deal_accepted', ({ conversationId, agreedTerms, dealId }) => {
      this.logger.success(
        `Deal accepted! ${this.formatOffer(agreedTerms)} [deal_id: ${dealId?.slice(0, 12)}...]`
      );

      // Record deal
      const session = this.negotiation.getSession(conversationId);
      if (session && agreedTerms) {
        this.completedDeals.push({
          conversationId,
          terms: agreedTerms,
          counterparty: session.initiator === this.pubkeyHex ? session.responder : session.initiator,
          timestamp: Date.now(),
        });
      }

      this.counterOfferCounts.delete(conversationId);
      this.emit('deal_accepted', { conversationId, agreedTerms, dealId });
    });

    this.negotiation.on('deal_rejected', ({ conversationId, message }) => {
      const reason = message?.content?.reasoning || 'No reason given';
      this.logger.warn(`Deal rejected: ${reason}`);
      this.counterOfferCounts.delete(conversationId);
      this.emit('deal_rejected', { conversationId, reason });
    });

    this.negotiation.on('session_timeout', ({ conversationId }) => {
      this.logger.error(`Session timeout: ${conversationId}`);
      this.counterOfferCounts.delete(conversationId);
      this.emit('session_timeout', { conversationId });
    });
  }

  // ============================================================
  // Helpers
  // ============================================================

  formatOffer(offer: OfferContent): string {
    const giveAsset = this.resolveAssetSymbol(offer.give_asset);
    const takeAsset = this.resolveAssetSymbol(offer.take_asset);
    const giveDecimals = this.resolveDecimals(offer.give_asset);
    const takeDecimals = this.resolveDecimals(offer.take_asset);
    const giveHuman = offer.give_amount / (10 ** giveDecimals);
    const takeHuman = offer.take_amount / (10 ** takeDecimals);
    return `${giveHuman} ${giveAsset} ↔ ${takeHuman} ${takeAsset}`;
  }

  private resolveAssetSymbol(mintAddress: string): string {
    const asset = this.portfolio.find((a) => a.mintAddress === mintAddress);
    return asset?.symbol || mintAddress.slice(0, 8) + '...';
  }

  private resolveDecimals(mintAddress: string): number {
    const asset = this.portfolio.find((a) => a.mintAddress === mintAddress);
    return asset?.decimals ?? 6;
  }

  destroy(): void {
    this.negotiation.destroy();
    this.discovery.destroy();
    this.removeAllListeners();
  }
}
