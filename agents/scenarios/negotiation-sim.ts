/**
 * JetPayment - Negotiation Simulation Orchestrator
 *
 * Runs end-to-end agent negotiation scenarios locally.
 * Simulates the full protocol flow without actual Moltbook API or Solana:
 *
 *   1. Discovery: Encrypted invitation exchange (via Moltbook simulator)
 *   2. P2P: Direct message passing (simulated in-process)
 *   3. Negotiation: FIPA ACL off-chain messaging
 *   4. Settlement: Simulated escrow (logs the on-chain tx that would execute)
 *
 * This allows testing negotiation strategies, policy enforcement,
 * and the entire deal lifecycle without blockchain costs.
 */

import { BuyerAgent } from '../buyer';
import { SellerAgent } from '../seller';
import { MoltbookSimulator } from '../moltbook-sim';
import type { AgentAsset } from '../base';
import type { NegotiationMessage, OfferContent } from '../../src/types';
import { sha256Hash, bytesToHex } from '../../src/crypto';

// ANSI
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';
const RED = '\x1b[31m';
const BG_GREEN = '\x1b[42m';
const BG_RED = '\x1b[41m';
const WHITE = '\x1b[37m';

export interface ScenarioConfig {
  name: string;
  description: string;
  buyer: {
    name: string;
    budget: number;
    maxPrice: number;
    aggressiveness: number;
    paymentAsset: AgentAsset;
  };
  seller: {
    name: string;
    floorPrice: number;
    initialAsk: number;
    aggressiveness: number;
    sellingAsset: AgentAsset;
  };
}

export interface ScenarioResult {
  scenarioName: string;
  outcome: 'ACCEPTED' | 'REJECTED' | 'TIMEOUT';
  rounds: number;
  finalTerms?: OfferContent;
  dealId?: string;
  messages: NegotiationMessage[];
  buyerPubkey: string;
  sellerPubkey: string;
  durationMs: number;
}

/**
 * Run a complete negotiation scenario between a buyer and seller.
 */
