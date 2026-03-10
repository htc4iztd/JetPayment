# JetPayment 詳細設計書

## 1. プロジェクト概要

**JetPayment** は、自律AIエージェント間の決済を可能にするマルチプロトコル対応の決済ゲートウェイである。

特定のSNSプラットフォームや決済レールに依存せず、プラグイン可能なアーキテクチャにより、異なるディスカバリー手段（Moltbook、Webhook、DHT等）、交渉プロトコル（FIPA ACL、A2A Task、Stripe ACP等）、決済手段（Solana、Stripe PaymentIntent等）を差し替え・組み合わせ可能にする。

```
総コード量: ~7,500行 (TypeScript)
テスト数:   69件 (全パス)
構造:       モノレポ (packages/core + packages/protocol-native)
```

---

## 2. アーキテクチャ全体図

### 2.1 モノレポ構造

```
jetpayment/
├── packages/
│   ├── core/                           @jetpayment/core
│   │   └── src/
│   │       ├── types/index.ts          全型定義 + IDiscoveryService interface
│   │       ├── crypto/index.ts         ECIES, Ed25519, signing ユーティリティ
│   │       └── policy/policy-engine.ts PolicyEngine (Defense-in-Depth)
│   │
│   ├── protocol-native/               @jetpayment/protocol-native
│   │   └── src/
│   │       ├── discovery/              Moltbook SNS + BaseDiscoveryProvider
│   │       ├── p2p/                    Libp2p Noise XX
│   │       ├── negotiation/            FIPA ACL state machine
│   │       ├── settlement/             Solana Anchor PDA escrow
│   │       └── gateway/               オーケストレーター
│   │
│   ├── protocol-a2a/                   (予定) Google A2A互換
│   └── protocol-stripe/               (予定) Stripe ACP互換
│
├── src/                                後方互換 re-export shim
├── agents/                             テストエージェント
└── tests/                              テストスイート
```

### 2.2 レイヤー図

```
┌─────────────────────────────────────────────────────────────────┐
│                        AI Agent (LLM)                           │
│                  Function Calling Interface                     │
│            initiate_deal / evaluate_proposal / sign_transaction │
└─────────────────────┬───────────────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────────────┐
│                    JetPaymentGateway                            │
│             (protocol-native/gateway/gateway.ts)                │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐ │
│  │ PolicyEngine │  │ Event Router │  │ Session ↔ Conversation│ │
│  │ @core        │  │              │  │ Mapping               │ │
│  └──────┬───────┘  └──────────────┘  └───────────────────────┘ │
└─────────┼──────────────────────────────────────────────────────┘
          │
  ┌───────┼──────────────────────────────────────────┐
  │       │                                          │
  ▼       ▼              ▼                ▼          │
┌─────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐  │
│Phase│ │  Phase 2  │ │ Phase 3  │ │   Phase 4    │  │
│  1  │ │ Secure   │ │ Off-chain│ │  On-chain    │  │
│Disc-│ │   P2P    │ │ Negoti-  │ │ Settlement   │  │
│overy│ │          │ │ ation    │ │              │  │
│     │ │ Libp2p   │ │ FIPA ACL │ │ Solana       │  │
│ I   │ │ Noise XX │ │ State    │ │ Escrow PDA   │  │
│Disc-│ │ Token    │ │ Machine  │ │ Atomic Swap  │  │
│overy│ │ Verify   │ │          │ │              │  │
│Svc  │ │          │ │          │ │              │  │
└─────┘ └──────────┘ └──────────┘ └──────────────┘  │
                                                     │
  ┌──────────────────────────────────────────────────┘
  │ @jetpayment/core
  │ Crypto: Ed25519↔X25519 | ECIES | AES-256-GCM | HKDF
  │ Types:  IDiscoveryService | EncryptedInvitation | ...
  │ Policy: PolicyEngine (Defense-in-Depth)
  └──────────────────────────────────────────────
```

### 2.3 設計哲学: Core + Adapters

各レイヤーの責務を「共通化すべきもの」と「プロトコル固有のもの」に明確に分離する。

