/**
 * JetPayment Test Agent - SellerAgent
 *
 * An autonomous AI agent that sells data, API access, or digital assets.
 *
 * Strategy:
 * - Starts with a high asking price (above floor)
 * - Gradually decreases asking price based on aggressiveness
 * - Has a hard floor price (priceLimit) below which it will REJECT
 * - Uses concession strategy: each round concedes a % of remaining gap
 */

import {
  BaseAgent,
  type AgentProfile,
  type AgentAsset,
  type NegotiationDecision,
} from '../base';
import type { MoltbookConfig } from '../../src/discovery';
import type { OfferContent, NegotiationMessage } from '../../src/types';

export class SellerAgent extends BaseAgent {
  /** Track our latest asking price per conversation */
  private lastAskingPrices: Map<string, number> = new Map();
  /** The asset being sold */
  private sellingAsset: AgentAsset | null = null;
  /** Initial asking price (before any negotiation) */
  private initialAskingPrice: number = 0;

  constructor(
    name: string,
    floorPrice: number,
    initialAsk: number,
    aggressiveness: number = 0.5,
    moltbookConfig?: MoltbookConfig
  ) {
    const profile: AgentProfile = {
      name,
      role: 'seller',
      personality: `I am ${name}, a digital asset seller. My floor price is ${floorPrice / 1e6} USDC and I start negotiations at ${initialAsk / 1e6} USDC. I value my assets fairly.`,
      budget: initialAsk, // Budget used as initial asking price
      priceLimit: floorPrice,
      aggressiveness: Math.max(0, Math.min(1, aggressiveness)),
      maxCounterOffers: 5,
    };

    super(
      profile,
      moltbookConfig || {
        apiBaseUrl: 'http://localhost:3000',
        agentHandle: name.toLowerCase().replace(/\s+/g, '-'),
        apiToken: 'test-token',
        pollIntervalMs: 2000,
      }
    );

    this.initialAskingPrice = initialAsk;
  }

  /**
   * Configure the asset this seller is offering.
   */
  setSellingAsset(asset: AgentAsset): void {
    this.sellingAsset = asset;
    this.addAsset(asset);
    this.logger.log('INVENTORY', `Selling: ${asset.amount / (10 ** asset.decimals)} ${asset.symbol}`);
  }

  /**
   * Generate an initial offer (as CFP or responding to a CFP).
   * Strategy: Start high — above floor by a markup that depends on aggressiveness.
   */
  generateInitialOffer(targetAsset: AgentAsset): OfferContent {
    if (!this.sellingAsset) {
      throw new Error('No selling asset configured');
    }

    return {
      give_asset: this.sellingAsset.mintAddress,
      give_amount: this.sellingAsset.amount,
      take_asset: targetAsset.mintAddress,
      take_amount: this.initialAskingPrice,
    };
  }

  /**
   * Evaluate a received proposal and decide response.
   *
   * Decision logic (as seller, we evaluate what buyer offers to pay):
   * 1. If buyer's offer ≥ our current asking price → ACCEPT
   * 2. If buyer's offer ≥ floor price AND close to our ask → ACCEPT
   * 3. If we've been negotiating and they're improving → COUNTER (lower our ask)
   * 4. If buyer is way too low → REJECT or COUNTER with small concession
   */
  evaluateProposal(
    conversationId: string,
    message: NegotiationMessage
  ): NegotiationDecision {
    const theirOffer = message.content.offer;

    // What the buyer is offering to pay us
    const buyerBid = theirOffer.give_amount;

    // Our current asking price (or initial if first round)
    const currentAsk =
      this.lastAskingPrices.get(conversationId) || this.initialAskingPrice;
    const floorPrice = this.profile.priceLimit;

    this.logger.log('EVAL',
      `Buyer bids ${buyerBid / 1e6} USDC | Our ask: ${currentAsk / 1e6} | Floor: ${floorPrice / 1e6}`
    );

    // Case 1: Buyer meets or exceeds our ask — accept immediately
    if (buyerBid >= currentAsk) {
      this.logger.log('EVAL', `Bid ${buyerBid / 1e6} ≥ ask ${currentAsk / 1e6} → ACCEPT`);
      return {
        action: 'ACCEPT',
        reasoning: `Buyer's offer of ${buyerBid / 1e6} USDC meets our asking price.`,
      };
    }

    // Case 2: Buyer is at or above floor and within 5% of our ask — accept (close enough)
    const gapRatio = (currentAsk - buyerBid) / currentAsk;
    if (buyerBid >= floorPrice && gapRatio < 0.05) {
      this.logger.log('EVAL', `Bid within 5% of ask and above floor → ACCEPT`);
      return {
        action: 'ACCEPT',
        reasoning: `Buyer's offer of ${buyerBid / 1e6} USDC is within acceptable range (${(gapRatio * 100).toFixed(1)}% gap).`,
      };
    }

    // Case 3: Buyer is below floor — reject if way too low, otherwise counter
    if (buyerBid < floorPrice * 0.5) {
      return {
        action: 'REJECT',
        reasoning: `Buyer's offer of ${buyerBid / 1e6} USDC is less than half our floor price of ${floorPrice / 1e6} USDC. Not a serious offer.`,
      };
    }

    // Case 4: Counter-offer with concession
    const newAsk = this.calculateConcession(currentAsk, buyerBid, floorPrice);
    this.lastAskingPrices.set(conversationId, newAsk);

    if (!this.sellingAsset) {
      throw new Error('No selling asset configured');
    }

    const paymentMint = theirOffer.give_asset;

    return {
      action: 'COUNTER',
      counterTerms: {
        give_asset: this.sellingAsset.mintAddress,
        give_amount: this.sellingAsset.amount,
        take_asset: paymentMint,
        take_amount: newAsk,
      },
      reasoning: `Lowered asking price to ${newAsk / 1e6} USDC (was ${currentAsk / 1e6}). Gap from buyer: ${((newAsk - buyerBid) / 1e6).toFixed(2)} USDC.`,
    };
  }

  /**
   * Calculate a concession (lower our asking price).
   *
   * Concession strategy:
   * - Low aggressiveness (0.0): Concede 40% of gap to floor per round
   * - High aggressiveness (1.0): Concede only 15% of gap to floor per round
   *
   * (Aggressive sellers concede less, passive sellers concede more)
   */
  private calculateConcession(
    currentAsk: number,
    buyerBid: number,
    floorPrice: number
  ): number {
    const gapToFloor = currentAsk - floorPrice;
    // Aggressive sellers concede less
    const concessionRate = 0.4 - this.profile.aggressiveness * 0.25;
    const concession = Math.floor(gapToFloor * concessionRate);
    const newAsk = currentAsk - concession;

    // Never go below floor
    return Math.max(newAsk, floorPrice);
  }
}
