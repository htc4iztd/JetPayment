use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("JETPAY111111111111111111111111111111111111111");

/// JetPayment Escrow Smart Contract
///
/// Implements trustless atomic swap settlement for autonomous AI agents.
/// Uses PDA-based escrow vaults with Token-2022 support.
///
/// Instructions:
///   - initialize_deal: Lock initiator's assets into PDA vault
///   - execute_deal:    Atomic swap — release vault to responder, transfer responder's asset to initiator
///   - cancel_deal:     Refund after deadline expiry
#[program]
pub mod jetpayment_escrow {
    use super::*;

    /// Initialize a new deal: create the escrow PDA and lock the initiator's tokens.
    ///
    /// The initiator deposits `amount` tokens into a PDA-controlled vault.
    /// The deal_id is the SHA-256 hash of the off-chain agreed terms,
    /// anchoring the on-chain state to the off-chain negotiation.
    pub fn initialize_deal(
        ctx: Context<InitializeDeal>,
        deal_id: [u8; 32],
        amount: u64,
        deadline: i64,
    ) -> Result<()> {
        require!(amount > 0, JetPaymentError::ZeroAmount);

        let clock = Clock::get()?;
        require!(
            deadline > clock.unix_timestamp,
            JetPaymentError::DeadlineInPast
        );

        // Initialize the DealRecord PDA
        let deal = &mut ctx.accounts.deal_record;
        deal.initiator = ctx.accounts.initiator.key();
        deal.responder = ctx.accounts.responder.key();
        deal.amount = amount;
        deal.deal_id = deal_id;
        deal.deadline = deadline;
        deal.status = DealStatus::Pending as u8;
        deal.bump = ctx.bumps.deal_record;

        // Transfer tokens from initiator to escrow vault using transfer_checked
        // (validates decimals and mint — prevents spoofed token attacks)
        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.initiator_token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.initiator.to_account_info(),
            },
        );
        token_interface::transfer_checked(
            transfer_ctx,
            amount,
            ctx.accounts.mint.decimals,
        )?;

        emit!(DealInitialized {
            deal_id,
            initiator: ctx.accounts.initiator.key(),
            responder: ctx.accounts.responder.key(),
            amount,
            deadline,
        });

        Ok(())
    }

    /// Execute the deal: atomic swap between initiator and responder.
    ///
    /// The responder calls this to:
    /// 1. Transfer their asset to the initiator
    /// 2. Receive the escrowed tokens from the vault
    ///
    /// Both transfers happen atomically — if either fails, the entire
    /// transaction rolls back (Delivery vs Payment guarantee).
    pub fn execute_deal(ctx: Context<ExecuteDeal>) -> Result<()> {
        let deal = &ctx.accounts.deal_record;
        require!(
            deal.status == DealStatus::Pending as u8,
            JetPaymentError::DealNotPending
        );

        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp <= deal.deadline,
            JetPaymentError::DealExpired
        );

        // Construct PDA signer seeds for vault authority
        let initiator_key = deal.initiator;
        let deal_id = deal.deal_id;
        let bump = deal.bump;
        let seeds: &[&[u8]] = &[
            b"offer",
            initiator_key.as_ref(),
            deal_id.as_ref(),
            &[bump],
        ];
        let signer_seeds = &[seeds];

        // Step 1: Transfer responder's asset to initiator
        let transfer_responder_ctx = CpiContext::new(
            ctx.accounts.responder_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.responder_give_account.to_account_info(),
                mint: ctx.accounts.responder_mint.to_account_info(),
                to: ctx.accounts.initiator_receive_account.to_account_info(),
                authority: ctx.accounts.responder.to_account_info(),
            },
        );
        token_interface::transfer_checked(
            transfer_responder_ctx,
            ctx.accounts.responder_give_account.amount,
            ctx.accounts.responder_mint.decimals,
        )?;

        // Step 2: Release escrowed tokens from vault to responder (PDA signs)
        let transfer_vault_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.responder_receive_account.to_account_info(),
                authority: ctx.accounts.deal_record.to_account_info(),
            },
            signer_seeds,
        );
        token_interface::transfer_checked(
            transfer_vault_ctx,
            deal.amount,
            ctx.accounts.mint.decimals,
        )?;

        // Mark deal as completed
        let deal_mut = &mut ctx.accounts.deal_record;
        deal_mut.status = DealStatus::Completed as u8;

        emit!(DealExecuted {
            deal_id: deal_mut.deal_id,
            initiator: deal_mut.initiator,
            responder: deal_mut.responder,
        });

        Ok(())
    }

    /// Cancel a deal and refund the initiator.
    ///
    /// Can only be called by the initiator after the deadline has passed.
    /// This is the fail-safe mechanism for abandoned deals.
    pub fn cancel_deal(ctx: Context<CancelDeal>) -> Result<()> {
        let deal = &ctx.accounts.deal_record;
        require!(
            deal.status == DealStatus::Pending as u8,
            JetPaymentError::DealNotPending
        );

        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp > deal.deadline,
            JetPaymentError::DeadlineNotReached
        );

        // PDA signer seeds
        let initiator_key = deal.initiator;
        let deal_id = deal.deal_id;
        let bump = deal.bump;
        let seeds: &[&[u8]] = &[
            b"offer",
            initiator_key.as_ref(),
            deal_id.as_ref(),
            &[bump],
        ];
        let signer_seeds = &[seeds];

        // Refund: transfer vault tokens back to initiator
        let refund_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.initiator_token_account.to_account_info(),
                authority: ctx.accounts.deal_record.to_account_info(),
            },
            signer_seeds,
        );
        token_interface::transfer_checked(
            refund_ctx,
            deal.amount,
            ctx.accounts.mint.decimals,
        )?;

        // Mark as cancelled
        let deal_mut = &mut ctx.accounts.deal_record;
        deal_mut.status = DealStatus::Cancelled as u8;

        emit!(DealCancelled {
            deal_id: deal_mut.deal_id,
            initiator: deal_mut.initiator,
        });

        Ok(())
    }
}