export async function runScenario(config: ScenarioConfig): Promise<ScenarioResult> {
  const startTime = Date.now();

  printHeader(config);

  // ── Setup Moltbook simulator ──
  const moltbook = new MoltbookSimulator();

  // ── Create agents ──
  const buyer = new BuyerAgent(
    config.buyer.name,
    config.buyer.budget,
    config.buyer.maxPrice,
    config.buyer.aggressiveness
  );
  buyer.addAsset(config.buyer.paymentAsset);

  // Register additional assets so buyer can resolve symbols
  buyer.addAsset(config.seller.sellingAsset);

  const seller = new SellerAgent(
    config.seller.name,
    config.seller.floorPrice,
    config.seller.initialAsk,
    config.seller.aggressiveness
  );
  seller.setSellingAsset(config.seller.sellingAsset);
  seller.addAsset(config.buyer.paymentAsset);

  // Register with Moltbook sim
  moltbook.registerAgent(config.buyer.name.toLowerCase(), buyer.pubkeyHex);
  moltbook.registerAgent(config.seller.name.toLowerCase(), seller.pubkeyHex);

  printAgentInfo(buyer.profile.name, 'BUYER', buyer.pubkeyHex, CYAN, config.buyer);
  printAgentInfo(seller.profile.name, 'SELLER', seller.pubkeyHex, MAGENTA, config.seller);

  console.log(`\n${BOLD}── Phase 1: Discovery ──${RESET}`);
  console.log(`${DIM}Buyer creates ECIES-encrypted invitation for Seller's pubkey${RESET}`);

  // ── Phase 1: Discovery (simulated) ──
  // In real flow: buyer posts encrypted invitation on Moltbook
  // Here we just pass pubkeys directly since we're in-process
  const { invitation, connectionInfo } = buyer['discovery'].createInvitation(
    seller.publicKey,
    '/ip4/127.0.0.1/tcp/0/p2p/simulated'
  );

  // Simulate Moltbook post
  const serialized = buyer['discovery'].serializeInvitation(invitation);
  moltbook.createPost(
    config.buyer.name.toLowerCase(),
    `@${config.seller.name.toLowerCase()} 🔐 ${serialized.slice(0, 40)}...`,
    'jetpayment_invitation'
  );

  // Seller decrypts (proves correct key exchange)
  const decrypted = seller['discovery'].decryptInvitation(invitation);
  console.log(`${GREEN}✓ Invitation encrypted & decrypted successfully${RESET}`);
  console.log(`${DIM}  Session token: ${decrypted.sessionToken.slice(0, 16)}...${RESET}`);

  console.log(`\n${BOLD}── Phase 2: Secure P2P ──${RESET}`);
  console.log(`${DIM}Noise XX handshake with Solana wallet identity verification${RESET}`);
  console.log(`${GREEN}✓ P2P channel established (simulated in-process)${RESET}`);

  console.log(`\n${BOLD}── Phase 3: Off-chain Negotiation ──${RESET}`);

  // ── Phase 3: Off-chain Negotiation ──
  const allMessages: NegotiationMessage[] = [];
  let outcome: 'ACCEPTED' | 'REJECTED' | 'TIMEOUT' = 'TIMEOUT';
  let finalTerms: OfferContent | undefined;
  let dealId: string | undefined;
  let rounds = 0;

  // Step 1: Buyer sends CFP
  const { conversationId, message: cfpMessage } = buyer.startDeal(
    seller.pubkeyHex,
    config.seller.sellingAsset
  );
  allMessages.push(cfpMessage);

  // Deliver CFP to seller
  seller.getNegotiationEngine().handleIncomingMessage(cfpMessage);

  // Step 2: Seller responds to CFP
  let currentMessage: NegotiationMessage | null = seller.respondToProposal(
    conversationId,
    cfpMessage
  );

  if (currentMessage) {
    allMessages.push(currentMessage);
  }

  // Step 3: Negotiation loop
  const maxRounds = 20;
  let currentAgent: 'buyer' | 'seller' = 'buyer';

  while (currentMessage && rounds < maxRounds) {
    rounds++;

    const perf = currentMessage.envelope.performative;

    // Check terminal states
    if (perf === 'ACCEPT_PROPOSAL') {
      outcome = 'ACCEPTED';
      // Extract agreed terms from the accept message
      finalTerms = currentMessage.content.offer;
      dealId = currentMessage.content.deal_id;
      break;
    }

    if (perf === 'REJECT_PROPOSAL') {
      outcome = 'REJECTED';
      break;
    }

    // Deliver message to the other agent and get response
    if (currentAgent === 'buyer') {
      // Deliver to buyer's engine
      buyer.getNegotiationEngine().handleIncomingMessage(currentMessage);
      currentMessage = buyer.respondToProposal(conversationId, currentMessage);
      currentAgent = 'seller';
    } else {
      // Deliver to seller's engine
      seller.getNegotiationEngine().handleIncomingMessage(currentMessage);
      currentMessage = seller.respondToProposal(conversationId, currentMessage);
      currentAgent = 'buyer';
    }

    if (currentMessage) {
      allMessages.push(currentMessage);

      // Check if this response is terminal
      const respPerf = currentMessage.envelope.performative;
      if (respPerf === 'ACCEPT_PROPOSAL') {
        outcome = 'ACCEPTED';
        finalTerms = currentMessage.content.offer;
        dealId = currentMessage.content.deal_id;
        break;
      }
      if (respPerf === 'REJECT_PROPOSAL') {
        outcome = 'REJECTED';
        break;
      }
    }
  }

  const durationMs = Date.now() - startTime;

  // ── Phase 4: Settlement (simulated) ──
  console.log(`\n${BOLD}── Phase 4: On-chain Settlement ──${RESET}`);

  if (outcome === 'ACCEPTED' && finalTerms && dealId) {
    console.log(`${GREEN}✓ Deal agreed! Simulating Solana escrow...${RESET}`);
    console.log(`${DIM}  deal_id:   ${dealId.slice(0, 32)}...${RESET}`);
    console.log(`${DIM}  PDA seeds: ["offer", initiator_pubkey, deal_id]${RESET}`);
    console.log(`${DIM}  Action:    initialize_deal → execute_deal (atomic swap)${RESET}`);
    printSettlementSummary(finalTerms, config);
  } else {
    console.log(`${YELLOW}⚠ No settlement — deal ${outcome.toLowerCase()}${RESET}`);
  }

  // ── Results ──
  const result: ScenarioResult = {
    scenarioName: config.name,
    outcome,
    rounds,
    finalTerms,
    dealId,
    messages: allMessages,
    buyerPubkey: buyer.pubkeyHex,
    sellerPubkey: seller.pubkeyHex,
    durationMs,
  };

  printResult(result, config);

  // Show Moltbook timeline
  moltbook.printTimeline();

  // Cleanup
  buyer.destroy();
  seller.destroy();
  moltbook.reset();

  return result;
}

