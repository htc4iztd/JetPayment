# JetPayment 競合環境分析レポート

**調査日:** 2026年3月29日

---

## 1. エグゼクティブサマリー

AIエージェント間決済・商取引プロトコルの分野は、2025年後半〜2026年にかけて急速に拡大している。Google、Stripe/OpenAI、Coinbase、Solana Foundation等の大手プレイヤーがオープンソースプロトコルを公開し、エコシステムが形成されつつある。

**JetPaymentの独自ポジション:** Discovery（発見）+ P2P Negotiation（交渉）+ On-chain Settlement（オンチェーン決済）を統合的にカバーする唯一のOSSとして差別化が可能。ただし、大手プロトコル間の収束リスク（A2A + x402 + AP2統合）が中期的な脅威となる。

---

## 2. プロトコル別マッピング

JetPaymentが提供する機能を3層に分解し、既存OSSとの対応関係を整理する。

| レイヤー | JetPayment | 主要な競合OSS |
|---|---|---|
| **Discovery（発見）** | IDiscoveryService / Moltbook SNS | Google A2A Agent Cards, Agent Discovery Protocol |
| **Negotiation（交渉）** | FIPA ACL ステートマシン | ANEX (FIPA-based), ACP capability negotiation, UCP |
| **Settlement（決済）** | Solana Anchor PDA エスクロー | x402, AP2, ERC-8183, Kamiyo Protocol, MPP |

**JetPaymentは3層すべてを単一スタックで統合する唯一のOSSである。**

---

## 3. 主要競合プロジェクト一覧

### 3.1 Tier S: メガプラットフォーム（10,000+ stars）

