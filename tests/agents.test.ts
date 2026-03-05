/**
 * Integration Tests for JetPayment Test Agents
 *
 * Tests the full agent negotiation lifecycle:
 * - BuyerAgent and SellerAgent strategy correctness
 * - End-to-end negotiation with message passing
 * - Policy enforcement and circuit breakers
 * - Edge cases (no overlap, immediate accept, max rounds)
 */

import { BuyerAgent } from '../agents/buyer';
import { SellerAgent } from '../agents/seller';
import { MoltbookSimulator } from '../agents/moltbook-sim';
import type { AgentAsset } from '../agents/base';
import type { NegotiationMessage, OfferContent } from '../src/types';

// ── Fixtures ──

const USDC: AgentAsset = {
  mintAddress: 'USDC_MINT',
  symbol: 'USDC',
  amount: 500_000_000,
  decimals: 6,
};

const NFT: AgentAsset = {
  mintAddress: 'NFT_MINT',
  symbol: 'NFT',
  amount: 1,
  decimals: 0,
};

function createBuyer(
  maxPrice: number,
  aggressiveness: number = 0.5,
  budget: number = 1_000_000_000
): BuyerAgent {
  const buyer = new BuyerAgent('TestBuyer', budget, maxPrice, aggressiveness);
  buyer.addAsset({ ...USDC, amount: budget });
  buyer.addAsset(NFT);
  return buyer;
}

function createSeller(
  floorPrice: number,
  initialAsk: number,
  aggressiveness: number = 0.5
): SellerAgent {
  const seller = new SellerAgent('TestSeller', floorPrice, initialAsk, aggressiveness);
  seller.setSellingAsset({ ...NFT });
  seller.addAsset(USDC);
  return seller;
}

/**
 * Run a full negotiation between buyer and seller, returning the outcome.
 */