// ============================================================
// Pretty Printing
// ============================================================

function printHeader(config: ScenarioConfig): void {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`${BOLD}  JetPayment Negotiation Simulation${RESET}`);
  console.log(`${BOLD}  Scenario: ${config.name}${RESET}`);
  console.log(`${DIM}  ${config.description}${RESET}`);
  console.log(`${'═'.repeat(60)}`);
}

function printAgentInfo(
  name: string,
  role: string,
  pubkey: string,
  color: string,
  config: any
): void {
  console.log(`\n${color}${BOLD}  ${role}: ${name}${RESET}`);
  console.log(`${DIM}  Pubkey: ${pubkey.slice(0, 20)}...${RESET}`);

  if (role === 'BUYER') {
    console.log(
      `${DIM}  Budget: ${config.budget / 1e6} USDC | Max price: ${config.maxPrice / 1e6} USDC | Aggressiveness: ${config.aggressiveness}${RESET}`
    );
  } else {
    console.log(
      `${DIM}  Floor: ${config.floorPrice / 1e6} USDC | Initial ask: ${config.initialAsk / 1e6} USDC | Aggressiveness: ${config.aggressiveness}${RESET}`
    );
  }
}

/**
 * Extract the USDC price from agreed terms regardless of perspective.
 * The terms might have USDC in give_asset (buyer's view) or take_asset (seller's view).
 */
function extractUsdcPrice(terms: OfferContent, config: ScenarioConfig): number {
  if (terms.give_asset === config.buyer.paymentAsset.mintAddress) {
    return terms.give_amount;
  }
  if (terms.take_asset === config.buyer.paymentAsset.mintAddress) {
    return terms.take_amount;
  }
  // Fallback: larger amount is likely the USDC price
  return Math.max(terms.give_amount, terms.take_amount);
}

function printSettlementSummary(terms: OfferContent, config: ScenarioConfig): void {
  const priceRaw = extractUsdcPrice(terms, config);
  const price = priceRaw / 1e6;
  const midpoint =
    (config.buyer.maxPrice / 1e6 + config.seller.floorPrice / 1e6) / 2;
  const savings = (config.seller.initialAsk / 1e6 - price).toFixed(2);
  const premium = (price - config.seller.floorPrice / 1e6).toFixed(2);

  console.log(`\n  ${BOLD}Settlement Summary:${RESET}`);
  console.log(`  ┌─────────────────────────────────────┐`);
  console.log(`  │  Final Price: ${BOLD}${price} USDC${RESET}            │`);
  console.log(`  │  Seller Saving: ${GREEN}${savings} USDC${RESET} off initial   │`);
  console.log(`  │  Buyer Premium: ${YELLOW}${premium} USDC${RESET} over floor   │`);
  console.log(`  │  Midpoint:      ${midpoint.toFixed(2)} USDC             │`);
  console.log(`  └─────────────────────────────────────┘`);
}

function printResult(result: ScenarioResult, config: ScenarioConfig): void {
  const outcomeColor =
    result.outcome === 'ACCEPTED' ? BG_GREEN : result.outcome === 'REJECTED' ? BG_RED : YELLOW;

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${BOLD}  RESULT: ${outcomeColor}${WHITE} ${result.outcome} ${RESET}`);
  console.log(`  Rounds: ${result.rounds}`);
  console.log(`  Messages: ${result.messages.length}`);
  console.log(`  Duration: ${result.durationMs}ms`);

  if (result.finalTerms) {
    const priceRaw = extractUsdcPrice(result.finalTerms, config);
    console.log(
      `  Final Price: ${priceRaw / 1e6} USDC`
    );

    // Calculate who got the better deal
    const price = priceRaw;
    const buyerMax = config.buyer.maxPrice;
    const sellerFloor = config.seller.floorPrice;
    const range = buyerMax - sellerFloor;
    const buyerGain = ((buyerMax - price) / range * 100).toFixed(1);
    const sellerGain = ((price - sellerFloor) / range * 100).toFixed(1);

    console.log(
      `  Buyer captured ${CYAN}${buyerGain}%${RESET} of surplus | Seller captured ${MAGENTA}${sellerGain}%${RESET} of surplus`
    );
  }

  console.log(`${'─'.repeat(60)}\n`);
}
