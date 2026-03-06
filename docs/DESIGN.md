# JetPayment 詳細設計書

## 1. プロジェクト概要

**JetPayment** は、自律AIエージェントがMoltbook SNS上で相互に取引を発見・交渉・決済するためのハイブリッド決済アーキテクチャである。

オフチェーン（P2P交渉）とオンチェーン（Solanaエスクロー）を組み合わせることで、ブロックチェーンのガスコストを最小化しつつ、アトミックスワップによる決済保証を実現する。

```
総コード量: 6,921行 (TypeScript)
テスト数:   69件 (全パス)
ファイル数: 29 (.ts)
```

---

## 2. アーキテクチャ全体図

```
┌─────────────────────────────────────────────────────────────────┐
│                        AI Agent (LLM)                           │
│                  Function Calling Interface                     │
│            initiate_deal / evaluate_proposal / sign_transaction │
└─────────────────────┬───────────────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────────────┐
│                    JetPaymentGateway                            │
│                   (src/gateway/gateway.ts)                      │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐ │
│  │ PolicyEngine │  │ Event Router │  │ Session ↔ Conversation│ │
│  │ Defense-in-  │  │              │  │ Mapping               │ │
│  │ Depth        │  │              │  │                       │ │
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
│Molt-│ │ Noise XX │ │ State    │ │ Escrow PDA   │  │
│book │ │ Token    │ │ Machine  │ │ Atomic Swap  │  │
│ API │ │ Verify   │ │          │ │              │  │
└─────┘ └──────────┘ └──────────┘ └──────────────┘  │
                                                     │
  ┌──────────────────────────────────────────────────┘
  │ Crypto Layer (src/crypto/)
  │ Ed25519↔X25519 | ECIES | AES-256-GCM | HKDF
  └──────────────────────────────────────────────
```

---

## 3. コアモジュール詳細 (src/)

### 3.1 暗号化レイヤー — `src/crypto/index.ts` (257行)

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

### 3.2 ディスカバリーレイヤー — `src/discovery/index.ts` (267行)

Moltbook SNSをシグナリングレイヤーとして利用し、エージェント間のP2P接続を確立する。

**クラス:** `DiscoveryService`

| メソッド | 動作 |
|----------|------|
| `createInvitation(targetPubkey, multiaddr)` | ターゲットのEd25519公開鍵でECIES暗号化した接続情報を生成 |
| `decryptInvitation(invitation)` | 自分のEd25519秘密鍵で復号 + TTL検証 |
| `serializeInvitation()` | `EncryptedInvitation` → Base64 JSON (`{c, e, n, t, v}`) |
| `deserializeInvitation()` | Base64 → `EncryptedInvitation` (プロトコルバージョン検証付き) |
| `publishInvitation(handle, invitation)` | Moltbook API `POST /api/v1/posts` で招待投稿 |
| `startPolling()` / `checkMentions()` | `GET /api/v1/mentions` で受信招待をポーリング検出 |

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

**Moltbook投稿形式:**
```
@target-agent 🔐 <Base64({c: AES暗号文, e: エフェメラル公開鍵, n: nonce, t: authTag, v: 1})>
```

---

### 3.3 セキュアP2Pレイヤー — `src/p2p/index.ts` (309行)

ディール毎にエフェメラルLibp2pノードを生成し、安全な通信チャネルを確立する。

**クラス:** `P2PService`

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
       │  [Moltbook経由で招待送信]              │
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

### 3.4 交渉エンジン — `src/negotiation/` (668行)

FIPA ACL (Foundation for Intelligent Physical Agents - Agent Communication Language) に準拠した構造化メッセージングによるオフチェーン交渉。

#### 3.4.1 状態マシン — `state-machine.ts` (190行)

**クラス:** `NegotiationStateMachine`

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

#### 3.4.2 メッセージビルダー — `message-builder.ts` (190行)

**クラス:** `MessageBuilder`

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

**署名プロセス:** `content` → JSON文字列化 → SHA-256ハッシュ → Ed25519署名 → `gateway_signature` フィールドに格納。

#### 3.4.3 交渉エンジン — `engine.ts` (287行)

**クラス:** `NegotiationEngine` (extends `EventEmitter`)

オーケストレーター。状態マシンとメッセージビルダーを統合し、AIエージェントに対してFunction Callingインターフェースを提供する。

| メソッド | 用途 |
|----------|------|
| `startNegotiation(responder, offer, myPubkey)` | CFP送信で交渉開始 |
| `handleIncomingMessage(message)` | 受信メッセージ処理 + 状態遷移 |
| `respond(conversationId, decision, counterTerms?, reasoning?)` | エージェントの意思決定を実行 |
| `getSession()` / `getActiveSessions()` | セッション情報取得 |
| `terminateSession(conversationId, reason)` | 強制終了 (サーキットブレーカー) |

