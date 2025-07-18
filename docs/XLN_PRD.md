# Overview

XLN (Extended Lightning Network) is a **Layer‑2 payment protocol** built around **hierarchical, actor‑inspired state machines**. It removes the inbound‑liquidity, throughput, and governance limitations of today’s Lightning‑style networks and makes **instant, low‑fee, cross‑chain payments** viable for consumers, merchants, hub operators, and developers.

- **Problem solved:** Traditional payment rails are costly and slow; current Layer‑2 solutions still demand full collateral, complex channel management, and suffer frequent failures.
- **Target users:** Exchange and wallet operators, on‑line merchants, remittance providers, DeFi projects, and end users who want dependable crypto payments.
- **Value:** Up to 10 000 TPS, sub‑second finality, 80 % lower capital lock‑up, deterministic auditing, and seamless multi‑currency support.

---

# Core Features

| Feature                                  | What it Does                                                    | Why it’s Important                                                                | How it Works (High Level)                                                                          |
| ---------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **1. Credit‑Line Channels**              | Let payees receive funds without pre‑funded inbound capacity.   | Eliminates the single biggest UX barrier in LN; boosts payment success to 99.9 %. | Per‑entity risk scoring, on‑chain collateral ceilings, automatic limit adjustments.                |
| **2. Fractional‑Reserve Hubs**           | Allow hubs to custody only a fraction of aggregate balances.    | Frees >80 % of locked capital, improving liquidity and hub ROI.                   | Merkle‑root proof‑of‑reserve snapshots plus dispute contracts enforcing solvency.                  |
| **3. Cross‑Jurisdictional Atomic Swaps** | Enable trust‑less exchange of assets across chains.             | Unlocks global payments and liquidity routing.                                    | 8‑bit HTLC (256 granules) with one‑and‑a‑half‑round‑trip completion and timeout reverts.           |
| **4. Hierarchical State Machines**       | Isolate logic into Server → Signer → Entity → Channel layers.   | Guarantees determinism, simplifies auditing, and enables horizontal sharding.     | Each machine has `txInbox`/`txOutbox` + `eventInbox`/`eventOutbox`; Merkle snapshots every 100 ms. |
| **5. Deterministic Binary Persistence**  | Serialises all state to byte‑exact buffers for hashing/storage. | Ensures identical hashes across Bun, Node, and browser nodes.                     | `msgpackr` record mode + persisted structure tables, stored in LevelDB.                            |
| **6. Multi‑Asset Liquidity Pools**       | Support ERC‑20/721/1155 tokens and native coins in one balance. | Merchants accept any token; hubs earn conversion/spread.                          | Token‑abstraction layer + micro‑AMMs, price‑fed by oracles (Chainlink, etc.).                      |
| **7. Developer & Ops Tooling**           | SDKs, WebSockets, time‑machine debugger, CLI wallet.            | Lowers integration barrier; eases ops & compliance.                               | Typed TS SDK, sandbox test‑net, hierarchical state visualiser, Grafana‑ready metrics.              |

---

# User Experience

### User Personas

1. **Hub Operator** – Liquidity provider seeking capital efficiency and risk automation.
2. **Merchant** – Online business needing near‑certain payment success and low fees.
3. **End User / Remitter** – Wants instant, multi‑currency transfers with consumer‑grade UX.
4. **Developer / Integrator** – Embeds payments in apps via SDK/APIs.
5. **Compliance Officer** – Audits reserves, AML/KYC events, and governance logs.

### Key User Flows

- **Wallet Onboarding (End User):** Download → mnemonic / hardware‑wallet connect → credit line auto‑granted → ready to receive.
- **Payment (User → Merchant):** User signs tx → routed through hubs in ≤ 1 s → merchant sees fiat/tokens post‑conversion.
- **Swap (Cross‑Chain):** User selects asset‑out → protocol builds 8‑bit HTLC → atomic completion or rollback.
- **Hub Reserve Audit:** Operator publishes Merkle snapshot → anyone verifies proof against Depository contract.
- **Developer Integration:** Install SDK → create Entity → subscribe to balances/events over WebSocket → launch app.

### UI/UX Considerations

- “Bank‑app” dashboards: balances, credit limit, spend/receive graphs.
- Real‑time toasts for confirm/fail; deterministic fee quotes.
- Time‑travel slider in dev console to replay state per block.
- Accessibility: keyboard navigation, high‑contrast themes, localisation strings.

---

# Technical Architecture

### System Components

- **Server (root machine):** Aggregates messages every 100 ms; forms Merkle‑root blocks; routes inter‑server traffic.
- **Signer:** Holds private keys; validates Entity proposals; signs blocks; lightweight KV.
- **Entity:** Business‑logic sandbox (wallet, DAO, hub). Multi‑sig quorum, proposal engine, two‑tier Tx flow.
- **Channel:** Bilateral mirror ledger; cooperative or disputed updates; balance plus commitments.
- **Depository.sol:** Reserve ledger, channel dispute adjudication, HTLC executor, proof‑of‑reserve anchor.
- **Web/API Layer:** REST & WebSocket gateways, TypeScript SDK, Svelte front‑end.

### Data Models (TypeScript RO‑RO shape)

```ts
type Entity = {
  id: string;
  boardHash: string;
  tokenAddr: string;
  createdAt: number;
};
type Account = {
  id: string;
  entityId: string;
  balances: Record<tokenId, bigint>;
  credit: { limit: bigint; used: bigint };
  debts: Debt[];
};
type Channel = {
  id: string;
  partA: string;
  partB: string;
  nonce: number;
  collateral: Record<tokenId, bigint>;
  disputeHash?: string;
};
type Transaction = {
  id: string;
  from: string;
  to: string;
  amount: bigint;
  tokenId: number;
  nonce: number;
  status: "pending" | "final";
};
```