// ============================================================
// Account Structures
// ============================================================

/// The on-chain state for each escrow deal.
/// PDA seeds: ["offer", initiator_pubkey, deal_id]
#[account]
pub struct DealRecord {
    /// Agent A (trade initiator) public key
    pub initiator: Pubkey,
    /// Agent B (trade counterparty) public key
    pub responder: Pubkey,
    /// Locked asset amount
    pub amount: u64,
    /// SHA-256 hash of off-chain agreed terms
    pub deal_id: [u8; 32],
    /// Trade deadline (Unix timestamp)
    pub deadline: i64,
    /// Status: 0=Pending, 1=Completed, 2=Cancelled
    pub status: u8,
    /// PDA bump seed
    pub bump: u8,
}

impl DealRecord {
    /// Space calculation: 8 (discriminator) + 32 + 32 + 8 + 32 + 8 + 1 + 1 = 122
    pub const SIZE: usize = 8 + 32 + 32 + 8 + 32 + 8 + 1 + 1;
}

#[repr(u8)]
#[derive(PartialEq, Eq)]
pub enum DealStatus {
    Pending = 0,
    Completed = 1,
    Cancelled = 2,
}

// ============================================================
// Instruction Account Contexts
// ============================================================

#[derive(Accounts)]
#[instruction(deal_id: [u8; 32], amount: u64, deadline: i64)]
pub struct InitializeDeal<'info> {
    #[account(mut)]
    pub initiator: Signer<'info>,

    /// CHECK: Responder's identity, validated off-chain
    pub responder: UncheckedAccount<'info>,

    #[account(
        init,
        payer = initiator,
        space = DealRecord::SIZE,
        seeds = [b"offer", initiator.key().as_ref(), deal_id.as_ref()],
        bump,
    )]
    pub deal_record: Account<'info, DealRecord>,

    /// Escrow vault: PDA-controlled token account
    #[account(
        init,
        payer = initiator,
        token::mint = mint,
        token::authority = deal_record,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub initiator_token_account: InterfaceAccount<'info, TokenAccount>,

    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteDeal<'info> {
    #[account(mut)]
    pub responder: Signer<'info>,

    /// CHECK: Initiator validated via deal_record
    pub initiator: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"offer", deal_record.initiator.as_ref(), deal_record.deal_id.as_ref()],
        bump = deal_record.bump,
        has_one = initiator,
        has_one = responder,
    )]
    pub deal_record: Account<'info, DealRecord>,

    /// Escrow vault holding initiator's tokens
    #[account(
        mut,
        token::mint = mint,
        token::authority = deal_record,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    // --- Initiator's escrowed token mint ---
    pub mint: InterfaceAccount<'info, Mint>,

    // --- Responder gives their asset ---
    #[account(mut)]
    pub responder_give_account: InterfaceAccount<'info, TokenAccount>,
    pub responder_mint: InterfaceAccount<'info, Mint>,

    // --- Initiator receives responder's asset ---
    #[account(mut)]
    pub initiator_receive_account: InterfaceAccount<'info, TokenAccount>,

    // --- Responder receives initiator's escrowed tokens ---
    #[account(mut)]
    pub responder_receive_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub responder_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CancelDeal<'info> {
    #[account(mut)]
    pub initiator: Signer<'info>,

    #[account(
        mut,
        seeds = [b"offer", deal_record.initiator.as_ref(), deal_record.deal_id.as_ref()],
        bump = deal_record.bump,
        has_one = initiator,
    )]
    pub deal_record: Account<'info, DealRecord>,

    #[account(
        mut,
        token::mint = mint,
        token::authority = deal_record,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub initiator_token_account: InterfaceAccount<'info, TokenAccount>,

    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
}

// ============================================================
// Events
// ============================================================

#[event]
pub struct DealInitialized {
    pub deal_id: [u8; 32],
    pub initiator: Pubkey,
    pub responder: Pubkey,
    pub amount: u64,
    pub deadline: i64,
}

#[event]
pub struct DealExecuted {
    pub deal_id: [u8; 32],
    pub initiator: Pubkey,
    pub responder: Pubkey,
}

#[event]
pub struct DealCancelled {
    pub deal_id: [u8; 32],
    pub initiator: Pubkey,
}

// ============================================================
// Errors
// ============================================================

#[error_code]
pub enum JetPaymentError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Deadline must be in the future")]
    DeadlineInPast,
    #[msg("Deal is not in Pending status")]
    DealNotPending,
    #[msg("Deal has expired")]
    DealExpired,
    #[msg("Deadline has not been reached yet")]
    DeadlineNotReached,
}