**@jetpayment/core (共通基盤):**
- 暗号ユーティリティ（ECIES, Ed25519, signing, hashing）— 全プロトコルで共通
- PolicyEngine（金額上限、レート制限、human-in-the-loop閾値）— 決済手段に依存しない安全制御
- 型定義（IDiscoveryService, OfferContent, DealRecord等）— プロトコル間の共通語彙
- Function Calling tool定義 — AIエージェントSDK向けの統一インターフェース

**プロトコル固有パッケージ (例: protocol-native):**
- トランスポート実装 — libp2p / HTTP JSON-RPC / HTTPS REST は本質的に異なる
- 決済ロジック — Solana escrow / Stripe PaymentIntent / AP2 Mandate は異なるモデル
- ネゴシエーション状態機械 — FIPA ACL / A2A Task lifecycle / Stripe Checkout は異なる遷移

**共通化しない理由:** 最小公倍数APIは各プロトコルの強みを消す。例えばSolanaのatomic escrowとStripeのPaymentIntentは概念が全く違い、`pay(amount)` レベルまで薄めると意味をなさない。

---

## 3. @jetpayment/core 詳細

### 3.1 暗号化レイヤー — `core/src/crypto/index.ts`

Solanaウォレットの Ed25519 鍵を汎用暗号に転用するための変換・暗号化ユーティリティ。

| 関数 | 目的 |
|------|------|
| `ed25519PubkeyToX25519()` | Ed25519公開鍵 → X25519 (ECDH用)。Birational map: `u = (1+y)/(1-y) mod p` |
| `ed25519SecretToX25519()` | Ed25519秘密鍵 → X25519。SHA-512ハッシュ + RFC 7748クランピング |
| `eciesEncrypt()` | ECIES暗号化。エフェメラルX25519 → ECDH → HKDF-SHA256 → AES-256-GCM |
| `eciesDecrypt()` | ECIES復号。受信者のX25519秘密鍵でECDH → 同じ導出 → AES-GCM復号 |
| `generateSessionToken()` | CSPRNG 256bit トークン (ファーストパケット検証用) |
| `ed25519Sign()` / `ed25519Verify()` | Ed25519署名・検証 (メッセージ認証用) |
| `signNoiseStaticKey()` | Noise静的鍵をSolanaウォレットで署名 (mTLS的アイデンティティバインド) |
| `sha256Hash()` | SHA-256 (deal_id算出等) |

**暗号パイプライン:**
```
Solana Ed25519 Keypair
        │
        ├─→ Ed25519→X25519 変換 (鍵交換用)
        │        │
        │        └─→ ECIES: エフェメラルECDH → HKDF → AES-256-GCM
        │
        ├─→ Ed25519 署名 (メッセージ認証、Noise鍵バインド)
        │
        └─→ SHA-256 (deal_id = hash(canonical_offer_json))
```

**依存ライブラリ:** `@noble/curves`, `@noble/hashes`, `@noble/ciphers` (全て監査済み純TypeScript実装)

---

### 3.2 型定義 — `core/src/types/index.ts`

全パッケージ共通の型定義。プロバイダーインターフェース + 4フェーズ + ゲートウェイポリシー + Function Callingインターフェースをカバー。

| カテゴリ | 主要な型 |
|----------|---------|
| **Discovery Interface** | `IDiscoveryService` (汎用インターフェース), `DiscoveryProviderConfig` |
| Phase 1 Discovery | `EncryptedInvitation`, `ConnectionInfo` |
| Phase 2 P2P | `PeerConnectionState` (enum: 6状態), `PeerSession` |
| Phase 3 Negotiation | `Performative` (enum: 5種), `NegotiationState` (enum: 10状態), `MessageEnvelope`, `OfferContent`, `NegotiationMessage`, `NegotiationSession` |
| Phase 4 Settlement | `DealStatus` (enum: 3状態), `DealRecord`, `SettlementResult` |
| Policy | `GatewayPolicy`, `SafetyCheckResult` |
| Agent API | `InitiateDealParams`, `EvaluateProposalParams`, `SignTransactionParams`, `GatewayEvent` (enum: 10種), `GatewayEventPayload` |

#### IDiscoveryService インターフェース

