/**
 * JetPayment - Phase 4: On-chain Settlement Layer
 *
 * Manages Solana blockchain interactions:
 * - Escrow PDA derivation
 * - Transaction construction and signing
 * - Deal lifecycle management (initialize, execute, cancel)
 * - On-chain event monitoring via WebSocket
 */

import { EventEmitter } from 'events';
import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
} from '@solana/spl-token';
import { sha256Hash, bytesToHex, hexToBytes } from '../crypto';
import type { DealRecord, DealStatus, SettlementResult, OfferContent } from '../types';

const PROGRAM_ID = new PublicKey('JETPAY111111111111111111111111111111111111111');

export interface SettlementConfig {
  /** Solana RPC endpoint */
  rpcUrl: string;
  /** WebSocket endpoint for event subscription */
  wsUrl: string;
  /** Commitment level */
  commitment: 'processed' | 'confirmed' | 'finalized';
  /** Default deadline offset in seconds */
  defaultDeadlineOffset: number;
}

/**
 * SettlementService handles on-chain escrow operations.
 *
 * All transactions use transfer_checked to prevent spoofed token attacks.
 * PDA seeds: ["offer", initiator_pubkey, deal_id]
 */
export class SettlementService extends EventEmitter {
  private connection: Connection;
  private config: SettlementConfig;
  private walletKeypair: Keypair;
  private subscriptionIds: Map<string, number> = new Map();

  constructor(config: SettlementConfig, walletKeypair: Keypair) {
    super();
    this.config = config;
    this.walletKeypair = walletKeypair;
    this.connection = new Connection(config.rpcUrl, {
      commitment: config.commitment,
      wsEndpoint: config.wsUrl,
    });
  }

  /**
   * Derive the PDA address for a deal's escrow account.
   * Seeds: ["offer", initiator_pubkey, deal_id_bytes]
   */
  deriveDealPDA(
    initiatorPubkey: PublicKey,
    dealIdHex: string
  ): [PublicKey, number] {
    const dealIdBytes = hexToBytes(dealIdHex);
    return PublicKey.findProgramAddressSync(
      [Buffer.from('offer'), initiatorPubkey.toBuffer(), dealIdBytes],
      PROGRAM_ID
    );
  }

