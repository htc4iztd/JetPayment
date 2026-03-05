/**
 * JetPayment - Core Type Definitions
 * Autonomous AI Agent Hybrid Payment Architecture
 */

// ============================================================
// Phase 1: Discovery Types
// ============================================================

/** Encrypted invitation payload sent via Moltbook */
export interface EncryptedInvitation {
  /** ECIES-encrypted payload containing multiaddr + session token */
  ciphertext: Uint8Array;
  /** Ephemeral X25519 public key used for ECDH */
  ephemeralPublicKey: Uint8Array;
  /** 12-byte nonce for AES-256-GCM */
  nonce: Uint8Array;
  /** AES-GCM authentication tag */
  authTag: Uint8Array;
}

/** Decrypted connection info extracted from invitation */
export interface ConnectionInfo {
  /** Libp2p multiaddr for P2P connection */
  multiaddr: string;
  /** One-time session token for first-packet verification */
  sessionToken: string;
  /** Solana public key of the initiator */
  initiatorPubkey: string;
  /** Timestamp for TTL enforcement */
  createdAt: number;
  /** Expiration in seconds */
  ttlSeconds: number;
}

// ============================================================
// Phase 2: Secure P2P Types
// ============================================================

export enum PeerConnectionState {
  AWAITING_TOKEN = 'AWAITING_TOKEN',
  TOKEN_VERIFIED = 'TOKEN_VERIFIED',
  NOISE_HANDSHAKE = 'NOISE_HANDSHAKE',
  IDENTITY_VERIFIED = 'IDENTITY_VERIFIED',
  CONNECTED = 'CONNECTED',
  DISCONNECTED = 'DISCONNECTED',
}

export interface PeerSession {
  sessionId: string;
  remotePeerId: string;
  remoteSolanaPubkey: string;
  state: PeerConnectionState;
  createdAt: number;
  lastActivity: number;
}

// ============================================================
// Phase 3: Off-chain Negotiation Types (FIPA ACL)
// ============================================================

export enum Performative {
  CFP = 'CFP',
  PROPOSE = 'PROPOSE',
  COUNTER_OFFER = 'COUNTER_OFFER',
  ACCEPT_PROPOSAL = 'ACCEPT_PROPOSAL',
  REJECT_PROPOSAL = 'REJECT_PROPOSAL',
}

export interface MessageEnvelope {
  message_id: string;
  conversation_id: string;
  in_reply_to?: string;
  sender: string;
  receiver: string;
  performative: Performative;
  timestamp: string;
  gateway_signature: string;
}

export interface OfferContent {
  give_asset: string;
  give_amount: number;
  take_asset: string;
  take_amount: number;
}

export interface NegotiationMessageContent {
  offer: OfferContent;
  reasoning?: string;
  deal_id?: string;
  ttl_seconds?: number;
  error_code?: string;
}

export interface NegotiationMessage {
  envelope: MessageEnvelope;
  content: NegotiationMessageContent;
}

/** Negotiation state machine states */
export enum NegotiationState {
  IDLE = 'IDLE',
  CFP_SENT = 'CFP_SENT',
  CFP_RECEIVED = 'CFP_RECEIVED',
  PROPOSAL_SENT = 'PROPOSAL_SENT',
  PROPOSAL_RECEIVED = 'PROPOSAL_RECEIVED',
  COUNTER_SENT = 'COUNTER_SENT',
  COUNTER_RECEIVED = 'COUNTER_RECEIVED',
  ACCEPTED = 'ACCEPTED',
  REJECTED = 'REJECTED',
  TIMED_OUT = 'TIMED_OUT',
}

export interface NegotiationSession {
  conversationId: string;
  state: NegotiationState;
  messages: NegotiationMessage[];
  agreedTerms?: OfferContent;
  dealId?: string;
  initiator: string;
  responder: string;
  createdAt: number;
  updatedAt: number;
  maxRounds: number;
  currentRound: number;
}

// ============================================================
// Phase 4: On-chain Settlement Types
// ============================================================

export enum DealStatus {
  Pending = 0,
  Completed = 1,
  Cancelled = 2,
}

export interface DealRecord {
  initiator: string;
  responder: string;
  amount: bigint;
  dealId: Uint8Array; // 32-byte SHA-256 hash
  deadline: number;   // Unix timestamp
  status: DealStatus;
  bump: number;
}

export interface SettlementResult {
  transactionSignature: string;
  dealId: string;
  status: DealStatus;
  timestamp: number;
}

// ============================================================
// Gateway Policy & Safety Types
// ============================================================

export interface GatewayPolicy {
  /** Maximum amount per single transaction (in token base units) */
  maxTransactionAmount: bigint;
  /** Allowed token mints for trading */
  allowedAssets: string[];
  /** Maximum negotiation rounds before circuit breaker */
  maxNegotiationRounds: number;
  /** Rate limit: max deals per minute */
  maxDealsPerMinute: number;
  /** Require human approval above this threshold */
  humanApprovalThreshold: bigint;
  /** Session TTL in seconds */
  sessionTtlSeconds: number;
}

export interface SafetyCheckResult {
  approved: boolean;
  reason?: string;
  requiresHumanApproval?: boolean;
}

// ============================================================
// Agent Function Calling Interface
// ============================================================

export interface InitiateDealParams {
  targetId: string;
  initialTerms: OfferContent;
}

export interface EvaluateProposalParams {
  sessionId: string;
  decision: 'ACCEPT' | 'REJECT' | 'COUNTER';
  counterTerms?: OfferContent;
  reasoning?: string;
}

export interface SignTransactionParams {
  sessionId: string;
  agreedTerms: OfferContent;
}

/** Events emitted by the gateway for agent consumption */
export enum GatewayEvent {
  INVITATION_RECEIVED = 'INVITATION_RECEIVED',
  PEER_CONNECTED = 'PEER_CONNECTED',
  PEER_DISCONNECTED = 'PEER_DISCONNECTED',
  PROPOSAL_RECEIVED = 'PROPOSAL_RECEIVED',
  DEAL_ACCEPTED = 'DEAL_ACCEPTED',
  DEAL_REJECTED = 'DEAL_REJECTED',
  SETTLEMENT_COMPLETE = 'SETTLEMENT_COMPLETE',
  SETTLEMENT_FAILED = 'SETTLEMENT_FAILED',
  SAFETY_CHECK_FAILED = 'SAFETY_CHECK_FAILED',
  SESSION_TIMEOUT = 'SESSION_TIMEOUT',
}

export interface GatewayEventPayload {
  event: GatewayEvent;
  sessionId: string;
  data: unknown;
  timestamp: number;
}