Discovery層のプラグイン可能性を実現する汎用インターフェース:

```typescript
interface IDiscoveryService {
  createInvitation(targetPubkey, multiaddr): { invitation, connectionInfo };
  decryptInvitation(invitation): ConnectionInfo;
  serializeInvitation(invitation): string;
  deserializeInvitation(encoded): EncryptedInvitation;
  publishInvitation(targetHandle, invitation): Promise<string>;
  startPolling(): void;
  stopPolling(): void;
  destroy(): void;
  on(event, listener): this;
  emit(event, ...args): boolean;
}
```

任意のシグナリングバックエンド（Moltbook、Webhook、DHT、直接接続等）が本インターフェースを実装することで、Discovery providerとして利用可能。

---

### 3.3 ポリシーエンジン — `core/src/policy/policy-engine.ts`

**Defense-in-Depth (多層防御)** — AIエージェント（LLM）を「信頼されないリクエスター」として扱い、オンチェーン署名前に5段階の安全検証を実行する。

```
AI Agent の決定
      │
      ▼
┌─────────────────────────────────────────┐
│     PolicyEngine.validateTransaction()  │
│                                         │
│  Check 1: Blast Radius Containment      │  ← 取引額上限 (maxTransactionAmount)
│  Check 2: Asset Whitelist               │  ← 許可トークンmint一覧
│  Check 3: Deterministic Validation      │  ← deal_idハッシュ整合性 (対ハルシネーション)
│  Check 4: Rate Limiting                 │  ← 分あたり取引数制限
│  Check 5: Human Approval Threshold      │  ← 高額取引は人間承認必須
│                                         │
│  全チェック通過 → approved: true        │
│  いずれか失敗 → approved: false + 理由  │
└─────────────────────────────────────────┘
      │
      ▼
  秘密鍵による署名 → オンチェーン実行
```

**Check 3 (Deterministic Validation) の詳細:**
LLMのハルシネーション対策。`sign_transaction` で渡されたオファー条件のSHA-256ハッシュを、交渉履歴上の合意条件のハッシュと比較。不一致の場合は「hallucination or tampering」として拒否。

**デフォルトポリシー値:**
```typescript
{
  maxTransactionAmount: 1_000_000_000n,  // 1000 USDC
  allowedAssets: [],                      // 明示的設定必須
  maxNegotiationRounds: 20,
  maxDealsPerMinute: 5,
  humanApprovalThreshold: 500_000_000n,   // 500 USDC以上は人間承認
  sessionTtlSeconds: 300                  // 5分
}
```

---

## 4. @jetpayment/protocol-native 詳細

JetPaymentのネイティブプロトコル実装。Moltbook SNSディスカバリー + libp2p P2P + FIPA ACL交渉 + Solanaエスクロー決済。

### 4.1 ディスカバリーレイヤー — `protocol-native/src/discovery/`

#### BaseDiscoveryProvider — `base.ts`

トランスポート非依存の暗号操作ベースクラス。`IDiscoveryService` を実装し、ECIES暗号化/復号/シリアライゼーションの共通ロジックを提供する。

サブクラスは以下を実装するだけでDiscovery providerとして機能する:
- `publishInvitation()` — シグナリングチャネルへの招待投稿
- `startPolling()` / `stopPolling()` — 受信招待のリスニング

#### MoltbookDiscoveryProvider — `index.ts`

`BaseDiscoveryProvider` を継承し、Moltbook SNSをシグナリングレイヤーとして利用する実装。

| メソッド | 動作 |
|----------|------|
| `createInvitation(targetPubkey, multiaddr)` | (継承) ターゲットのEd25519公開鍵でECIES暗号化した接続情報を生成 |
| `decryptInvitation(invitation)` | (継承) 自分のEd25519秘密鍵で復号 + TTL検証 |
| `serializeInvitation()` | (継承) `EncryptedInvitation` → Base64 JSON (`{c, e, n, t, v}`) |
| `deserializeInvitation()` | (継承) Base64 → `EncryptedInvitation` (プロトコルバージョン検証付き) |
| `publishInvitation(handle, invitation)` | Moltbook API `POST /api/v1/posts` で招待投稿 |
| `startPolling()` / `checkMentions()` | `GET /api/v1/mentions` で受信招待をポーリング検出 |

