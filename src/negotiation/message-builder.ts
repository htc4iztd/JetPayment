/**
 * JetPayment - FIPA ACL Message Builder
 *
 * Constructs properly formatted negotiation messages with
 * gateway signatures and deterministic deal IDs.
 */

import { v4 as uuidv4 } from 'uuid';
import { ed25519Sign, sha256Hash, bytesToHex, hexToBytes } from '../crypto';
import {
  Performative,
  type MessageEnvelope,
  type NegotiationMessage,
  type NegotiationMessageContent,
  type OfferContent,
} from '../types';

export class MessageBuilder {
  private gatewaySecretKey: Uint8Array;
  private gatewayPubkeyHex: string;

  constructor(gatewaySecretKey: Uint8Array, gatewayPubkeyHex: string) {
    this.gatewaySecretKey = gatewaySecretKey;
    this.gatewayPubkeyHex = gatewayPubkeyHex;
  }

  /**
   * Build a CFP (Call for Proposal) message.
   */
  buildCFP(
    conversationId: string,
    receiverPubkey: string,
    offer: OfferContent,
    ttlSeconds: number = 300
  ): NegotiationMessage {
    return this.buildMessage(
      conversationId,
      undefined,
      receiverPubkey,
      Performative.CFP,
      { offer, ttl_seconds: ttlSeconds }
    );
  }

  /**
   * Build a PROPOSE message in response to a CFP.
   */
  buildProposal(
    conversationId: string,
    inReplyTo: string,
    receiverPubkey: string,
    offer: OfferContent,
    reasoning?: string
  ): NegotiationMessage {
    return this.buildMessage(
      conversationId,
      inReplyTo,
      receiverPubkey,
      Performative.PROPOSE,
      { offer, reasoning }
    );
  }

  /**
   * Build a COUNTER_OFFER message.
   */
  buildCounterOffer(
    conversationId: string,
    inReplyTo: string,
    receiverPubkey: string,
    offer: OfferContent,
    reasoning?: string
  ): NegotiationMessage {
    return this.buildMessage(
      conversationId,
      inReplyTo,
      receiverPubkey,
      Performative.COUNTER_OFFER,
      { offer, reasoning }
    );
  }

  /**
   * Build an ACCEPT_PROPOSAL message.
   * Includes a deal_id: SHA-256 hash of the agreed terms for on-chain anchoring.
   */
  buildAccept(
    conversationId: string,
    inReplyTo: string,
    receiverPubkey: string,
    agreedOffer: OfferContent
  ): NegotiationMessage {
    const dealId = this.computeDealId(agreedOffer);

    return this.buildMessage(
      conversationId,
      inReplyTo,
      receiverPubkey,
      Performative.ACCEPT_PROPOSAL,
      { offer: agreedOffer, deal_id: dealId }
    );
  }

  /**
   * Build a REJECT_PROPOSAL message.
   */
  buildReject(
    conversationId: string,
    inReplyTo: string,
    receiverPubkey: string,
    reasoning: string,
    errorCode?: string
  ): NegotiationMessage {
    return this.buildMessage(
      conversationId,
      inReplyTo,
      receiverPubkey,
      Performative.REJECT_PROPOSAL,
      {
        offer: { give_asset: '', give_amount: 0, take_asset: '', take_amount: 0 },
        reasoning,
        error_code: errorCode,
      }
    );
  }

  /**
   * Compute a deterministic deal_id from agreed terms.
   * deal_id = hex(SHA-256(canonical JSON of offer))
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
   * Verify the gateway_signature on a received message.
   */
  static verifyMessageSignature(
    message: NegotiationMessage,
    senderPubkey: Uint8Array
  ): boolean {
    const contentHash = sha256Hash(
      new TextEncoder().encode(JSON.stringify(message.content))
    );

    const { ed25519Verify } = require('../crypto');
    return ed25519Verify(
      hexToBytes(message.envelope.gateway_signature),
      contentHash,
      senderPubkey
    );
  }

  // ============================================================
  // Private Helpers
  // ============================================================

  private buildMessage(
    conversationId: string,
    inReplyTo: string | undefined,
    receiverPubkey: string,
    performative: Performative,
    content: NegotiationMessageContent
  ): NegotiationMessage {
    // Sign the content with the gateway's Solana key
    const contentJson = JSON.stringify(content);
    const contentHash = sha256Hash(new TextEncoder().encode(contentJson));
    const signature = ed25519Sign(contentHash, this.gatewaySecretKey);

    const envelope: MessageEnvelope = {
      message_id: `msg-${uuidv4().slice(0, 8)}`,
      conversation_id: conversationId,
      ...(inReplyTo ? { in_reply_to: inReplyTo } : {}),
      sender: this.gatewayPubkeyHex,
      receiver: receiverPubkey,
      performative,
      timestamp: new Date().toISOString(),
      gateway_signature: bytesToHex(signature),
    };

    return { envelope, content };
  }
}
