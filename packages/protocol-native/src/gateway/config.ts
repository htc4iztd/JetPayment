/**
 * JetPayment - Default Configuration
 */

import type { GatewayPolicy } from '@jetpayment/core';
import type { JetPaymentConfig } from './gateway';

/**
 * Default gateway policy — conservative limits suitable for initial deployment.
 */
export const DEFAULT_POLICY: GatewayPolicy = {
  maxTransactionAmount: BigInt(1_000_000_000), // 1000 USDC (6 decimals)
  allowedAssets: [],                            // Must be explicitly configured
  maxNegotiationRounds: 20,
  maxDealsPerMinute: 5,
  humanApprovalThreshold: BigInt(500_000_000),  // 500 USDC
  sessionTtlSeconds: 300,                       // 5 minutes
};

/**
 * Create a JetPaymentConfig with sensible defaults.
 *
 * If `discoveryProvider` is supplied, it takes precedence.
 * Otherwise, falls back to `moltbook` config for backward compatibility.
 */
export function createDefaultConfig(
  overrides: Partial<JetPaymentConfig> = {}
): JetPaymentConfig {
  return {
    discoveryProvider: overrides.discoveryProvider,
    moltbook: overrides.discoveryProvider
      ? undefined
      : {
          apiBaseUrl: 'https://moltbook.example.com',
          agentHandle: '',
          apiToken: '',
          pollIntervalMs: 5000,
          ...overrides.moltbook,
        },
    p2p: {
      listenAddr: '/ip4/0.0.0.0/tcp/0',
      connectionTimeoutMs: 30000,
      idleTimeoutMs: 120000,
      ...overrides.p2p,
    },
    settlement: {
      rpcUrl: 'https://api.mainnet-beta.solana.com',
      wsUrl: 'wss://api.mainnet-beta.solana.com',
      commitment: 'confirmed',
      defaultDeadlineOffset: 3600, // 1 hour
      ...overrides.settlement,
    },
    policy: {
      ...DEFAULT_POLICY,
      ...overrides.policy,
    },
  };
}