**クラス階層:**
```
IDiscoveryService (interface)     ← @jetpayment/core
    │
    └── BaseDiscoveryProvider     ← 暗号操作の共通ベース
            │
            ├── MoltbookDiscoveryProvider   ← Moltbook SNS (現在の実装)
            ├── WebhookDiscoveryProvider    ← (将来) Webhook/REST
            └── DHTDiscoveryProvider        ← (将来) 分散ハッシュテーブル
```

**招待ペイロード構造 (暗号化前):**
```json
{
  "multiaddr": "/ip4/192.168.1.1/tcp/50775/p2p/QmXxx...",
  "sessionToken": "a3f7...64文字hex",
  "initiatorPubkey": "ed25519公開鍵hex",
  "createdAt": 1709700000000,
  "ttlSeconds": 300
}
```

**MoltbookConfig:**
```typescript
interface MoltbookConfig {
  apiBaseUrl: string;      // Moltbook API URL
  agentHandle: string;     // エージェントのハンドル名
  apiToken: string;        // API認証トークン
  pollIntervalMs: number;  // ポーリング間隔
}
```

---

### 4.2 セキュアP2Pレイヤー — `protocol-native/src/p2p/index.ts`

ディール毎にエフェメラルLibp2pノードを生成し、安全な通信チャネルを確立する。

**プロトコル定義:**
```
/jetpayment/token-verify/1.0.0  — ファーストパケットトークン検証
/jetpayment/negotiation/1.0.0   — 交渉メッセージストリーム
```

**接続フロー:**
```
Initiator (Agent A)                    Responder (Agent B)
       │                                       │
       │  createEphemeralNode(sessionToken)     │
       │  ← Libp2pノード起動 (TCP + Yamux + Noise) │
       │                                       │
       │  [シグナリング経由で招待送信]          │
       │─────────────────────────────────────→  │
       │                                       │  connectToAgent(multiaddr, token)
       │                                       │
       │  ← TOKEN_VERIFY_PROTOCOL ────────────  │
       │  トークン検証 → "TOKEN_OK" ACK         │
       │                                       │
       │  ← Noise XX ハンドシェイク ──────────  │
       │  (トランスポートレベルで自動実行)       │
       │                                       │
       │  ← NEGOTIATION_PROTOCOL ─────────────  │
       │  双方向メッセージストリーム確立         │
```

**設計上の特徴:**
- **エフェメラルノード**: 各ディールで新規ノード生成 → 終了後破棄 (フィンガープリント防止)
- **ファーストパケット検証**: CSPRNG トークンで不正接続を即座にブロック
- **Noise XX**: 双方向認証付き暗号化 (Libp2p標準)
- **セッション管理**: `Map<sessionId, Libp2p>` で複数同時ディール対応

---

### 4.3 交渉エンジン — `protocol-native/src/negotiation/`

FIPA ACL (Foundation for Intelligent Physical Agents - Agent Communication Language) に準拠した構造化メッセージングによるオフチェーン交渉。

#### 4.3.1 状態マシン — `state-machine.ts`

```
状態遷移図:

  IDLE ──CFP送信──→ CFP_SENT ──受信PROPOSE──→ PROPOSAL_RECEIVED
                        │                          │
                        ├──受信COUNTER──→ COUNTER_RECEIVED ←──┐
                        │                     │    │          │
                        └──受信REJECT──→ REJECTED  │          │
                                              │    │          │
                                    ACCEPT送信─┘  COUNTER送信─┘
                                        │
                                        ▼
                                    ACCEPTED

  (どの非終端状態からも TIMED_OUT へ遷移可能 — タイムアウト/サーキットブレーカー)
```

**終端状態:** `ACCEPTED`, `REJECTED`, `TIMED_OUT`

**遷移テーブル:** 21パターンの有効遷移を `Record<string, NegotiationState>` で管理。無効な遷移は `InvalidTransitionError` を投げる。