**イベント:** `negotiation_started`, `cfp_received`, `proposal_received`, `deal_accepted`, `deal_rejected`, `session_timeout`, `message_sent`, `error`

**TTL管理:** 各セッションに `setTimeout` を設定。`sessionTtlSeconds` 経過後に自動タイムアウト。

---

### 3.5 ポリシーエンジン — `src/gateway/policy-engine.ts` (220行)

**Defense-in-Depth (多層防御)** — AIエージェント（LLM）を「信頼されないリクエスター」として扱い、オンチェーン署名前に5段階の安全検証を実行する。

**クラス:** `PolicyEngine`

```
AI Agent の決定
      │
      ▼
┌─────────────────────────────────────────┐
│          PolicyEngine.validateTransaction()          │
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

### 3.6 決済レイヤー — `src/settlement/index.ts` (461行)

Solanaブロックチェーン上でのエスクロー型アトミックスワップ。

**クラス:** `SettlementService`

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

**オンチェーンイベント監視:** `connection.onAccountChange(dealPDA)` でDealRecordのstatusバイトを監視。`status=1` (Completed) または `status=2` (Cancelled) を検出してイベント発行。

**セキュリティ:** 全トークン移転に `transfer_checked` を使用し、spoofed token攻撃を防止。

---

### 3.7 ゲートウェイ — `src/gateway/gateway.ts` (462行)

**クラス:** `JetPaymentGateway` (extends `EventEmitter`)

4つのフェーズを統合するメインオーケストレーター。AIエージェントに3つのFunction Callingツールを公開。

**Function Calling Interface:**

| ツール | パラメータ | 処理フロー |
|--------|-----------|-----------|
| `initiate_deal` | `targetId`, `initialTerms` | エフェメラルP2Pノード作成 → 暗号化招待 → Moltbook投稿 → CFP送信 |
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

### 3.8 型定義 — `src/types/index.ts` (221行)

全モジュール共通の型定義。4フェーズ + ゲートウェイポリシー + Function Callingインターフェースをカバー。

| カテゴリ | 主要な型 |
|----------|---------|
| Phase 1 Discovery | `EncryptedInvitation`, `ConnectionInfo` |
| Phase 2 P2P | `PeerConnectionState` (enum: 6状態), `PeerSession` |
| Phase 3 Negotiation | `Performative` (enum: 5種), `NegotiationState` (enum: 10状態), `MessageEnvelope`, `OfferContent`, `NegotiationMessage`, `NegotiationSession` |
| Phase 4 Settlement | `DealStatus` (enum: 3状態), `DealRecord`, `SettlementResult` |
| Policy | `GatewayPolicy`, `SafetyCheckResult` |
| Agent API | `InitiateDealParams`, `EvaluateProposalParams`, `SignTransactionParams`, `GatewayEvent` (enum: 10種), `GatewayEventPayload` |

---

## 4. テストエージェントシステム (agents/)

### 4.1 ベースエージェント — `agents/base/index.ts` (353行)

**クラス:** `BaseAgent` (abstract, extends `EventEmitter`)

全テストエージェントの基底クラス。以下を提供:

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

**AgentProfile 設定:**
```typescript
{
  name: string,
  role: 'buyer' | 'seller',
  personality: string,         // システムプロンプト的な性格記述
  budget: number,              // 予算上限 (base units)
  priceLimit: number,          // 価格上限/下限
  aggressiveness: number,      // 0.0 (受動的) ～ 1.0 (攻撃的)
  maxCounterOffers: number     // カウンター回数上限
}
```

---

### 4.2 BuyerAgent — `agents/buyer/index.ts` (181行)

データ/API/NFT を購入する自律エージェント。

**交渉戦略:**

| フェーズ | 戦略 | 計算式 |
|----------|------|--------|
| 初期入札 | アンカリングバイアス | `startRatio = 0.4 + aggressiveness × 0.3` → maxPriceの40-70% |
| カウンター | 漸減増分 (Diminishing Increment) | `closeFraction = 0.2 + aggressiveness × 0.4` → ギャップの20-60%を毎ラウンド埋める |
| 受諾条件 | seller提示価格 ≤ priceLimit | 即座にACCEPT |
| 拒否条件 | seller提示価格 > budget | 即座にREJECT |
| 最終オファー | counterPrice ≥ priceLimit | priceLimitちょうどでCOUNTER (最終提示) |

**例 (aggressiveness=0.5, maxPrice=200 USDC):**
```
Round 0: 初期入札 = 200 × 0.55 = 110 USDC
Round 1: seller提示 300 → gap=190 → increment=190×0.4=76 → 186 USDC
Round 2: seller提示 250 → gap=64 → increment=64×0.4=25.6 → 200 USDC (上限到達 → ACCEPT)
```

---

### 4.3 SellerAgent — `agents/seller/index.ts` (185行)

データ資産を販売する自律エージェント。

**交渉戦略:**

| フェーズ | 戦略 | 計算式 |
|----------|------|--------|
| 初期価格 | コンストラクタで設定 | `initialAsk` (例: 300 USDC) |
| 譲歩 (Concession) | フロア価格までの差分の一定割合 | `concessionRate = 0.4 - aggressiveness × 0.25` |
| 受諾条件1 | buyerの入札 ≥ 現在のasking price | 即座にACCEPT |
| 受諾条件2 | buyerの入札 ≥ floor かつ gapRatio < 5% | 「十分近い」としてACCEPT |
| 拒否条件 | buyerの入札 < floor × 0.5 | 「まともな提示ではない」としてREJECT |

**例 (aggressiveness=0.5, floor=100, initialAsk=300):**
```
                                   concessionRate = 0.4 - 0.5×0.25 = 0.275
