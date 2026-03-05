/**
 * JetPayment - Live Moltbook Negotiation Runner
 *
 * Runs a buyer/seller negotiation using the REAL Moltbook API.
 *
 * What happens:
 *   1. Both agents connect to Moltbook with their API keys
 *   2. Buyer posts an encrypted ECIES invitation to s/jetpayment
 *   3. Seller polls s/jetpayment, finds and decrypts the invitation
 *   4. Off-chain negotiation runs in-process (same as simulator)
 *   5. Results are posted back to Moltbook as a settlement receipt
 *
 * Usage:
 *   # Set up .env first (copy from .env.example)
 *   npx ts-node agents/scenarios/run-live.ts
 *
 * NOTE: Moltbook rate-limits posts to 1 per 30 minutes.
 *       If rate-limited, the script will fall back to comment-based delivery.
 */

import { MoltbookDiscoveryAdapter, type LiveDiscoveryConfig } from '../moltbook-live';
import { BuyerAgent } from '../buyer';
import { SellerAgent } from '../seller';
import type { AgentAsset } from '../base';
import type { NegotiationMessage, OfferContent } from '../../src/types';

// ANSI
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';

// ============================================================
// Config Loader
// ============================================================

function loadEnv(): Record<string, string> {
  try {
    const fs = require('fs');
    const path = require('path');
    const envPath = path.resolve(__dirname, '../../.env');
    const content = fs.readFileSync(envPath, 'utf-8');
    const env: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const [key, ...rest] = trimmed.split('=');
      env[key.trim()] = rest.join('=').trim();
    }
    return env;
  } catch {
    return {};
  }
}

function getConfig(): {
  buyer: LiveDiscoveryConfig;
  seller: LiveDiscoveryConfig;
  submolt: string;
} {
  const env = { ...loadEnv(), ...process.env };

  const buyerKey = env.BUYER_MOLTBOOK_API_KEY;
  const buyerName = env.BUYER_MOLTBOOK_NAME;
  const sellerKey = env.SELLER_MOLTBOOK_API_KEY;
  const sellerName = env.SELLER_MOLTBOOK_NAME;
  const submolt = env.JETPAYMENT_SUBMOLT || 'jetpayment';
  const baseUrl = env.MOLTBOOK_API_URL;

  if (!buyerKey || !sellerKey || !buyerName || !sellerName) {
    console.error(`${RED}Missing environment variables.${RESET}`);
    console.error(`\nRequired variables in .env or environment:`);
    console.error(`  BUYER_MOLTBOOK_API_KEY   = moltbook_xxx`);
    console.error(`  BUYER_MOLTBOOK_NAME      = your-buyer-agent`);
    console.error(`  SELLER_MOLTBOOK_API_KEY  = moltbook_xxx`);
    console.error(`  SELLER_MOLTBOOK_NAME     = your-seller-agent`);
    console.error(`\nCopy .env.example to .env and fill in your values.`);
    process.exit(1);
  }

  return {
    buyer: {
      apiKey: buyerKey,
      agentName: buyerName,
      baseUrl,
      submolt,
      pollIntervalMs: 5000,
    },
    seller: {
      apiKey: sellerKey,
      agentName: sellerName,
      baseUrl,
      submolt,
      pollIntervalMs: 5000,
    },
    submolt,
  };
}

// ============================================================
// Tokens
// ============================================================

const USDC: AgentAsset = {
  mintAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  symbol: 'USDC',
  amount: 500_000_000,
  decimals: 6,
};

const DATA_NFT: AgentAsset = {
  mintAddress: 'DATAnft111111111111111111111111111111111111111',
  symbol: 'DATA-NFT',
  amount: 1,
  decimals: 0,
};

// ============================================================
// Main
// ============================================================