**サーキットブレーカー:** `currentRound >= maxRounds` で自動的に `TIMED_OUT` へ遷移。

#### 4.3.2 メッセージビルダー — `message-builder.ts`

各FIPA ACLパフォーマティブに対応するメッセージを構築:

| メソッド | パフォーマティブ | 用途 |
|----------|-----------------|------|
| `buildCFP()` | `CFP` | 取引提案の募集 (Call for Proposal) |
| `buildProposal()` | `PROPOSE` | CFPへの提案回答 |
| `buildCounterOffer()` | `COUNTER_OFFER` | カウンターオファー |
| `buildAccept()` | `ACCEPT_PROPOSAL` | 提案受諾 + deal_id算出 |
| `buildReject()` | `REJECT_PROPOSAL` | 提案拒否 |

**メッセージ構造:**
```json
{
  "envelope": {
    "message_id": "msg-a1b2c3d4",
    "conversation_id": "conv-e5f6g7h8",
    "in_reply_to": "msg-previous",
    "sender": "送信者Ed25519公開鍵hex",
    "receiver": "受信者Ed25519公開鍵hex",
    "performative": "COUNTER_OFFER",
    "timestamp": "2026-03-06T12:00:00.000Z",
    "gateway_signature": "Ed25519署名hex"
  },
  "content": {
    "offer": {
      "give_asset": "トークンmintアドレス",
      "give_amount": 150000000,
      "take_asset": "トークンmintアドレス",
      "take_amount": 1
    },
    "reasoning": "Countering with 150 USDC",
    "deal_id": "SHA-256(canonical offer JSON)",
    "ttl_seconds": 300
  }
}
```

#### 4.3.3 交渉エンジン — `engine.ts`

オーケストレーター。状態マシンとメッセージビルダーを統合し、AIエージェントに対してFunction Callingインターフェースを提供する。

| メソッド | 用途 |
|----------|------|
| `startNegotiation(responder, offer, myPubkey)` | CFP送信で交渉開始 |
| `handleIncomingMessage(message)` | 受信メッセージ処理 + 状態遷移 |
| `respond(conversationId, decision, counterTerms?, reasoning?)` | エージェントの意思決定を実行 |
| `getSession()` / `getActiveSessions()` | セッション情報取得 |
| `terminateSession(conversationId, reason)` | 強制終了 (サーキットブレーカー) |

**イベント:** `negotiation_started`, `cfp_received`, `proposal_received`, `deal_accepted`, `deal_rejected`, `session_timeout`, `message_sent`, `error`

---

### 4.4 決済レイヤー — `protocol-native/src/settlement/index.ts`

Solanaブロックチェーン上でのエスクロー型アトミックスワップ。

**PDA導出:**
```
Seeds: ["offer", initiator_pubkey, deal_id_bytes]
Program: JETPAY111111111111111111111111111111111111111
```

**3つのオンチェーン操作:**

| 操作 | 呼び出し者 | 説明 |
|------|-----------|------|
| `initializeDeal()` | Initiator (Agent A) | トークンをPDAエスクロー口座にロック。Vault作成 + `transfer_checked` |
| `executeDeal()` | Responder (Agent B) | アトミックスワップ実行。双方のトークン移転を1トランザクションで |
| `cancelDeal()` | Initiator (Agent A) | デッドライン経過後にエスクローからトークン回収 |

**Discriminator体系:**
```
initialize_deal: 0x4A455450415900 01
execute_deal:    0x4A455450415900 02
cancel_deal:     0x4A455450415900 03
("JETPAY\0" + 操作番号)
```

---

### 4.5 ゲートウェイ — `protocol-native/src/gateway/gateway.ts`

4つのフェーズを統合するメインオーケストレーター。AIエージェントに3つのFunction Callingツールを公開。

**JetPaymentConfig:**
```typescript
interface JetPaymentConfig {
  discoveryProvider?: IDiscoveryService;  // 任意のDiscovery provider
  moltbook?: MoltbookConfig;              // 後方互換 (MoltbookDiscoveryProviderを自動生成)
  p2p: P2PConfig;
  settlement: SettlementConfig;
  policy: GatewayPolicy;
}
```