Round 0: ask = 300
Round 1: gapToFloor = 200 → concession = 200×0.275 = 55 → ask = 245
Round 2: gapToFloor = 145 → concession = 145×0.275 = 39.9 → ask = 205.1
Round 3: gapToFloor = 105 → concession = 105×0.275 = 28.9 → ask = 176.2
```

---

### 4.4 Moltbookシミュレーター — `agents/moltbook-sim/index.ts` (167行)

**クラス:** `MoltbookSimulator`

ローカルテスト用のインメモリMoltbook SNSモック。

| 機能 | 説明 |
|------|------|
| `createPost()` | 投稿作成、`@mention` 自動抽出、イベント発行 |
| `getMentions(handle, type?)` | ハンドル宛メンション検索 (タイプフィルター付き) |
| `getTimeline()` / `printTimeline()` | 全投稿の時系列表示 |
| `registerAgent(handle, pubkey)` | エージェント登録 |
| `on('mention:${handle}')` | メンション通知イベント |

---

### 4.5 本番Moltbook APIクライアント — `agents/moltbook-live/` (768行)

実際のMoltbook API (`https://www.moltbook.com/api/v1`) と通信するためのアダプター。

#### 4.5.1 MoltbookClient — `client.ts` (316行)

型付きHTTPクライアント。全エンドポイント対応。

| エンドポイント | メソッド | レート制限 |
|---------------|---------|-----------|
| `POST /agents/register` | `register()` | — |
| `GET /agents/me` | `getMe()` | 100/min |
| `POST /posts` | `createPost()` | **1/30min** |
| `GET /posts` | `getPosts()` | 100/min |
| `POST /posts/:id/comments` | `addComment()` | 50/hour |
| `GET /posts/:id/comments` | `getComments()` | 100/min |
| `GET /search` | `search()` | 100/min |
| `POST /submolts` | `createSubmolt()` | — |
| `POST /submolts/:name/subscribe` | `subscribe()` | — |
| `GET /feed` | `getFeed()` | 100/min |

**レート制限管理:** `X-RateLimit-Limit/Remaining/Reset` ヘッダーを自動追跡。`canPost()` / `secondsUntilCanPost()` で投稿可否を事前確認。

**エラー型:** `MoltbookApiError` (一般), `MoltbookRateLimitError` (429, `retryAfterSeconds` 付き)

#### 4.5.2 MoltbookDiscoveryAdapter — `adapter.ts` (448行)

**クラス:** `MoltbookDiscoveryAdapter`

`DiscoveryService` の設計を実APIに適応。

**招待配信戦略:**
```
PRIMARY:  POST /posts → s/jetpayment submolt
          Title: "🔐 @target-agent"
          Body:  Base64 ECIES invitation

FALLBACK: POST /posts/:id/comments (投稿レート制限時)
          検索で対象エージェントの最新投稿を探してコメント
```

**招待検出 (ポーリング):**
```
Method 1: GET /posts?submolt=jetpayment&sort=new → @自分名でフィルター
Method 2: GET /search?q=🔐+@自分名 → コメント内の招待も検出
```

**暗号処理:** `DiscoveryService` と同一の ECIES + シリアライゼーションを内蔵。鍵変換・暗号化の互換性を保証。

---

### 4.6 シナリオ実行システム — `agents/scenarios/` (907行)

#### 交渉シミュレーター — `negotiation-sim.ts` (353行)

**関数:** `runScenario(config: ScenarioConfig): Promise<ScenarioResult>`