function runNegotiation(
  buyer: BuyerAgent,
  seller: SellerAgent
): {
  outcome: 'ACCEPTED' | 'REJECTED' | 'TIMEOUT';
  rounds: number;
  finalTerms?: OfferContent;
  messages: NegotiationMessage[];
} {
  const messages: NegotiationMessage[] = [];
  let outcome: 'ACCEPTED' | 'REJECTED' | 'TIMEOUT' = 'TIMEOUT';
  let finalTerms: OfferContent | undefined;
  let rounds = 0;

  // Buyer sends CFP
  const { conversationId, message: cfp } = buyer.startDeal(
    seller.pubkeyHex,
    NFT
  );
  messages.push(cfp);

  // Seller receives CFP
  seller.getNegotiationEngine().handleIncomingMessage(cfp);

  // Seller responds
  let currentMsg: NegotiationMessage | null = seller.respondToProposal(
    conversationId,
    cfp
  );
  if (currentMsg) messages.push(currentMsg);

  let currentAgent: 'buyer' | 'seller' = 'buyer';
  const maxRounds = 30;

  while (currentMsg && rounds < maxRounds) {
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
      messages.push(currentMsg);
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

  return { outcome, rounds, finalTerms, messages };
}

// ── Tests ──

describe('BuyerAgent', () => {
  afterEach(() => jest.restoreAllMocks());

  it('should generate initial offer below max price', () => {
    const buyer = createBuyer(200_000_000, 0.5);
    const offer = buyer.generateInitialOffer(NFT);

    expect(offer.give_amount).toBeLessThan(200_000_000);
    expect(offer.give_amount).toBeGreaterThan(0);
    expect(offer.give_asset).toBe(USDC.mintAddress);
    expect(offer.take_asset).toBe(NFT.mintAddress);

    buyer.destroy();
  });

  it('should accept when price is at or below limit', () => {
    const buyer = createBuyer(100_000_000);
    const message: NegotiationMessage = {
      envelope: {
        message_id: 'msg-1',
        conversation_id: 'conv-1',
        sender: 'seller',
        receiver: buyer.pubkeyHex,
        performative: 'PROPOSE' as any,
        timestamp: new Date().toISOString(),
        gateway_signature: '',
      },
      content: {
        offer: {
          give_asset: NFT.mintAddress,
          give_amount: 1,
          take_asset: USDC.mintAddress,
          take_amount: 90_000_000, // 90 USDC, below buyer's 100 limit
        },
      },
    };

    const decision = buyer.evaluateProposal('conv-1', message);
    expect(decision.action).toBe('ACCEPT');

    buyer.destroy();
  });

  it('should reject when price exceeds budget', () => {
    const buyer = createBuyer(100_000_000, 0.5, 100_000_000);
    const message: NegotiationMessage = {
      envelope: {
        message_id: 'msg-1',
        conversation_id: 'conv-1',
        sender: 'seller',
        receiver: buyer.pubkeyHex,
        performative: 'PROPOSE' as any,
        timestamp: new Date().toISOString(),
        gateway_signature: '',
      },
      content: {
        offer: {
          give_asset: NFT.mintAddress,
          give_amount: 1,
          take_asset: USDC.mintAddress,
          take_amount: 200_000_000, // 200 USDC, over 100 budget
        },
      },
    };

    const decision = buyer.evaluateProposal('conv-1', message);
    expect(decision.action).toBe('REJECT');

    buyer.destroy();
  });
});

describe('SellerAgent', () => {
  it('should accept when bid meets asking price', () => {
    const seller = createSeller(50_000_000, 100_000_000);
    const message: NegotiationMessage = {
      envelope: {
        message_id: 'msg-1',
        conversation_id: 'conv-1',
        sender: 'buyer',
        receiver: seller.pubkeyHex,
        performative: 'PROPOSE' as any,
        timestamp: new Date().toISOString(),
        gateway_signature: '',
      },
      content: {
        offer: {
          give_asset: USDC.mintAddress,
          give_amount: 110_000_000, // 110 USDC, above 100 ask
          take_asset: NFT.mintAddress,
          take_amount: 1,
        },
      },
    };

    const decision = seller.evaluateProposal('conv-1', message);
    expect(decision.action).toBe('ACCEPT');

    seller.destroy();
  });

  it('should reject absurdly low offers', () => {
    const seller = createSeller(100_000_000, 200_000_000);
    const message: NegotiationMessage = {
      envelope: {
        message_id: 'msg-1',
        conversation_id: 'conv-1',
        sender: 'buyer',
        receiver: seller.pubkeyHex,
        performative: 'PROPOSE' as any,
        timestamp: new Date().toISOString(),
        gateway_signature: '',
      },
      content: {
        offer: {
          give_asset: USDC.mintAddress,
          give_amount: 20_000_000, // 20 USDC, less than half floor (100)
          take_asset: NFT.mintAddress,
          take_amount: 1,
        },
      },
    };

    const decision = seller.evaluateProposal('conv-1', message);
    expect(decision.action).toBe('REJECT');

    seller.destroy();
  });

  it('should counter-offer with decreasing price', () => {
    const seller = createSeller(50_000_000, 200_000_000, 0.3);

    const msg1: NegotiationMessage = {
      envelope: {
        message_id: 'msg-1',
        conversation_id: 'conv-1',
        sender: 'buyer',
        receiver: seller.pubkeyHex,
        performative: 'PROPOSE' as any,
        timestamp: new Date().toISOString(),
        gateway_signature: '',
      },
      content: {
        offer: {
          give_asset: USDC.mintAddress,
          give_amount: 60_000_000,
          take_asset: NFT.mintAddress,
          take_amount: 1,
        },
      },
    };

    const d1 = seller.evaluateProposal('conv-1', msg1);
    expect(d1.action).toBe('COUNTER');
    expect(d1.counterTerms!.take_amount).toBeLessThan(200_000_000);
    expect(d1.counterTerms!.take_amount).toBeGreaterThan(50_000_000);

    seller.destroy();
  });
});

describe('End-to-End Negotiation', () => {
  it('should reach agreement when price ranges overlap', () => {
    const buyer = createBuyer(200_000_000, 0.5);
    const seller = createSeller(100_000_000, 300_000_000, 0.5);

    const result = runNegotiation(buyer, seller);

    expect(result.outcome).toBe('ACCEPTED');
    expect(result.finalTerms).toBeDefined();
    // Final price: extract USDC amount (could be give or take depending on who accepted)
    const terms = result.finalTerms!;
    const finalPrice = terms.give_asset === USDC.mintAddress
      ? terms.give_amount
      : terms.take_amount;
    expect(finalPrice).toBeGreaterThanOrEqual(100_000_000);
    expect(finalPrice).toBeLessThanOrEqual(200_000_000);
    expect(result.messages.length).toBeGreaterThan(2);

    buyer.destroy();
    seller.destroy();
  });

  it('should reject when no price overlap exists', () => {
    // Buyer max: 50, Seller floor: 100 — no overlap
    const buyer = createBuyer(50_000_000, 0.5);
    const seller = createSeller(100_000_000, 200_000_000, 0.5);

    const result = runNegotiation(buyer, seller);

    expect(result.outcome).toBe('REJECTED');

    buyer.destroy();
    seller.destroy();
  });

  it('should close quickly with eager buyer', () => {
    // Buyer is very aggressive (starts high), seller floor is low
    const buyer = createBuyer(250_000_000, 0.9);
    const seller = createSeller(50_000_000, 180_000_000, 0.2);

    const result = runNegotiation(buyer, seller);

    expect(result.outcome).toBe('ACCEPTED');
    // Should close in few rounds due to aggressive buyer + passive seller
    expect(result.rounds).toBeLessThanOrEqual(5);

    buyer.destroy();
    seller.destroy();
  });

  it('should complete many-round negotiation with aggressive agents', () => {
    const buyer = createBuyer(150_000_000, 0.3); // passive buyer
    const seller = createSeller(80_000_000, 250_000_000, 0.8); // aggressive seller

    const result = runNegotiation(buyer, seller);

    // With overlapping ranges, should still reach agreement
    expect(result.outcome).toBe('ACCEPTED');
    expect(result.rounds).toBeGreaterThan(2);

    buyer.destroy();
    seller.destroy();
  });
});

describe('MoltbookSimulator', () => {
  it('should store and retrieve posts', () => {
    const sim = new MoltbookSimulator();
    sim.registerAgent('alice', 'pubkey-alice');
    sim.registerAgent('bob', 'pubkey-bob');

    sim.createPost('alice', '@bob Hello!', 'message');
    const mentions = sim.getMentions('bob');

    expect(mentions.length).toBe(1);
    expect(mentions[0].author).toBe('alice');
    expect(mentions[0].mentions).toContain('bob');

    sim.reset();
  });

  it('should filter by type', () => {
    const sim = new MoltbookSimulator();
    sim.createPost('alice', '@bob hi', 'chat');
    sim.createPost('alice', '@bob invite', 'jetpayment_invitation');

    const invitations = sim.getMentions('bob', 'jetpayment_invitation');
    expect(invitations.length).toBe(1);
    expect(invitations[0].type).toBe('jetpayment_invitation');

    sim.reset();
  });

  it('should emit mention events', (done) => {
    const sim = new MoltbookSimulator();
    sim.on('mention:bob', (post) => {
      expect(post.author).toBe('alice');
      sim.reset();
      done();
    });

    sim.createPost('alice', '@bob test', 'test');
  });
});