  /**
   * Compute the deal_id from agreed terms (same as off-chain computation).
   */
  computeDealId(offer: OfferContent): string {
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
   * Initialize a deal: lock tokens into the PDA escrow vault.
   *
   * Called by the Initiator (Agent A) after ACCEPT_PROPOSAL.
   */
  async initializeDeal(
    responderPubkey: PublicKey,
    mintPubkey: PublicKey,
    amount: bigint,
    dealIdHex: string,
    deadlineOffset?: number
  ): Promise<SettlementResult> {
    const [dealPDA, bump] = this.deriveDealPDA(
      this.walletKeypair.publicKey,
      dealIdHex
    );

    const deadline =
      Math.floor(Date.now() / 1000) +
      (deadlineOffset || this.config.defaultDeadlineOffset);

    const dealIdBytes = hexToBytes(dealIdHex);

    // Get token accounts
    const initiatorTokenAccount = await getAssociatedTokenAddress(
      mintPubkey,
      this.walletKeypair.publicKey
    );

    // Create vault token account (PDA-controlled)
    const vaultKeypair = Keypair.generate();

    // Build the initialize_deal instruction
    // In production this would use Anchor's IDL-generated client.
    // Here we show the account structure:
    const initIx = buildInitializeDealInstruction({
      initiator: this.walletKeypair.publicKey,
      responder: responderPubkey,
      dealRecord: dealPDA,
      vault: vaultKeypair.publicKey,
      initiatorTokenAccount,
      mint: mintPubkey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      dealId: dealIdBytes,
      amount: BigInt(amount),
      deadline: BigInt(deadline),
    });

    const tx = new Transaction().add(initIx);

    const signature = await sendAndConfirmTransaction(
      this.connection,
      tx,
      [this.walletKeypair, vaultKeypair],
      { commitment: this.config.commitment }
    );

    const result: SettlementResult = {
      transactionSignature: signature,
      dealId: dealIdHex,
      status: 0 as DealStatus, // Pending
      timestamp: Date.now(),
    };

    this.emit('deal_initialized', result);

    // Subscribe to deal account changes
    this.subscribeToDeal(dealPDA, dealIdHex);

    return result;
  }

  /**
   * Execute a deal: perform the atomic swap.
   *
   * Called by the Responder (Agent B) to complete the trade.
   * Both token transfers happen in a single atomic transaction.
   */
  async executeDeal(
    initiatorPubkey: PublicKey,
    dealIdHex: string,
    initiatorMint: PublicKey,
    responderMint: PublicKey,
    responderGiveAmount: bigint,
    responderGiveDecimals: number
  ): Promise<SettlementResult> {
    const [dealPDA] = this.deriveDealPDA(initiatorPubkey, dealIdHex);

    const responderGiveAccount = await getAssociatedTokenAddress(
      responderMint,
      this.walletKeypair.publicKey
    );
    const initiatorReceiveAccount = await getAssociatedTokenAddress(
      responderMint,
      initiatorPubkey
    );
    const responderReceiveAccount = await getAssociatedTokenAddress(
      initiatorMint,
      this.walletKeypair.publicKey
    );

    // Vault derived from the deal PDA
    // In production, query the on-chain DealRecord to get vault address
    const vaultAccount = await this.findVaultForDeal(dealPDA);

    const executeIx = buildExecuteDealInstruction({
      responder: this.walletKeypair.publicKey,
      initiator: initiatorPubkey,
      dealRecord: dealPDA,
      vault: vaultAccount,
      mint: initiatorMint,
      responderGiveAccount,
      responderMint,
      initiatorReceiveAccount,
      responderReceiveAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
      responderTokenProgram: TOKEN_PROGRAM_ID,
    });

    const tx = new Transaction().add(executeIx);

    const signature = await sendAndConfirmTransaction(
      this.connection,
      tx,
      [this.walletKeypair],
      { commitment: this.config.commitment }
    );

    const result: SettlementResult = {
      transactionSignature: signature,
      dealId: dealIdHex,
      status: 1 as DealStatus, // Completed
      timestamp: Date.now(),
    };

    this.emit('deal_executed', result);
    return result;
  }

  /**
   * Cancel a deal and reclaim escrowed tokens.
   *
   * Only available to the Initiator after the deadline has passed.
   */
  async cancelDeal(
    dealIdHex: string,
    mintPubkey: PublicKey
  ): Promise<SettlementResult> {
    const [dealPDA] = this.deriveDealPDA(
      this.walletKeypair.publicKey,
      dealIdHex
    );

    const initiatorTokenAccount = await getAssociatedTokenAddress(
      mintPubkey,
      this.walletKeypair.publicKey
    );
    const vaultAccount = await this.findVaultForDeal(dealPDA);

    const cancelIx = buildCancelDealInstruction({
      initiator: this.walletKeypair.publicKey,
      dealRecord: dealPDA,
      vault: vaultAccount,
      initiatorTokenAccount,
      mint: mintPubkey,
      tokenProgram: TOKEN_PROGRAM_ID,
    });

    const tx = new Transaction().add(cancelIx);

    const signature = await sendAndConfirmTransaction(
      this.connection,
      tx,
      [this.walletKeypair],
      { commitment: this.config.commitment }
    );

    const result: SettlementResult = {
      transactionSignature: signature,
      dealId: dealIdHex,
      status: 2 as DealStatus, // Cancelled
      timestamp: Date.now(),
    };

    this.emit('deal_cancelled', result);
    return result;
  }

  /**
   * Subscribe to on-chain deal account changes via WebSocket.
   */
  private subscribeToDeal(dealPDA: PublicKey, dealIdHex: string): void {
    const subId = this.connection.onAccountChange(
      dealPDA,
      (accountInfo) => {
        // Parse the DealRecord data from the account
        const data = accountInfo.data;
        if (data.length >= 122) {
          const statusByte = data[8 + 32 + 32 + 8 + 32 + 8]; // offset to status field
          if (statusByte === 1) {
            this.emit('on_chain_deal_completed', { dealId: dealIdHex });
          } else if (statusByte === 2) {
            this.emit('on_chain_deal_cancelled', { dealId: dealIdHex });
          }
        }
      },
      this.config.commitment
    );

    this.subscriptionIds.set(dealIdHex, subId);
  }

  /**
   * Look up the vault token account associated with a deal PDA.
   */
  private async findVaultForDeal(dealPDA: PublicKey): Promise<PublicKey> {
    // In production, this queries the on-chain account and extracts vault address.
    // For the interface definition, we derive it from known patterns.
    const accountInfo = await this.connection.getAccountInfo(dealPDA);
    if (!accountInfo) {
      throw new Error(`Deal PDA not found: ${dealPDA.toBase58()}`);
    }

    // The vault address would typically be stored or derivable.
    // In the Anchor program, it's a separate account passed at init time.
    // For now, return the PDA itself as a placeholder — production would
    // store the vault pubkey in the DealRecord or use a deterministic derivation.
    return dealPDA;
  }

  /**
   * Unsubscribe from all on-chain watchers and clean up.
   */
  async destroy(): Promise<void> {
    for (const [dealId, subId] of this.subscriptionIds) {
      this.connection.removeAccountChangeListener(subId);
    }
    this.subscriptionIds.clear();
    this.removeAllListeners();
  }
}

// ============================================================
// Instruction Builders (Anchor IDL-compatible structure)
// ============================================================

interface InitializeDealAccounts {
  initiator: PublicKey;
  responder: PublicKey;
  dealRecord: PublicKey;
  vault: PublicKey;
  initiatorTokenAccount: PublicKey;
  mint: PublicKey;
  tokenProgram: PublicKey;
  systemProgram: PublicKey;
  dealId: Uint8Array;
  amount: bigint;
  deadline: bigint;
}

function buildInitializeDealInstruction(
  accounts: InitializeDealAccounts
): TransactionInstruction {
  // Anchor discriminator for initialize_deal
  const discriminator = Buffer.from([
    0x4a, 0x45, 0x54, 0x50, 0x41, 0x59, 0x00, 0x01,
  ]);

  // Serialize instruction data
  const data = Buffer.alloc(8 + 32 + 8 + 8);
  discriminator.copy(data, 0);
  Buffer.from(accounts.dealId).copy(data, 8);

  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(accounts.amount);
  amountBuf.copy(data, 40);

  const deadlineBuf = Buffer.alloc(8);
  deadlineBuf.writeBigInt64LE(accounts.deadline);
  deadlineBuf.copy(data, 48);

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: accounts.initiator, isSigner: true, isWritable: true },
      { pubkey: accounts.responder, isSigner: false, isWritable: false },
      { pubkey: accounts.dealRecord, isSigner: false, isWritable: true },
      { pubkey: accounts.vault, isSigner: true, isWritable: true },
      { pubkey: accounts.initiatorTokenAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.mint, isSigner: false, isWritable: false },
      { pubkey: accounts.tokenProgram, isSigner: false, isWritable: false },
      { pubkey: accounts.systemProgram, isSigner: false, isWritable: false },
    ],
    data,
  });
}