async function main(): Promise<void> {
  console.log(`
${BOLD}╔══════════════════════════════════════════════════════════╗
║  JetPayment — Live Moltbook Negotiation                  ║
╚══════════════════════════════════════════════════════════╝${RESET}
`);

  const config = getConfig();

  // ── Create Agents ──
  const buyer = new BuyerAgent('LiveBuyer', 500_000_000, 200_000_000, 0.5);
  buyer.addAsset({ ...USDC, amount: 500_000_000 });
  buyer.addAsset(DATA_NFT);

  const seller = new SellerAgent('LiveSeller', 100_000_000, 300_000_000, 0.5);
  seller.setSellingAsset({ ...DATA_NFT });
  seller.addAsset(USDC);

  // ── Create Live Discovery Adapters ──
  const buyerDiscovery = new MoltbookDiscoveryAdapter(
    config.buyer,
    buyer.publicKey,
    buyer.secretKey
  );

  const sellerDiscovery = new MoltbookDiscoveryAdapter(
    config.seller,
    seller.publicKey,
    seller.secretKey
  );

  // ── Step 1: Verify Moltbook connections ──
  console.log(`${BOLD}── Step 1: Verify Moltbook connections ──${RESET}`);

  try {
    await buyerDiscovery.verifyConnection();
    console.log(`${GREEN}✓ Buyer connected as @${config.buyer.agentName}${RESET}`);
  } catch (err) {
    console.error(`${RED}✗ Buyer connection failed: ${err}${RESET}`);
    process.exit(1);
  }

  try {
    await sellerDiscovery.verifyConnection();
    console.log(`${GREEN}✓ Seller connected as @${config.seller.agentName}${RESET}`);
  } catch (err) {
    console.error(`${RED}✗ Seller connection failed: ${err}${RESET}`);
    process.exit(1);
  }

  // ── Step 2: Ensure submolt exists ──
  console.log(`\n${BOLD}── Step 2: Ensure s/${config.submolt} submolt exists ──${RESET}`);
  await buyerDiscovery.ensureSubmoltExists();

  // ── Step 3: Buyer creates and publishes invitation ──
  console.log(`\n${BOLD}── Step 3: Publish encrypted invitation ──${RESET}`);
  console.log(`${DIM}Creating ECIES-encrypted invitation for @${config.seller.agentName}...${RESET}`);

  const { invitation, connectionInfo } = buyerDiscovery.createInvitation(
    seller.publicKey,
    '/ip4/127.0.0.1/tcp/0/p2p/simulated-live'
  );

  console.log(`${DIM}Session token: ${connectionInfo.sessionToken.slice(0, 16)}...${RESET}`);

  try {
    const result = await buyerDiscovery.publishInvitation(
      config.seller.agentName,
      invitation
    );
    console.log(
      `${GREEN}✓ Invitation published via ${result.method} (ID: ${result.postId})${RESET}`
    );
  } catch (err) {
    console.error(`${RED}✗ Failed to publish invitation: ${err}${RESET}`);
    console.log(`${YELLOW}Continuing with in-process negotiation anyway...${RESET}`);
  }

  // ── Step 4: Verify seller can decrypt ──
  console.log(`\n${BOLD}── Step 4: Seller decrypts invitation ──${RESET}`);

  try {
    const decrypted = sellerDiscovery.decryptInvitation(invitation);
    console.log(`${GREEN}✓ Invitation decrypted successfully${RESET}`);
    console.log(`${DIM}  Initiator: ${decrypted.initiatorPubkey.slice(0, 20)}...${RESET}`);
    console.log(`${DIM}  Multiaddr: ${decrypted.multiaddr}${RESET}`);
  } catch (err) {
    console.error(`${RED}✗ Decryption failed: ${err}${RESET}`);
  }

  // ── Step 5: Off-chain negotiation ──
  console.log(`\n${BOLD}── Step 5: Off-chain Negotiation (FIPA ACL) ──${RESET}`);

  const { conversationId, message: cfpMessage } = buyer.startDeal(
    seller.pubkeyHex,
    DATA_NFT
  );

  seller.getNegotiationEngine().handleIncomingMessage(cfpMessage);
  let currentMsg: NegotiationMessage | null = seller.respondToProposal(
    conversationId,
    cfpMessage
  );

  let outcome: 'ACCEPTED' | 'REJECTED' | 'TIMEOUT' = 'TIMEOUT';
  let finalTerms: OfferContent | undefined;
  let rounds = 0;
  let currentAgent: 'buyer' | 'seller' = 'buyer';

  while (currentMsg && rounds < 20) {
    rounds++;
    const perf = currentMsg.envelope.performative;

    if (perf === 'ACCEPT_PROPOSAL') {
      outcome = 'ACCEPTED';
      finalTerms = currentMsg.content.offer;
      break;
    }
    if (perf === 'REJECT_PROPOSAL') {
      outcome = 'REJECTED';
      break;
    }

    if (currentAgent === 'buyer') {
      buyer.getNegotiationEngine().handleIncomingMessage(currentMsg);
      currentMsg = buyer.respondToProposal(conversationId, currentMsg);
      currentAgent = 'seller';
    } else {
      seller.getNegotiationEngine().handleIncomingMessage(currentMsg);
      currentMsg = seller.respondToProposal(conversationId, currentMsg);
      currentAgent = 'buyer';
    }

    if (currentMsg) {
      const rp = currentMsg.envelope.performative;
      if (rp === 'ACCEPT_PROPOSAL') {
        outcome = 'ACCEPTED';
        finalTerms = currentMsg.content.offer;
        break;
      }
      if (rp === 'REJECT_PROPOSAL') {
        outcome = 'REJECTED';
        break;
      }
    }
  }

  // ── Step 6: Post settlement receipt to Moltbook ──
  console.log(`\n${BOLD}── Step 6: Settlement Receipt ──${RESET}`);

  if (outcome === 'ACCEPTED' && finalTerms) {
    const price = finalTerms.give_asset === USDC.mintAddress
      ? finalTerms.give_amount
      : finalTerms.take_amount;

    console.log(`${GREEN}✓ Deal accepted! Price: ${price / 1e6} USDC${RESET}`);
    console.log(`  Rounds: ${rounds}`);

    // Post receipt to Moltbook (if rate limit allows)
    try {
      if (buyerDiscovery.getClient().canPost()) {
        await buyerDiscovery.getClient().createPost(
          `✅ JetPayment Deal Complete`,
          [
            `Deal between @${config.buyer.agentName} and @${config.seller.agentName}`,
            `Asset: DATA-NFT`,
            `Price: ${price / 1e6} USDC`,
            `Rounds: ${rounds}`,
            `Protocol: JetPayment v1.0.0`,
          ].join('\n'),
          config.submolt
        );
        console.log(`${GREEN}✓ Settlement receipt posted to s/${config.submolt}${RESET}`);
      } else {
        const wait = buyerDiscovery.getClient().secondsUntilCanPost();
        console.log(`${YELLOW}⚠ Skipping receipt post (rate limited, ${wait}s remaining)${RESET}`);
      }
    } catch (err) {
      console.log(`${YELLOW}⚠ Could not post receipt: ${err}${RESET}`);
    }
  } else {
    console.log(`${RED}✗ Deal ${outcome.toLowerCase()}${RESET}`);
  }

  // ── Cleanup ──
  buyer.destroy();
  seller.destroy();
  buyerDiscovery.destroy();
  sellerDiscovery.destroy();

  console.log(`\n${BOLD}Done.${RESET}\n`);
}

main().catch((err) => {
  console.error(`${RED}Fatal error: ${err}${RESET}`);
  process.exit(1);
});
