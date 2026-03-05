/**
 * JetPayment - Test Scenario Runner
 *
 * Runs multiple negotiation scenarios demonstrating different
 * market conditions and agent strategies.
 *
 * Usage: npx ts-node agents/scenarios/run-all.ts
 */

import { runScenario, type ScenarioConfig, type ScenarioResult } from './negotiation-sim';
import type { AgentAsset } from '../base';

// ============================================================
// Token Fixtures (simulated Solana mints)
// ============================================================

const USDC: AgentAsset = {
  mintAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC devnet
  symbol: 'USDC',
  amount: 0, // Set per agent
  decimals: 6,
};

const DATA_NFT: AgentAsset = {
  mintAddress: 'DATAnft111111111111111111111111111111111111111',
  symbol: 'DATA-NFT',
  amount: 1,
  decimals: 0,
};

const API_TOKEN: AgentAsset = {
  mintAddress: 'APItoken22222222222222222222222222222222222222',
  symbol: 'API-ACCESS',
  amount: 100_000_000, // 100 units
  decimals: 6,
};

const COMPUTE_NFT: AgentAsset = {
  mintAddress: 'COMPnft333333333333333333333333333333333333333',
  symbol: 'GPU-HOUR',
  amount: 10_000_000, // 10 units
  decimals: 6,
};

// ============================================================
// Scenarios
// ============================================================

const scenarios: ScenarioConfig[] = [
  {
    name: 'Scenario 1: Fair Market — Data NFT Purchase',
    description:
      'Buyer and seller have overlapping price ranges. Both are moderately aggressive. Expected: deal closes near midpoint.',
    buyer: {
      name: 'DataBuyer-Alpha',
      budget: 500_000_000, // 500 USDC
      maxPrice: 200_000_000, // willing to pay up to 200 USDC
      aggressiveness: 0.5,
      paymentAsset: { ...USDC, amount: 500_000_000 },
    },
    seller: {
      name: 'DataSeller-Prime',
      floorPrice: 100_000_000, // won't sell below 100 USDC
      initialAsk: 300_000_000, // starts at 300 USDC
      aggressiveness: 0.5,
      sellingAsset: { ...DATA_NFT },
    },
  },
  {
    name: 'Scenario 2: Tough Negotiation — API Access',
    description:
      'Buyer is aggressive (low starting bid), seller is also aggressive (small concessions). Expected: many rounds before agreement.',
    buyer: {
      name: 'AgentSwarm-7',
      budget: 1_000_000_000, // 1000 USDC
      maxPrice: 80_000_000, // max 80 USDC
      aggressiveness: 0.8,
      paymentAsset: { ...USDC, amount: 1_000_000_000 },
    },
    seller: {
      name: 'OracleNet-API',
      floorPrice: 50_000_000, // floor 50 USDC
      initialAsk: 120_000_000, // asks 120 USDC
      aggressiveness: 0.9,
      sellingAsset: { ...API_TOKEN },
    },
  },
  {
    name: 'Scenario 3: No Deal Zone — Price Gap Too Large',
    description:
      'Buyer max price is below seller floor. Expected: negotiation ends in REJECT.',
    buyer: {
      name: 'BudgetBot-3',
      budget: 100_000_000, // 100 USDC
      maxPrice: 30_000_000, // max 30 USDC
      aggressiveness: 0.3,
      paymentAsset: { ...USDC, amount: 100_000_000 },
    },
    seller: {
      name: 'PremiumGPU-Host',
      floorPrice: 80_000_000, // floor 80 USDC
      initialAsk: 150_000_000, // asks 150 USDC
      aggressiveness: 0.7,
      sellingAsset: { ...COMPUTE_NFT },
    },
  },
  {
    name: 'Scenario 4: Quick Accept — Eager Buyer',
    description:
      'Buyer is very aggressive (starts close to max) and seller floor is low. Expected: fast deal in 1-2 rounds.',
    buyer: {
      name: 'UrgentBuyer-1',
      budget: 500_000_000, // 500 USDC
      maxPrice: 250_000_000, // max 250 USDC
      aggressiveness: 0.9,
      paymentAsset: { ...USDC, amount: 500_000_000 },
    },
    seller: {
      name: 'FlexSeller-X',
      floorPrice: 50_000_000, // floor 50 USDC
      initialAsk: 180_000_000, // asks 180 USDC
      aggressiveness: 0.2,
      sellingAsset: { ...DATA_NFT },
    },
  },
  {
    name: 'Scenario 5: Symmetric Agents — Equal Power',
    description:
      'Both agents have identical aggressiveness. Price range perfectly symmetric. Expected: deal at exact midpoint.',
    buyer: {
      name: 'SymAgent-Buy',
      budget: 400_000_000,
      maxPrice: 150_000_000, // max 150
      aggressiveness: 0.5,
      paymentAsset: { ...USDC, amount: 400_000_000 },
    },
    seller: {
      name: 'SymAgent-Sell',
      floorPrice: 50_000_000, // floor 50
      initialAsk: 250_000_000, // asks 250
      aggressiveness: 0.5,
      sellingAsset: { ...API_TOKEN },
    },
  },
];