| プロジェクト | Stars | 提供元 | 概要 | JetPaymentとの関係 |
|---|---|---|---|---|
| [Google A2A](https://github.com/a2aproject/A2A) | ~22,800 | Google / Linux Foundation | エージェント間通信の標準プロトコル（Agent Cards, JSON-RPC 2.0, Task lifecycle） | 通信層の競合。決済機能なし。`protocol-a2a`パッケージで互換予定 |

### 3.2 Tier A: 大手主導プロトコル（1,000〜10,000 stars）

| プロジェクト | Stars | 提供元 | 概要 | JetPaymentとの関係 |
|---|---|---|---|---|
| [Coinbase x402](https://github.com/coinbase/x402) | ~5,400 | Coinbase | HTTP 402ベースのステーブルコインマイクロ決済 | 決済層の競合。交渉機能なし |
| [Google AP2](https://github.com/google-agentic-commerce/AP2) | ~2,900 | Google | VDC（Verifiable Digital Credentials）による決済認可 | 決済認可層の競合。フィアット向け |
| [Google UCP](https://github.com/Universal-Commerce-Protocol/ucp) | ~2,500 | Google | ユニバーサル商取引プロトコル（REST + JSON-RPC） | 商取引全体のフレームワーク競合 |
| [Fetch.ai uAgents](https://github.com/fetchai/uAgents) | ~1,600 | Fetch.ai | 分散型エージェントフレームワーク（Python） | エージェントフレームワーク競合。決済交渉なし |
| [SendAI Solana Agent Kit](https://github.com/sendaifun/solana-agent-kit) | ~1,600 | SendAI | SolanaプロトコルへのAIエージェント接続キット | Solanaツールキット。交渉・ディスカバリーなし |
| [Stripe/OpenAI ACP](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol) | ~1,300 | OpenAI + Stripe | エージェント→マーチャント間の購買プロトコル | B2C商取引。`protocol-stripe`で互換予定 |
| [Stripe AI Toolkit](https://github.com/stripe/ai) | ~1,400 | Stripe | Stripe API統合ツールキット（MCP対応） | 決済ツールキット。プロトコルではない |

### 3.3 Tier B: 中規模プロジェクト（100〜1,000 stars）

| プロジェクト | Stars | 提供元 | 概要 | JetPaymentとの関係 |
|---|---|---|---|---|
| [A2A x402 Extension](https://github.com/google-agentic-commerce/a2a-x402) | ~480 | Google Agentic Commerce | A2AプロトコルにHTTP 402暗号決済を追加 | A2A+x402統合の先行事例 |
| [MoonPay OWS](https://github.com/user/open-wallet-standard) | 新規(3/23公開) | MoonPay | AIエージェント向けウォレット標準 | ウォレット層。補完的 |
| [PayPal Agent Toolkit](https://github.com/paypal/agent-toolkit) | ~140 | PayPal | PayPal API統合ツールキット | 決済ツールキット |

### 3.4 Tier C: 直接競合（機能重複が最も大きいプロジェクト）

| プロジェクト | Stars | 概要 | 差分 |
|---|---|---|---|
| [Kamiyo Protocol](https://github.com/kamiyo-ai/kamiyo-protocol) | 少数 | Solanaエスクロー + Oracle投票 + 品質評価 | 交渉エンジンなし。x402特化。Go-to-market段階 |
| [ANEX](https://github.com/ammonhaggerty/ANEX) | ~2 | FIPA ACLベースのエージェント交渉プロトコル | ブロックチェーン決済なし。MVP/仕様段階 |
| [Nevermined Payments](https://github.com/nevermined-io/payments) | ~13 | AIエージェント向け決済ライブラリ（Stripe + Crypto） | サブスクリプション型。自律交渉なし |

### 3.5 新興標準（GitHub外だが重要）

| 標準 | ステータス | 概要 | JetPaymentへの影響 |
|---|---|---|---|
| **ERC-8183** | Draft (2026/2) | Ethereum上のAIエージェント向けプログラマブルエスクロー | 決済層の標準化脅威。Client→Provider→Evaluatorのジョブ構造 |
| **ERC-8004** | 進行中 | AIエージェントのID・レピュテーション標準 | ディスカバリー層と補完的 |
| **Solana MPP SDK** | 開発中 | Machine Payments Protocol（Stripe + Tempo提案） | Solana決済層の標準化。50+サービスで実装済み |
| **Open Agent Protocol (OAP)** | 初期段階 | AI-to-AI経済の信頼レイヤー（OAEP + OACP） | 長期的なプロトコル標準化の脅威 |

---

## 4. 機能比較マトリクス

| 機能 | JetPayment | A2A | x402 | AP2 | ACP | UCP | Kamiyo | ANEX |
|---|---|---|---|---|---|---|---|---|
| エージェント発見 | ✅ | ✅ | - | - | - | ✅ | - | - |
| P2P交渉 | ✅ (FIPA ACL) | - | - | - | △ | △ | - | ✅ (FIPA ACL) |
| オンチェーン決済 | ✅ (Solana) | - | ✅ | - | - | - | ✅ (Solana) | - |
| フィアット決済 | - | - | - | ✅ | ✅ (Stripe) | ✅ | - | - |
| エスクロー | ✅ (PDA) | - | - | - | - | - | ✅ | - |
| ポリシーエンジン | ✅ (5段階) | - | - | ✅ (VDC) | - | - | - | - |
| E2E暗号化通信 | ✅ (Noise XX) | - | - | - | - | - | - | - |
| プラグイン可能 | ✅ (IDiscoveryService) | ✅ | ✅ | ✅ | ✅ | ✅ | - | - |

---

## 5. 脅威分析

### 5.1 短期リスク（0〜6ヶ月）

| リスク | 深刻度 | 説明 |
|---|---|---|
| MPP SDK普及 | 🟡 中 | Solana Foundation公式の決済標準。50+サービスが既に実装。JetPaymentの決済層が取り残される可能性 |
| ERC-8183標準化 | 🟡 中 | Ethereum系でのエスクロー標準が固まると、JetPaymentのSolanaエスクロー実装がニッチ化 |

### 5.2 中期リスク（6〜18ヶ月）

| リスク | 深刻度 | 説明 |
|---|---|---|
| A2A + x402 + AP2 収束 | 🔴 高 | Google Agentic Commerceが3プロトコルを統合した場合、JetPaymentの統合価値が低下 |
| UCP拡大 | 🟡 中 | Google + Shopify + Walmart等の大手が推すUCPが商取引標準になった場合 |
| ACP市場支配 | 🟡 中 | OpenAI ChatGPT + Stripe決済という圧倒的な配信力 |

### 5.3 長期リスク（18ヶ月〜）

| リスク | 深刻度 | 説明 |
|---|---|---|
| OAP等のメタ標準 | 🟢 低 | まだ初期段階だが、全体を包括する標準が出現する可能性 |

---

## 6. JetPaymentの差別化要因

### 6.1 現在の独自価値

1. **統合スタック**: Discovery → Negotiation → Settlement を単一ライブラリで提供する唯一のOSS
2. **自律交渉エンジン**: FIPA ACLステートマシンによる価格交渉・反対提案をサポート（ANEXはブロックチェーン決済なし、ACP/UCPの交渉は限定的）
3. **Defense-in-Depth PolicyEngine**: 5段階セーフティチェック（オンチェーン署名前の多層検証）
4. **E2E暗号化P2P通信**: Noise XXプロトコルによるエージェント間の暗号化チャネル（他のプロトコルはHTTPベース）
5. **プラグイン可能アーキテクチャ**: `IDiscoveryService`インターフェースにより、ディスカバリー手段を差し替え可能

### 6.2 差別化が弱い領域

1. **Solanaのみの決済**: x402やERC-8183がマルチチェーン対応を進める中、単一チェーンはリスク
2. **フィアット非対応**: AP2/ACP/UCPがStripe/Visa/Mastercard連携済み
3. **コミュニティ規模**: stars 0 vs 大手プロトコル数千〜数万

---

## 7. 戦略的提言

### 7.1 即座に取り組むべき施策

| 施策 | 理由 | 難易度 |
|---|---|---|
| **x402プロバイダー統合** | HTTP 402対応を追加し、x402エコシステムの50+サービスへアクセス可能にする | 中 |
| **MPP SDK対応** | Solana Foundation公式の決済レールに乗る。JetPaymentの決済層をMPP互換にする | 中 |
| **A2A Agent Card対応** | `protocol-a2a`パッケージを実装し、A2Aエコシステムからの発見を可能にする | 高 |

### 7.2 中期的に取り組むべき施策

| 施策 | 理由 | 難易度 |
|---|---|---|
| **ERC-8183互換エスクロー** | EthereumのJob構造との互換レイヤーを提供し、マルチチェーン化 | 高 |
| **UCP Capability Profile対応** | UCP標準のビジネスプロファイルを通じた発見を可能にする | 中 |
| **「交渉」の標準化提案** | 他のプロトコルに欠けている交渉レイヤーをRFC/EIPとして提案し、業界標準化を主導 | 高 |

### 7.3 差別化を最大化する戦略

> **「Autonomous Negotiation Layer」としてのポジショニング**
>
> 大手プロトコル（A2A, x402, AP2, UCP）はいずれも **交渉（Negotiation）** を十分にカバーしていない。
> JetPaymentを「あらゆる決済プロトコルの上に載せる交渉ミドルウェア」として再定義することで、
> 競合ではなく補完的な存在にポジショニングできる。
>
> ```
> ┌─────────────────────────────────────────────┐
> │              AI Agent (LLM)                  │
> ├─────────────────────────────────────────────┤
> │         JetPayment Negotiation Layer         │  ← 独自価値
> │   (FIPA ACL + PolicyEngine + E2E暗号化)     │
> ├──────────┬──────────┬──────────┬────────────┤
> │   A2A    │   x402   │   AP2   │    UCP     │  ← 既存プロトコル
> │ Discovery│ Payment  │ AuthZ   │  Commerce  │
> └──────────┴──────────┴──────────┴────────────┘
> ```

---

## 8. 市場データ

- AIエージェントセクター市場規模: **$5.1B (2025) → $55.2B (2035)** 予測
- オンチェーンAIエージェントウォレット数: **340,000+ (2026 Q1)**
- エージェンティック商取引コンバージョン率: **15-30%**（従来Eコマースの5〜10倍）
- Virtuals Protocol: ERC-8183以前に **$3M+のエージェント間取引**（3,400+エージェント、エスクロー無し）
- エージェンティック商取引YoY成長: **+805%**（Adobe, Black Friday 2025）

---

## 9. 結論

JetPaymentは「自律交渉型エージェント間商取引」という独自のニッチを確保している。直接競合は極めて少なく（Kamiyo: 交渉なし、ANEX: 決済なし、Nevermined: 自律交渉なし）、統合スタックとしての価値は唯一無二である。

最大の脅威は、大手プロトコル間の収束（A2A + x402 + AP2 → Google Agentic Commerce統合）であり、これに対する最善の戦略は **交渉レイヤーの標準化を主導** し、JetPaymentを各プロトコルの上に載る **ミドルウェア** としてポジショニングすることである。

---

## Sources

- [Google A2A](https://github.com/a2aproject/A2A)
- [Coinbase x402](https://github.com/coinbase/x402)
- [Google AP2](https://github.com/google-agentic-commerce/AP2)
- [Google UCP](https://github.com/Universal-Commerce-Protocol/ucp)
- [Stripe/OpenAI ACP](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol)
- [Stripe AI Toolkit](https://github.com/stripe/ai)
- [Fetch.ai uAgents](https://github.com/fetchai/uAgents)
- [SendAI Solana Agent Kit](https://github.com/sendaifun/solana-agent-kit)
- [A2A x402 Extension](https://github.com/google-agentic-commerce/a2a-x402)
- [PayPal Agent Toolkit](https://github.com/paypal/agent-toolkit)
- [Kamiyo Protocol](https://github.com/kamiyo-ai/kamiyo-protocol)
- [ANEX](https://github.com/ammonhaggerty/ANEX)
- [Nevermined Payments](https://github.com/nevermined-io/payments)
- [Solana MPP SDK](https://github.com/solana-foundation/mpp-sdk)
- [MoonPay OWS](https://www.moonpay.com/newsroom/open-wallet-standard)
- [ERC-8183 解説](https://www.ccn.com/education/crypto/erc-8183-programmable-escrow-ai-agents-ethereum-how-it-works/)
- [Open Agent Protocol](https://www.oap.foundation/en/)
- [Kamiyo.ai](https://www.kamiyo.ai/)