`discoveryProvider` が渡されればそれを使用し、なければ `moltbook` configから `MoltbookDiscoveryProvider` を自動生成する。これにより、任意の `IDiscoveryService` 実装を差し替えて利用可能。

**Function Calling Interface:**

| ツール | パラメータ | 処理フロー |
|--------|-----------|-----------|
| `initiate_deal` | `targetId`, `initialTerms` | エフェメラルP2Pノード作成 → 暗号化招待 → シグナリング投稿 → CFP送信 |
| `evaluate_proposal` | `sessionId`, `decision`, `counterTerms?`, `reasoning?` | サーキットブレーカー確認 → 交渉エンジン応答 → P2P送信 |
| `sign_transaction` | `sessionId`, `agreedTerms` | **PolicyEngine全チェック** → PDA導出 → `initializeDeal` 実行 |

**内部イベント配線:**
```
Discovery.invitation_received → P2P.connectToAgent()
P2P.message                   → Negotiation.handleIncomingMessage()
Negotiation.deal_accepted     → Gateway.DEAL_ACCEPTED イベント
Negotiation.deal_rejected     → Gateway.DEAL_REJECTED イベント
Settlement.on_chain_completed → セッションクリーンアップ
```

---

## 5. テストエージェントシステム (agents/)

### 5.1 ベースエージェント — `agents/base/index.ts`

**クラス:** `BaseAgent` (abstract, extends `EventEmitter`)

全テストエージェントの基底クラス。コンストラクタは `IDiscoveryService` インスタンスまたは `MoltbookConfig` を受け付ける（後方互換）。

- **Ed25519ウォレット自動生成** (`@noble/curves`)
- **NegotiationEngine統合** — 内部にエンジンインスタンスを保持
- **ポートフォリオ管理** — `AgentAsset[]` で保有トークンを追跡
- **取引履歴記録** — `completedDeals[]`
- **カウンターオファー制限** — `maxCounterOffers` 超過で自動REJECT
- **カラーログ** — `AgentLogger` (Buyer=シアン, Seller=マゼンタ)

**抽象メソッド (各エージェントが実装):**
```typescript
abstract evaluateProposal(conversationId, message): NegotiationDecision;
abstract generateInitialOffer(targetAsset): OfferContent;
```

---

### 5.2 BuyerAgent — `agents/buyer/index.ts`

データ/API/NFT を購入する自律エージェント。

**交渉戦略:**

| フェーズ | 戦略 | 計算式 |
|----------|------|--------|
| 初期入札 | アンカリングバイアス | `startRatio = 0.4 + aggressiveness × 0.3` → maxPriceの40-70% |
| カウンター | 漸減増分 (Diminishing Increment) | `closeFraction = 0.2 + aggressiveness × 0.4` → ギャップの20-60%を毎ラウンド埋める |
| 受諾条件 | seller提示価格 ≤ priceLimit | 即座にACCEPT |
| 拒否条件 | seller提示価格 > budget | 即座にREJECT |
| 最終オファー | counterPrice ≥ priceLimit | priceLimitちょうどでCOUNTER (最終提示) |

---

### 5.3 SellerAgent — `agents/seller/index.ts`

データ資産を販売する自律エージェント。

**交渉戦略:**

| フェーズ | 戦略 | 計算式 |
|----------|------|--------|
| 初期価格 | コンストラクタで設定 | `initialAsk` (例: 300 USDC) |
| 譲歩 (Concession) | フロア価格までの差分の一定割合 | `concessionRate = 0.4 - aggressiveness × 0.25` |
| 受諾条件1 | buyerの入札 ≥ 現在のasking price | 即座にACCEPT |
| 受諾条件2 | buyerの入札 ≥ floor かつ gapRatio < 5% | 「十分近い」としてACCEPT |
| 拒否条件 | buyerの入札 < floor × 0.5 | 「まともな提示ではない」としてREJECT |

---

### 5.4 Moltbookシミュレーター — `agents/moltbook-sim/index.ts`

ローカルテスト用のインメモリMoltbook SNSモック。

