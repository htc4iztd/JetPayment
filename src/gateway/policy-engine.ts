/**
 * JetPayment - Policy Engine (Defense in Depth)
 *
 * Implements deterministic safety checks before any on-chain signing.
 * The AI agent (LLM) is treated as an "Untrusted Requester" —
 * it cannot directly access private keys or execute transactions.
 *
 * Safety checks:
 * 1. Blast Radius Containment: enforces per-tx and per-session limits
 * 2. Deterministic Validation: verifies deal terms match negotiation history
 * 3. Anomaly Detection: circuit breaker for abnormal behavior
 * 4. Asset Whitelist: only approved token mints can be traded
 */

import { sha256Hash, bytesToHex } from '../crypto';
import type {
  GatewayPolicy,
  SafetyCheckResult,
  OfferContent,
  NegotiationSession,
} from '../types';

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

export class PolicyEngine {
  private policy: GatewayPolicy;
  private rateLimits: Map<string, RateLimitEntry> = new Map();
  private counterOfferCounts: Map<string, number> = new Map();

  constructor(policy: GatewayPolicy) {
    this.policy = policy;
  }

  /**
   * Run all safety checks before signing an on-chain transaction.
   *
   * This is the critical gate between the AI agent's decision
   * and actual on-chain execution.
   */
  validateTransaction(
    offer: OfferContent,
    session: NegotiationSession
  ): SafetyCheckResult {
    // Check 1: Blast Radius Containment
    const blastCheck = this.checkBlastRadius(offer);
    if (!blastCheck.approved) return blastCheck;

    // Check 2: Asset Whitelist
    const assetCheck = this.checkAssetWhitelist(offer);
    if (!assetCheck.approved) return assetCheck;

    // Check 3: Deterministic Validation (anti-hallucination)
    const deterministicCheck = this.checkDeterministicValidity(offer, session);
    if (!deterministicCheck.approved) return deterministicCheck;

    // Check 4: Rate Limiting
    const rateCheck = this.checkRateLimit(session.initiator);
    if (!rateCheck.approved) return rateCheck;

    // Check 5: Human approval threshold
    if (BigInt(offer.give_amount) >= this.policy.humanApprovalThreshold) {
      return {
        approved: false,
        reason: `Amount ${offer.give_amount} exceeds human approval threshold ${this.policy.humanApprovalThreshold}`,
        requiresHumanApproval: true,
      };
    }

    return { approved: true };
  }

  /**
   * Check 1: Blast Radius Containment
   * Ensures transaction amount does not exceed the configured hard limit.
   */
  private checkBlastRadius(offer: OfferContent): SafetyCheckResult {
    if (BigInt(offer.give_amount) > this.policy.maxTransactionAmount) {
      return {
        approved: false,
        reason: `Transaction amount ${offer.give_amount} exceeds maximum allowed ${this.policy.maxTransactionAmount}`,
      };
    }
    return { approved: true };
  }

  /**
   * Check 2: Asset Whitelist
   * Only pre-approved token mints can be used in trades.
   */
  private checkAssetWhitelist(offer: OfferContent): SafetyCheckResult {
    if (
      offer.give_asset &&
      !this.policy.allowedAssets.includes(offer.give_asset)
    ) {
      return {
        approved: false,
        reason: `Asset ${offer.give_asset} is not in the approved whitelist`,
      };
    }
    if (
      offer.take_asset &&
      !this.policy.allowedAssets.includes(offer.take_asset)
    ) {
      return {
        approved: false,
        reason: `Asset ${offer.take_asset} is not in the approved whitelist`,
      };
    }
    return { approved: true };
  }

  /**
   * Check 3: Deterministic Validation
   *
   * Prevents LLM hallucinations from causing incorrect transactions.
   * Verifies that the offer being signed matches the actual negotiation
   * history by recomputing the deal_id hash.
   */
  private checkDeterministicValidity(
    offer: OfferContent,
    session: NegotiationSession
  ): SafetyCheckResult {
    // Verify deal_id matches the agreed terms
    if (session.dealId && session.agreedTerms) {
      const expectedDealId = this.computeDealId(session.agreedTerms);
      if (session.dealId !== expectedDealId) {
        return {
          approved: false,
          reason: 'Deal ID does not match agreed terms hash — possible hallucination or tampering',
        };
      }

      // Verify the offer being signed matches the agreed terms
      const offerDealId = this.computeDealId(offer);
      if (offerDealId !== expectedDealId) {
        return {
          approved: false,
          reason: 'Transaction offer does not match negotiated agreement',
        };
      }
    }

    return { approved: true };
  }

  /**
   * Check 4: Rate Limiting
   * Prevents runaway loops and resource exhaustion.
   */
  private checkRateLimit(agentId: string): SafetyCheckResult {
    const now = Date.now();
    const windowMs = 60_000; // 1 minute window

    let entry = this.rateLimits.get(agentId);
    if (!entry || now - entry.windowStart > windowMs) {
      entry = { count: 0, windowStart: now };
      this.rateLimits.set(agentId, entry);
    }

    entry.count++;

    if (entry.count > this.policy.maxDealsPerMinute) {
      return {
        approved: false,
        reason: `Rate limit exceeded: ${entry.count} deals in current window (max: ${this.policy.maxDealsPerMinute})`,
      };
    }

    return { approved: true };
  }

  /**
   * Track counter-offer frequency for anomaly detection (circuit breaker).
   * Returns true if the circuit breaker should trip.
   */
  checkCounterOfferAnomaly(conversationId: string): boolean {
    const count = (this.counterOfferCounts.get(conversationId) || 0) + 1;
    this.counterOfferCounts.set(conversationId, count);

    return count > this.policy.maxNegotiationRounds;
  }

  /**
   * Reset counter-offer tracking for a completed/terminated session.
   */
  resetCounterOfferTracking(conversationId: string): void {
    this.counterOfferCounts.delete(conversationId);
  }

  /**
   * Compute deal_id from offer terms (deterministic hash).
   */
  private computeDealId(offer: OfferContent): string {
    const canonical = JSON.stringify({
      give_asset: offer.give_asset,
      give_amount: offer.give_amount,
      take_asset: offer.take_asset,
      take_amount: offer.take_amount,
    });
    const hash = sha256Hash(new TextEncoder().encode(canonical));
    return bytesToHex(hash);
  }

  /**
   * Get the current policy configuration.
   */
  getPolicy(): GatewayPolicy {
    return { ...this.policy };
  }

  /**
   * Update policy dynamically (e.g., via admin interface).
   */
  updatePolicy(updates: Partial<GatewayPolicy>): void {
    Object.assign(this.policy, updates);
  }
}