// ============================================================
// Main Runner
// ============================================================

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';

async function main(): Promise<void> {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║                                                          ║
║   ${BOLD}JetPayment — Agent Negotiation Test Suite${RESET}              ║
║                                                          ║
║   Autonomous AI agents negotiate trades on Moltbook      ║
║   using FIPA ACL structured messaging protocol.          ║
║                                                          ║
║   Phases: Discovery → P2P → Negotiation → Settlement     ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
`);

  const results: ScenarioResult[] = [];

  // Parse CLI args for specific scenario
  const args = process.argv.slice(2);
  const scenarioIndex = args[0] ? parseInt(args[0], 10) - 1 : -1;

  const toRun =
    scenarioIndex >= 0 && scenarioIndex < scenarios.length
      ? [scenarios[scenarioIndex]]
      : scenarios;

  for (const scenario of toRun) {
    const result = await runScenario(scenario);
    results.push(result);
  }

  // ── Summary ──
  printSummary(results);
}

function printSummary(results: ScenarioResult[]): void {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`${BOLD}  Summary — ${results.length} Scenarios${RESET}`);
  console.log(`${'═'.repeat(60)}`);

  const accepted = results.filter((r) => r.outcome === 'ACCEPTED');
  const rejected = results.filter((r) => r.outcome === 'REJECTED');
  const timeout = results.filter((r) => r.outcome === 'TIMEOUT');

  console.log(
    `  ${GREEN}Accepted: ${accepted.length}${RESET} | ${RED}Rejected: ${rejected.length}${RESET} | ${YELLOW}Timeout: ${timeout.length}${RESET}`
  );

  console.log(`\n  ${'─'.repeat(56)}`);
  console.log(
    `  ${'Scenario'.padEnd(40)} ${'Result'.padEnd(10)} Rounds`
  );
  console.log(`  ${'─'.repeat(56)}`);

  for (const r of results) {
    const color =
      r.outcome === 'ACCEPTED' ? GREEN : r.outcome === 'REJECTED' ? RED : YELLOW;
    const price = r.finalTerms ? `${r.finalTerms.give_amount / 1e6} USDC` : '-';
    console.log(
      `  ${r.scenarioName.slice(0, 39).padEnd(40)} ${color}${r.outcome.padEnd(10)}${RESET} ${String(r.rounds).padStart(3)}   ${DIM}${price}${RESET}`
    );
  }

  console.log(`  ${'─'.repeat(56)}`);

  const totalRounds = results.reduce((s, r) => s + r.rounds, 0);
  const totalMs = results.reduce((s, r) => s + r.durationMs, 0);
  console.log(`\n  Total rounds: ${totalRounds} | Total time: ${totalMs}ms`);
  console.log(`${'═'.repeat(60)}\n`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