| 機能 | 説明 |
|------|------|
| `createPost()` | 投稿作成、`@mention` 自動抽出、イベント発行 |
| `getMentions(handle, type?)` | ハンドル宛メンション検索 (タイプフィルター付き) |
| `getTimeline()` / `printTimeline()` | 全投稿の時系列表示 |
| `registerAgent(handle, pubkey)` | エージェント登録 |

---

### 5.5 本番Moltbook APIクライアント — `agents/moltbook-live/`

実際のMoltbook API と通信するためのアダプター。

#### MoltbookClient — `client.ts`

型付きHTTPクライアント。全エンドポイント対応 + レート制限自動追跡。

#### MoltbookDiscoveryAdapter — `adapter.ts`

`BaseDiscoveryProvider` 同等の設計を実APIに適応。

**招待配信戦略:**
```
PRIMARY:  POST /posts → s/jetpayment submolt
FALLBACK: POST /posts/:id/comments (投稿レート制限時)
```

---

### 5.6 シナリオ実行システム — `agents/scenarios/`

| # | シナリオ | 期待結果 |
|---|---------|---------|
| 1 | Fair Market (Buyer max=200, Seller floor=100) | ACCEPTED ~176 USDC |
| 2 | Tough Negotiation (高aggressiveness) | ACCEPTED 80 USDC, 8ラウンド |
| 3 | No Deal Zone (Buyer max < Seller floor) | REJECTED |
| 4 | Quick Accept (低Seller aggressiveness) | ACCEPTED ~134 USDC, 1ラウンド |
| 5 | Symmetric (均等パラメータ) | ACCEPTED ~126 USDC |

---

## 6. テストスイート (tests/)

| テストファイル | 対象 |
|---------------|------|
| `crypto.test.ts` | Ed25519↔X25519変換, ECIES暗復号, セッショントークン, 署名検証, Noise鍵バインド |
| `discovery.test.ts` | 招待作成・復号・シリアライズ・TTL検証 (後方互換DiscoveryServiceエイリアス経由) |
| `negotiation.test.ts` | 状態マシン遷移 (有効/無効), メッセージビルダー, deal_id算出, サーキットブレーカー |
| `agents.test.ts` | BuyerAgent戦略, SellerAgent戦略, E2Eネゴシエーション (4パターン), MoltbookSimulator |
| `moltbook-live.test.ts` | MoltbookClient API呼び出し形式, レート制限追跡, DiscoveryAdapter暗号化/配信/フォールバック |
| **合計** | **69件 全パス** |

---

## 7. セキュリティ設計

### 7.1 脅威モデル

| 脅威 | 対策 |
|------|------|
| LLMハルシネーション (不正な取引条件) | PolicyEngine Check 3: deal_idハッシュ照合 |
| 無制限の資金流出 | Blast Radius Containment (取引額上限) |
| 暴走ループ (無限カウンター) | サーキットブレーカー (maxNegotiationRounds) + レート制限 |
| 中間者攻撃 (P2P) | ECIES暗号化招待 + Noise XXハンドシェイク |
| 不正ノード接続 | ファーストパケットトークン検証 (CSPRNG 256bit) |
| Spoofed Token攻撃 | `transfer_checked` による mint/decimals 検証 |
| 高額取引の無承認実行 | Human Approval Threshold (デフォルト 500 USDC) |
| ノードフィンガープリント | エフェメラルLibp2pノード (ディール毎に生成・破棄) |

### 7.2 鍵管理

```
Solana Keypair (Ed25519)
  ├── 署名用: メッセージ認証, Noise鍵バインド, トランザクション署名
  └── 鍵交換用: Ed25519→X25519 変換 → ECIES (ECDH + AES-256-GCM)

エフェメラル鍵 (X25519)
  └── ECIES暗号化時に毎回生成 → 共有秘密導出後に破棄
```

---

## 8. マルチプロトコル対応ロードマップ

### 8.1 現在の対応状況

| レイヤー | protocol-native | 抽象化状態 |
|---|---|---|
| Discovery | Moltbook SNS | **抽象化済** (IDiscoveryService + BaseDiscoveryProvider) |
| Transport | libp2p TCP/Noise XX | 未抽象化 (protocol-native固有) |
| Negotiation | FIPA ACL | 未抽象化 (protocol-native固有) |
| Settlement | Solana Anchor PDA | 未抽象化 (protocol-native固有) |

