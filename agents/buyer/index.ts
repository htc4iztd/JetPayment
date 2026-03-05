/**
 * JetPayment Test Agent - BuyerAgent
 *
 * An autonomous AI agent that purchases data/API access/NFTs.
 *
 * Strategy:
 * - Starts with a low offer (anchoring bias)
 * - Gradually increases offer based on aggressiveness setting
 * - Has a hard budget ceiling (priceLimit) it will not exceed
 * - Accepts if counterparty's price is within acceptable range
 * - Uses diminishing increment strategy for counter-offers
 */

import {
  BaseAgent,
  type AgentProfile,
  type AgentAsset,
  type NegotiationDecision,
} from '../base';
import type { MoltbookConfig } from '../../src/discovery';
import type { OfferContent, NegotiationMessage } from '../../src/types';

export class BuyerAgent extends BaseAgent {
  /** Track our latest offer per conversation for increment calculation */
  private lastOffers: Map<string, number> = new Map();

  constructor(
    name: string,
    budget: number,
    maxPrice: number,
    aggressiveness: number = 0.5,
    moltbookConfig?: MoltbookConfig
  ) {
    const profile: AgentProfile = {
      name,
      role: 'buyer',
      personality: `I am ${name}, a data-purchasing agent. I aim to acquire digital assets at the best possible price within my budget of ${budget / 1e6} USDC. I negotiate firmly but fairly.`,
      budget,
      priceLimit: maxPrice,
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
  }

  /**
   * Generate an initial offer as CFP.
   * Strategy: Start low (anchor) — around 40-70% of our max price
   * depending on aggressiveness.
   */
  generateInitialOffer(targetAsset: AgentAsset): OfferContent {
    // Lower aggressiveness → lower starting bid (more room to negotiate)
    // Higher aggressiveness → closer to our actual limit
    const startRatio = 0.4 + this.profile.aggressiveness * 0.3;
    const startingBid = Math.floor(this.profile.priceLimit * startRatio);

    // Find our payment token (USDC or similar)
    const paymentAsset = this.portfolio.find((a) => a.symbol === 'USDC') || this.portfolio[0];
    if (!paymentAsset) {
      throw new Error('No payment asset in portfolio');
    }

    const offer: OfferContent = {
      give_asset: paymentAsset.mintAddress,
      give_amount: startingBid,
      take_asset: targetAsset.mintAddress,
      take_amount: targetAsset.amount,
    };

    this.logger.log('STRATEGY',
      `Starting bid at ${(startRatio * 100).toFixed(0)}% of max → ${startingBid / (10 ** paymentAsset.decimals)} ${paymentAsset.symbol}`
    );

    return offer;
  }

  /**
   * Evaluate a received proposal and decide response.
   *
   * Decision logic:
   * 1. If seller's price ≤ our max → ACCEPT
   * 2. If seller's price > budget → REJECT
   * 3. Otherwise → COUNTER with incremented offer
   */
  evaluateProposal(
    conversationId: string,
    message: NegotiationMessage
  ): NegotiationDecision {
    const theirOffer = message.content.offer;

    // The seller's asking price is what they want us to give
    const askingPrice = theirOffer.take_amount; // What they want from us
    const sellingAmount = theirOffer.give_amount; // What they're offering

    this.logger.log('EVAL',
      `Seller asks ${askingPrice / 1e6} USDC for ${sellingAmount} units`
    );

    // Case 1: Price is within our limit — accept
    if (askingPrice <= this.profile.priceLimit) {
      this.logger.log('EVAL',
        `Price ${askingPrice / 1e6} ≤ limit ${this.profile.priceLimit / 1e6} → ACCEPT`
      );
      return {
        action: 'ACCEPT',
        reasoning: `Price of ${askingPrice / 1e6} USDC is within our budget limit.`,
      };
    }

    // Case 2: Price exceeds total budget — reject
    if (askingPrice > this.profile.budget) {
      return {
        action: 'REJECT',
        reasoning: `Asking price ${askingPrice / 1e6} USDC exceeds total budget ${this.profile.budget / 1e6} USDC.`,
      };
    }

    // Case 3: Counter-offer with diminishing increments
    const lastOffer = this.lastOffers.get(conversationId) || 0;
    const counterPrice = this.calculateCounterOffer(
      lastOffer || askingPrice * 0.5,
      askingPrice
    );

    // If our counter would exceed our limit, just accept their price
    if (counterPrice >= this.profile.priceLimit) {
      // Offer our max
      const paymentAsset = this.portfolio.find((a) => a.symbol === 'USDC') || this.portfolio[0];
      this.lastOffers.set(conversationId, this.profile.priceLimit);

      return {
        action: 'COUNTER',
        counterTerms: {
          give_asset: paymentAsset!.mintAddress,
          give_amount: this.profile.priceLimit,
          take_asset: theirOffer.give_asset,
          take_amount: theirOffer.give_amount,
        },
        reasoning: `Countering with our maximum price of ${this.profile.priceLimit / 1e6} USDC. This is our final offer.`,
      };
    }

    this.lastOffers.set(conversationId, counterPrice);

    const paymentAsset = this.portfolio.find((a) => a.symbol === 'USDC') || this.portfolio[0];
    return {
      action: 'COUNTER',
      counterTerms: {
        give_asset: paymentAsset!.mintAddress,
        give_amount: counterPrice,
        take_asset: theirOffer.give_asset,
        take_amount: theirOffer.give_amount,
      },
      reasoning: `Counter-offering ${counterPrice / 1e6} USDC (gap: ${((askingPrice - counterPrice) / 1e6).toFixed(2)} USDC remaining).`,
    };
  }

  /**
   * Calculate counter-offer using diminishing increment strategy.
   *
   * Each round we close a fraction of the gap between our last offer
   * and their asking price. The fraction depends on aggressiveness:
   * - Low aggressiveness (0.0): Close 20% of gap per round
   * - High aggressiveness (1.0): Close 60% of gap per round
   */
  private calculateCounterOffer(lastOffer: number, askingPrice: number): number {
    const gap = askingPrice - lastOffer;
    const closeFraction = 0.2 + this.profile.aggressiveness * 0.4;
    const increment = Math.floor(gap * closeFraction);
    return lastOffer + increment;
  }
}