interface ExecuteDealAccounts {
  responder: PublicKey;
  initiator: PublicKey;
  dealRecord: PublicKey;
  vault: PublicKey;
  mint: PublicKey;
  responderGiveAccount: PublicKey;
  responderMint: PublicKey;
  initiatorReceiveAccount: PublicKey;
  responderReceiveAccount: PublicKey;
  tokenProgram: PublicKey;
  responderTokenProgram: PublicKey;
}

function buildExecuteDealInstruction(
  accounts: ExecuteDealAccounts
): TransactionInstruction {
  const discriminator = Buffer.from([
    0x4a, 0x45, 0x54, 0x50, 0x41, 0x59, 0x00, 0x02,
  ]);

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: accounts.responder, isSigner: true, isWritable: true },
      { pubkey: accounts.initiator, isSigner: false, isWritable: false },
      { pubkey: accounts.dealRecord, isSigner: false, isWritable: true },
      { pubkey: accounts.vault, isSigner: false, isWritable: true },
      { pubkey: accounts.mint, isSigner: false, isWritable: false },
      { pubkey: accounts.responderGiveAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.responderMint, isSigner: false, isWritable: false },
      { pubkey: accounts.initiatorReceiveAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.responderReceiveAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.tokenProgram, isSigner: false, isWritable: false },
      { pubkey: accounts.responderTokenProgram, isSigner: false, isWritable: false },
    ],
    data: discriminator,
  });
}

interface CancelDealAccounts {
  initiator: PublicKey;
  dealRecord: PublicKey;
  vault: PublicKey;
  initiatorTokenAccount: PublicKey;
  mint: PublicKey;
  tokenProgram: PublicKey;
}

function buildCancelDealInstruction(
  accounts: CancelDealAccounts
): TransactionInstruction {
  const discriminator = Buffer.from([
    0x4a, 0x45, 0x54, 0x50, 0x41, 0x59, 0x00, 0x03,
  ]);

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: accounts.initiator, isSigner: true, isWritable: true },
      { pubkey: accounts.dealRecord, isSigner: false, isWritable: true },
      { pubkey: accounts.vault, isSigner: false, isWritable: true },
      { pubkey: accounts.initiatorTokenAccount, isSigner: false, isWritable: true },
      { pubkey: accounts.mint, isSigner: false, isWritable: false },
      { pubkey: accounts.tokenProgram, isSigner: false, isWritable: false },
    ],
    data: discriminator,
  });
}