### APIs & Integrations

- **REST** (`/api/v1/`): entity CRUD, account ops (deposit/withdraw), tx submit, swap, governance.
- **WebSocket:** balance updates, network metrics, governance events.
- **Bridges:** ETH (native & tokens), BTC/LN, Polygon, BSC via standard adapter interface.
- **Oracles:** Chainlink feeds (price, gas), fallback aggregation.
- **Wallets:** MetaMask, WalletConnect, Ledger/Trezor, mobile signer.

### Infrastructure Requirements

- **Runtime:** Bun for server/back‑end; same code transpiled for browser (Svelte PWA).
- **Storage:** LevelDB (or RocksDB in prod) with `valueEncoding:'view'`; 100 GB RAM node supports 10 M channels.
- **Serialization:** `msgpackr` Packr instance, `useRecords:true`, shared structure table persisted each block.
- **Hashing & Signatures:** SHA‑256 for Merkle roots; ECDSA/BLS for tx + multi‑sig; future aggregated BLS.
- **Observability:** Prometheus metrics, OpenTelemetry traces, Grafana dashboards, Loki log aggregation.

---

# Development Roadmap

> _No calendar dates—scope only._

### Phase 1 · Foundation (MVP)

- Deterministic persistence layer (`msgpackr`, LevelDB, snapshot manager).
- Single‑asset credit‑line channels (ETH).
- Depository.sol v1 (reserve, channel dispute).
- Server/Signer/Entity machines + CLI wallet.
- REST endpoints + minimal WebSocket stream.
- Svelte demo wallet with send/receive.

### Phase 2 · Core Payments & Governance

- Multi‑sig Entity proposals, weighted BFT quorum.
- Fractional‑reserve proof system + Merkle snapshot verifier.
- Multi‑asset ledger (ERC‑20/721/1155).
- Svelte merchant plug‑in (checkout widget).
- SDKs (TS, Python) + sandbox test‑net.

### Phase 3 · Cross‑Chain & Liquidity

- 8‑bit HTLC contract + chain adapters (BTC, Polygon, BSC).
- AMM micro‑pools for on‑the‑fly asset conversion.
- Fee‑market routing heuristics.
- Governance token & proposal voting UI.
- Compliance hooks: audit trail export, AML/KYC API.

### Phase 4 · Scalability & Enterprise

- Entity‑ID sharding; horizontal Server clusters.
- HSM integration, hardware‑based signing.
- High‑volume batch endpoints, reporting APIs.
- Zero‑knowledge log compression (research track).
- Disaster‑recovery tooling, on‑prem install option.

---

# Logical Dependency Chain

1. **Deterministic Storage & Hashing** →
2. **Core Channel & Payment Flow (single asset)** →
3. **On‑chain Dispute Contract** →
4. **Entity Governance (multi‑sig, proposals)** →
5. **Multi‑Asset Ledger** →
6. **Fractional‑Reserve Proofs** →
7. **Cross‑Chain HTLC & Adapters** →
8. **Liquidity Pools & AMMs** →
9. **Compliance, Scaling, Enterprise Tooling**

Each milestone is an atomic deliverable that runs end‑to‑end and becomes the base for the next layer.

---

# Risks and Mitigations

| Risk Category                  | Potential Issue                                        | Mitigation Strategy                                                                                |
| ------------------------------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| **Determinism**                | Byte output drifts between runtimes → consensus break. | Strict `msgpackr` record mode, persist structure tables, cross‑node fuzz tests per commit.         |
| **Credit Line Abuse**          | User defaults, hub insolvency.                         | Real‑time risk scoring, collateral ceilings, automatic debt claw‑backs, on‑chain liquidation path. |
| **Cross‑Chain Bridge Exploit** | Asset loss via bridge vulnerability.                   | Minimal trusted surface (HTLC), audited adapter code, timeout failsafes, insurance fund.           |
| **Over‑scoping MVP**           | Delayed usability release.                             | Must/Should/Could tagging, bi‑weekly scope review, enforce Phase‑1 minimal UI.                     |
| **Smart‑Contract Bugs**        | Critical fund loss.                                    | Formal verification + multi‑round external audits; bug‑bounty pre‑main‑net.                        |
| **Regulatory Shift**           | New rules on custody / KYC.                            | Pluggable compliance layer, jurisdiction‑based policy engine.                                      |
| **Resource Constraints**       | High RAM requirement on small nodes.                   | Configurable snapshot depth, pruning, RocksDB option, light‑client mode.                           |

---

# Appendix

- **Research Sources** – XLN design notes, Merkle Tree spec (1 Mar), compiled documentation, Meeting 8 reflections.
- **Existing Code** – `server.ts` (Bun event loop), legacy Solidity contracts (Depository, EntityProvider, SubcontractProvider).
- **Serialization Decision Log** – Evaluated RLP vs CBOR vs MessagePack; chose `msgpackr` for record determinism and speed.
- **Merkle Proof Format** – `sha256(pack(state))`, root stored in LevelDB under block hash; proofs include sibling path and snapshot height.
- **Testing Harness** – Bun test runner with Typia for run‑time type assertions, property‑based fuzzing for consensus equivalence.
- **Future Research** – Aggregated BLS signatures for block voting; ZK‑SNARK compression of event logs; optimistic roll‑up settlement layer.