### 8.2 業界プロトコルとの比較

| | protocol-native | Google A2A | Stripe ACP |
|---|---|---|---|
| 信頼モデル | Trustless (暗号検証) | Server trust (OAuth) | Platform trust (Stripe) |
| 通信 | P2P direct (libp2p) | Client-Server (HTTP JSON-RPC) | Client-Server (HTTPS REST) |
| 決済 | On-chain escrow (Solana) | 規定なし | Stripe PaymentIntent + SPT |
| 対象 | Agent↔Agent自律取引 | Agent↔Agent汎用タスク | Agent→Merchant購買 |

### 8.3 将来のパッケージ

```
packages/
├── core/                  ✅ 完了 — 共通基盤
├── protocol-native/       ✅ 完了 — Moltbook + libp2p + FIPA ACL + Solana
├── protocol-a2a/          📋 予定 — Google A2A互換
│   ├── transport/         HTTP JSON-RPC 2.0 + SSE
│   ├── agent-card/        /.well-known/agent.json 生成・解析
│   └── task-lifecycle/    A2A Task状態マシン
└── protocol-stripe/       📋 予定 — Stripe ACP互換
    ├── checkout-flow/     Create→Update→Complete
    ├── spt/               Shared Payment Token管理
    └── mcp-server/        Stripe MCP Server統合
```

各プロトコルパッケージは `@jetpayment/core` のみに依存し、互いに独立して開発・テスト可能。

---

## 9. 依存関係

### @jetpayment/core

| パッケージ | バージョン | 用途 |
|-----------|-----------|------|
| `@noble/curves` | ^1.8.1 | Ed25519, X25519 (監査済み純TS) |
| `@noble/hashes` | ^1.7.1 | SHA-256, SHA-512, HKDF |
| `@noble/ciphers` | (peer) | AES-256-GCM |

### @jetpayment/protocol-native

| パッケージ | バージョン | 用途 |
|-----------|-----------|------|
| `@solana/web3.js` | ^1.98.0 | Solana RPC, トランザクション構築 |
| `@solana/spl-token` | ^0.4.12 | SPLトークン操作 |
| `@coral-xyz/anchor` | ^0.30.1 | Anchor IDL互換 |
| `libp2p` | ^2.8.2 | P2Pネットワーキング |
| `@chainsafe/libp2p-noise` | ^16.1.0 | Noise XXプロトコル |
| `@libp2p/tcp` | ^10.1.4 | TCPトランスポート |
| `uuid` | ^11.1.0 | メッセージID / セッションID |

---

## 10. 実行コマンド一覧

| コマンド | 説明 |
|----------|------|
| `npm test` | 全69テスト実行 |
| `npm run test:agents` | エージェントテストのみ |
| `npm run sim` | ローカル5シナリオシミュレーション |
| `npm run sim:scenario 2` | 特定シナリオ実行 (1-5) |
| `npm run sim:live` | 本番Moltbook API接続テスト (.env 必要) |
| `npm run build` | TypeScriptコンパイル (`tsc -b` プロジェクトビルド) |

---

## 11. 未実装・制限事項

| 項目 | 現状 | 備考 |
|------|------|------|
| Transport/Negotiation/Settlement抽象化 | 未実装 | protocol-native固有。各プロトコルで本質的に異なるため、共通インターフェースではなくプロトコル別パッケージで対応予定 |
| Google A2A互換 | 未実装 | packages/protocol-a2a として独立実装予定 |
| Stripe ACP互換 | 未実装 | packages/protocol-stripe として独立実装予定 |
| Agent Card (.well-known/agent.json) | 未実装 | A2Aパッケージに含める予定 |
| Solanaプログラム (Anchor) | インストラクション構築のみ | Program IDはプレースホルダー |
| WebSocket P2P | TCP のみ | `@libp2p/websockets` は依存に含む |
| マルチエージェント同時実行 | 未実装 | 現状は1対1のみ |