| フェーズ | 実行内容 |
|----------|---------|
| Phase 1 | ECIES暗号化招待の生成・復号検証 |
| Phase 2 | P2Pチャネル確立 (シミュレート) |
| Phase 3 | Buyer/Seller間のFIPA ACLメッセージ交換ループ |
| Phase 4 | 決済シミュレーション (PDA seeds, deal_id表示) |

#### プリセットシナリオ — `run-all.ts` (232行)

| # | シナリオ | Buyer設定 | Seller設定 | 期待結果 |
|---|---------|----------|-----------|---------|
| 1 | Fair Market | max=200, agg=0.5 | floor=100, ask=300, agg=0.5 | ACCEPTED ~176 USDC |
| 2 | Tough Negotiation | max=80, agg=0.8 | floor=50, ask=120, agg=0.9 | ACCEPTED 80 USDC, 8ラウンド |
| 3 | No Deal Zone | max=30 | floor=80 | REJECTED |
| 4 | Quick Accept | max=250, agg=0.9 | floor=50, ask=180, agg=0.2 | ACCEPTED ~134 USDC, 1ラウンド |
| 5 | Symmetric | max=150, agg=0.5 | floor=50, ask=250, agg=0.5 | ACCEPTED ~126 USDC |

#### 本番実行スクリプト — `run-live.ts` (322行)

`.env` からAPIキーを読み込み、実際のMoltbook APIに対して招待投稿・復号・交渉・決済レシート投稿を実行。

---

## 5. テストスイート (tests/)

| テストファイル | テスト数 | 対象 |
|---------------|---------|------|
| `crypto.test.ts` (179行) | — | Ed25519↔X25519変換, ECIES暗復号, セッショントークン, 署名検証, Noise鍵バインド |
| `discovery.test.ts` (129行) | — | 招待作成・復号・シリアライズ・TTL検証, Moltbook投稿フォーマット |
| `negotiation.test.ts` (353行) | — | 状態マシン遷移 (有効/無効), メッセージビルダー, deal_id算出, サーキットブレーカー |
| `agents.test.ts` (400行) | — | BuyerAgent戦略, SellerAgent戦略, E2Eネゴシエーション (4パターン), MoltbookSimulator |
| `moltbook-live.test.ts` (302行) | — | MoltbookClient API呼び出し形式, レート制限追跡, DiscoveryAdapter暗号化/配信/フォールバック |
| **合計** | **69件** | **全パス** |

---

## 6. セキュリティ設計

### 6.1 脅威モデル

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

### 6.2 鍵管理

```
Solana Keypair (Ed25519)
  ├── 署名用: メッセージ認証, Noise鍵バインド, トランザクション署名
  └── 鍵交換用: Ed25519→X25519 変換 → ECIES (ECDH + AES-256-GCM)

エフェメラル鍵 (X25519)
  └── ECIES暗号化時に毎回生成 → 共有秘密導出後に破棄
```

---

## 7. 依存関係

| パッケージ | バージョン | 用途 |
|-----------|-----------|------|
| `@noble/curves` | ^1.8.1 | Ed25519, X25519 (監査済み純TS) |
| `@noble/hashes` | ^1.7.1 | SHA-256, SHA-512, HKDF |
| `@noble/ciphers` | (peer) | AES-256-GCM |
| `@solana/web3.js` | ^1.98.0 | Solana RPC, トランザクション構築 |
| `@solana/spl-token` | ^0.4.12 | SPLトークン操作 |
| `@coral-xyz/anchor` | ^0.30.1 | Anchor IDL互換 |
| `libp2p` | ^2.8.2 | P2Pネットワーキング |
| `@chainsafe/libp2p-noise` | ^16.1.0 | Noise XXプロトコル |
| `@libp2p/tcp` | ^10.1.4 | TCPトランスポート |
| `uuid` | ^11.1.0 | メッセージID / セッションID |

---

## 8. 実行コマンド一覧

| コマンド | 説明 |
|----------|------|
| `npm test` | 全69テスト実行 |
| `npm run test:agents` | エージェントテストのみ |
| `npm run sim` | ローカル5シナリオシミュレーション |
| `npm run sim:scenario 2` | 特定シナリオ実行 (1-5) |
| `npm run sim:live` | 本番Moltbook API接続テスト (.env 必要) |
| `npm run build` | TypeScriptコンパイル |

---

## 9. 未実装・制限事項

| 項目 | 現状 | 備考 |
|------|------|------|
| Solanaプログラム (Anchor) | インストラクション構築のみ | Program IDはプレースホルダー |
| 本番Moltbook接続 | コード完成、未実行 | 環境のネットワーク制限によりAPI到達不可 |
| Solana devnetテスト | 未実施 | RPC接続可能な環境で実行可能 |
| WebSocket P2P | TCP のみ | `@libp2p/websockets` は依存に含む |
| マルチエージェント同時実行 | 未実装 | 現状は1対1のみ |
