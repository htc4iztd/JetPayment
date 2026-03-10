/**
 * JetPayment - Gateway Core
 *
 * The central orchestrator that wires all 4 phases together:
 * 1. Discovery (Moltbook signaling)
 * 2. Secure P2P (Libp2p + Noise XX)
 * 3. Off-chain Negotiation (FIPA ACL state machine)
 * 4. On-chain Settlement (Solana escrow)
 *
 * Also implements:
 * - Defense in Depth safety checks
 * - Policy enforcement (blast radius, rate limits, anomaly detection)
 * - Agent Function Calling interface
 * - Human-in-the-loop approval flow
 */

export { JetPaymentGateway } from './gateway';
export { PolicyEngine } from '@jetpayment/core';
