### XLN Platform — Unified Technical Specification

**Version 1.4.1-RC2 · July 2025**
---

#### Table of Contents

1. Purpose & Scope
2. Design Principles
3. Layered Architecture
4. Canonical Data Model (TypeScript)
   4.1 Wire Envelope
   4.2 Consensus-level Commands
   4.3 Application Transaction
   4.4 Frame
   4.5 Entity State
   4.6 Quorum Definition
   4.7 Server-input Batch
   4.8 Server Frame
5. Consensus & Frame Lifecycle
6. Persistence, Storage & Replay
7. Hashing & Merkle Roots
8. Security Matrix
9. Scalability & Performance Targets
10. Configuration Knobs (defaults)
11. Wire-Encoding & RPC Rules
12. Edge-Cases & Known Limits
13. Clock-tick Walk-through
14. Reference Code Skeleton
15. Road-map & Milestones
16. Glossary

---


## 1. Purpose & Scope

This document merges **all authoritative fragments**—Core-Layer 0.9 draft, v3.2 edits, engineering chat distillations, and every uploaded edge-case memo—into a _single_ self-consistent specification of the **Minimal-Viable XLN network**.
_In scope:_ pure business logic of the **Server → Signer → Entity** stack, state-persistence rules, and the message/consensus flow.
_Out of scope:_ cryptography primitives, networking adapters, access-control layers, on-chain Jurisdiction (JL) details, and the future Channel layer (listed only for context).

---

## 2. Design Principles

| Principle                  | Rationale                                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Pure Functions**         | Every layer reduces `(prevState, inputBatch)` → `{nextState, outbox}`; side-effects live in thin adapters.     |
| **Fractal Interface**      | The same reducer signature repeats for Server, Entity, and—later—Channel layers, easing reasoning and testing. |
| **Local Data Sovereignty** | Each participant can keep a _full_ copy of the shards they care about; no sequencer or DA committees.          |
| **Audit-grade Replay**     | Dual snapshot + immutable CAS blobs guarantee deterministic re-execution from genesis or any checkpoint.       |
| **Linear Scalability**     | Channels (phase 2) add TPS linearly with hubs; core layers have no global bottleneck.                          |

---

## 3. Layered Architecture

| Layer                             | Pure? | Responsibility                                                                        | Key Objects                                 |
| --------------------------------- | ----- | ------------------------------------------------------------------------------------- | ------------------------------------------- |
| **Jurisdiction (JL)**             | ✘     | On-chain root of trust, collateral & dispute contracts.                               | `Depositary.sol`                            |
| **Server**                        | ✔︎   | Routes `Input` packets every tick, seals `ServerFrame`, maintains global Merkle root. | `ServerFrame`, `ServerMetaTx`, mempool      |
| **Signer slot**                   | ✔︎   | Holds _replicas_ of each Entity for which its signer is in the quorum.                | `Replica = Map<entityId, EntityState>`      |
| **Entity**                        | ✔︎   | BFT-replicated state-machine; builds & finalises `Frame`s.                            | `EntityInput`, `EntityTx`, `Frame`, `Hanko` |
| **Account / Channel** _(phase 2)_ | ✔︎   | Two-party mini-ledgers; HTLC / credit logic.                                          | `AccountProof`, sub-contracts               |

_Fractal rule:_ every layer exposes the same pure reducer interface.

---

## 4. Canonical Data Model (TypeScript-style)

```ts
/* ─── 4.1 Wire Envelope ─── */
export type Input = [
  signerIdx: number, // lexicographic index of signerId present this tick
  entityId: string, // target Entity
  cmd: Command, // consensus-level command
];

/* ─── 4.2 Consensus-level Commands ─── */
export type Command =
  | { type: "importEntity"; snapshot: EntityState }
  | { type: "addTx"; tx: EntityTx }
  // Proposer ships only the header to save bandwidth; replicas reconstruct tx list
  | { type: "proposeFrame"; header: FrameHeader }
  | { type: "signFrame"; sig: string }
  | { type: "commitFrame"; frame: Frame; hanko: string };

/* ─── 4.3 Application-level Transaction ─── */
export interface EntityTx {
  kind: string; // e.g. 'chat', 'transfer', 'jurisdictionEvent'
  data: unknown; // domain payload; must be type-checked by application logic
  nonce: bigint; // strictly increasing per-signer
  sig: string; // signer’s signature over RLP(tx)
}

/* ─── 4.4 Frame (Entity-level block) ─── */
export interface Frame {
  height: bigint; // sequential frame number
  timestamp: bigint; // unix-ms at creation (bigint for 64-bit safety)
  header: FrameHeader; // static fields hashed for propose/sign
  txs: EntityTx[]; // ordered transactions
  postStateRoot: string; // keccak256 of EntityState after txs
}

export interface FrameHeader {
  entityId: string;
  height: bigint;
  memRoot: string; // Merkle root of *sorted* tx list (see §5 Y-2 rule)
  prevStateRoot: string;
  proposer: string; // signerId that built the frame
}

/* ─── 4.5 Entity State ─── */
export interface EntityState {
  height: bigint; // last committed height
  quorum: Quorum; // active quorum
  signerRecords: Record<string, { nonce: bigint }>;
  domainState: unknown; // application domain data
  mempool: EntityTx[]; // pending txs
  proposal?: { header: FrameHeader; sigs: Record<string, string> };
}

/* ─── 4.6 Quorum Definition ─── */
export interface Quorum {
  threshold: bigint; // required weight
  members: { address: string; shares: bigint }[];
}

/* ─── 4.7 Server-input Batch ─── */
export interface ServerInput {
  inputId: string; // UID for the batch
  frameId: number; // monotone tick counter
  timestamp: bigint; // unix-ms
  metaTxs: ServerMetaTx[]; // network-wide cmds (renamed per Y-1)
  entityInputs: EntityInput[]; // per-entity signed inputs
}

export interface ServerMetaTx {
  // was ServerTx
  type: "importEntity";
  entityId: string;
  data: unknown; // snapshot / metadata
}

export interface EntityInput {
  jurisdictionId: string; // format chainId:contractAddr
  signerId: string; // BLS public key (hex)
  entityId: string;
  quorumProof: {
    quorumHash: string;
    quorumStructure: string; // reserved – must be '0x' until Phase 3
  };
  entityTxs: EntityTx[]; // includes jurisdictionEvent txs
  precommits: string[]; // BLS sigs over header hash
  proposedBlock: string; // keccak256(rlp(header ‖ txs))
  observedInbox: InboxMessage[];
  accountInputs: AccountInput[];
}

export interface InboxMessage {
  msgHash: string; // keccak256(message)
  fromEntityId: string;
  message: unknown;
}

export interface AccountInput {
  counterEntityId: string;
  channelId?: bigint; // reserved for phase 2 multi-channel support
  accountTxs: AccountTx[];
}

export interface AccountTx {
  type: "AddPaymentSubcontract";
  paymentId: string;
  amount: number;
}

/* ─── 4.8 Server Frame (global timeline) ─── */
export interface ServerFrame {
  frameId: number;
  timestamp: bigint;
  root: string; // Merkle root of replica state hashes
  inputsRoot: string; // Merkle root of RLP(ServerInput)
}
```

---

## 5. Consensus & Frame Lifecycle

1. **ADD_TX** – A signer sends an `addTx` command. The receiving replica asserts `tx.nonce === signerRecords[signerId].nonce + 1n`, then increments the local nonce for that signer before adding the transaction to its mempool.

2. **PROPOSE** – The designated proposer for the current height deterministically selects and orders transactions from its mempool.

   - **Sorting Rule (Y-2):** Transactions are sorted by **nonce → from (signerId) → kind → insertion-index**.
   - **Packing:** The proposer slices the first `MAX_TXS_PER_FRAME` transactions from the sorted list.
   - **Hashing (R-1):** It builds the `FrameHeader` and computes the hash to be signed: `proposedBlock = keccak256(rlp(header, txs))`.
   - It then emits a `proposeFrame { header }` command to its peers.

3. **SIGN** – Peer replicas receive the `proposeFrame` command. They deterministically reconstruct the exact same sorted transaction list from their own mempools, build the header, and recompute the `proposedBlock` hash. If it matches, they sign the hash and respond with a `signFrame` command.

4. **COMMIT** – The proposer collects `signFrame` responses. Once the aggregated weight of signatures meets or exceeds the quorum `threshold`, it assembles the full `Frame` (header, txs, and the final `postStateRoot`) and the aggregate BLS signature (**Hanko**). It then broadcasts the `commitFrame { frame, hanko }` command.

5. **VERIFY & APPLY** – All replicas receive the `commitFrame` and perform final verification:

   ```ts
   // Verify the integrity of the frame against the hash that was signed
   assert(keccak256(rlp(frame.header, frame.txs)) === proposedBlock);
   // Verify the aggregate signature (Hanko) against the quorum
   assert(verifyAggregate(hanko, proposedBlock, quorum) === true);
   ```

   If both checks pass, the replica applies the transactions to its state, adopts the `postStateRoot`, and clears the committed transactions from its mempool.

6. **SEAL** – The Server includes the new replica snapshot hash in its global Merkle tree and seals the `ServerFrame` for the tick.

- **Quorum validation:** Each `EntityInput` is accepted only if `quorumProof.quorumHash == keccak256(rlp(activeQuorum))`.
- **Signer ordering:** For every tick, the Server sorts **present signerIds lexicographically (lower-case hex)**; the zero-based index becomes `signerIdx` in the wire envelope, guaranteeing deterministic mapping on replay.
- **Re-proposal rule:** Any signer may re-propose an **identical tx list in identical order** after `TIMEOUT_PROPOSAL_MS` if the original proposer fails.

---

## 6. Persistence, Storage & Replay

| Store                           | Medium                | Trigger                          | Purpose                                  |
| ------------------------------- | --------------------- | -------------------------------- | ---------------------------------------- |
| **Write-Ahead Log** (`wal/`)    | LevelDB CF            | every 100 ms tick                | Crash-consistency & deterministic replay |
| **Mutable snapshot** (`state/`) | LevelDB CF            | every _N_ frames or ≥ 20 MB diff | Fast cold-start                          |
| **Immutable CAS** (`cas/`)      | LevelDB CF            | on every `commitFrame`           | Audit-grade history                      |
| **Entity Frames**               | `entity_blocks/<id>/` | on commit                        | End-user proofs                          |
| **ServerFrames**                | `server_blocks/`      | every tick                       | Global state-hash timeline               |

- **Snapshot hash** = `keccak256(rlp(entityState))` and is the leaf committed into the global Merkle tree.
- **Dual snapshot model:** Replay consists of loading the _latest snapshot_ and re-applying _all WAL segments created after the snapshot_, then verifying the final state against the global Merkle root.

**LevelDB key-scheme:** A flat 96-byte prefix = `SignerID ∥ EntityID ∥ StoreType` aligns on-disk ordering with in-memory maps, enabling efficient range scans without extra buckets. Keys are stored as `Uint8Array` for binary safety.

---

## 7. Hashing & Merkle Roots

- **Frame hash (R-1)** = `keccak256(rlp(frame.header ‖ txs))` (header first, then the RLP-encoded list of transactions). This is the hash signed by the quorum.
- **Server root** = A binary Merkle tree is computed over `[signerIdx, entityId] → rlp(snapshot)` pairs, sorted lexicographically. This root is stored in every `ServerFrame` for global state consistency and divergence detection. The Server root includes **all replicas known to the Server**; if a signer sends no inputs for a tick, the last cached snapshot hash for its replicas is reused.

---

## 8. Security Matrix

| Layer      | Honest-party assumption    | Main threats               | Mitigations                            |
| ---------- | -------------------------- | -------------------------- | -------------------------------------- |
| **Entity** | ≥ ⅔ weighted shares honest | Forged frames, vote replay | BLS aggregate check; per-signer nonce  |
| **Server** | Crash-only failures        | WAL corruption             | Hash-assert on replay                  |
| **JL**     | Single systemic contract   | Contract bug / exploit     | Formal verification (future milestone) |

_Remaining gaps (MVP):_ Signature authenticity is mocked (to be replaced with real BLS), no Byzantine detection at the Server layer, unbounded mempool, networking adapters TBD. RLP layout is considered stable to ensure historic roots remain valid.

---

## 9. Scalability & Performance Targets

| Metric               | Target                | Note                                 |
| -------------------- | --------------------- | ------------------------------------ |
| **Server tick**      | 100 ms (configurable) |                                      |
| **Off-chain TPS**    | Unbounded             | Each Entity & Channel is independent |
| **Jurisdiction TPS** | ≈ 10                  | Only deposits/disputes touch JL      |
| **Roadmap capacity** | > 10⁹ TPS             | Linear with hubs & channels          |

---

## 10. Configuration Knobs (defaults)

| Key                       | Default | Description                   |
| ------------------------- | ------- | ----------------------------- |
| `FRAME_INTERVAL_MS`       | 100     | Server tick cadence           |
| `SNAPSHOT_EVERY_N_FRAMES` | 100     | Snapshot interval             |
| `TIMEOUT_PROPOSAL_MS`     | 30,000  | Liveness guard                |
| `MAX_TXS_PER_FRAME`       | 1,000   | Soft cap for proposer packing |
| `OUTBOX_DEPTH_LIMIT`      | ∞       | Recursion guard               |

---

## 11. Wire-Encoding & RPC Rules

- **External packet** = RLP-encoded `Input` (`[signerIdx, entityId, command]`).
- The first field inside `command` is its _type_; the executor aggregates **all** packets received during the current tick into one `ServerInput` batch. Note: in JSON-RPC representations, the `metaTxs` field replaces the legacy `serverTxs` field.
- Addresses are carried in lowercase hex. Binary keys must not be used directly as keys in standard JavaScript `Map` objects due to object-identity pitfalls.
- All timestamps are **bigint unix-ms** across all data structures.

---

## 12. Edge-Cases & Known Limits

- **Binary map keys in JS:** Store as lower-case hex strings or use a custom map implementation with `Uint8Array` to avoid object-identity pitfalls.
- **Single-signer optimisation:** Still wrap self-signed transactions into frames to maintain an identical and consistent history structure.
- **Message mis-routing:** Inputs sent to an outdated proposer are queued locally and retried after a proposer rotation. For detailed retry logic, see `edge-cases.md §Y-67`.
- **Dual snapshot integrity:** A mismatch between a loaded snapshot's hash and the corresponding WAL hash will halt replay, indicating corruption.
- **Phase 2+ features:** Channels, order-book map, and insurance cascades are specified but _disabled_ until Milestone 2+.

---

## 13. Clock-tick Walk-through

An executable end-to-end example lives in `spec/walkthrough.md` and demonstrates:
`ADD_TX("hello") → propose → sign → commit → ServerFrame` evolution, with exact hashes and Merkle roots.

---

## 14. Reference Code Skeleton

_(The `applyServerFrame` function has been updated to use the new `postStateRoot` logic; the full code snippet is omitted here for brevity – see repository tag v1.4.1-RC2 for the implementation.)_

---

## 15. Road-map & Milestones

1. **M1 – “DAO-only”**
   _Entities with quorum governance, chat/wallet demo, no channels._
2. **M2 – Channel layer**
   _Bidirectional payment channels, collateral & credit logic._
3. **M3 – Hub & Order-book entities**
   _Liquidity routing, on-channel AMM snippets._
4. **M4 – Multi-jurisdiction deployment**
   _JL adapters for several L1s, fiat on/off-ramp partnerships._

---

## 16. Glossary

| Term                       | Concise definition                                                             |       |              |           |               |
| -------------------------- | ------------------------------------------------------------------------------ | ----- | ------------ | --------- | ------------- |
| **Input**                  | RLP envelope `[signerIdx, entityId, command]`                                  |       |              |           |               |
| **Command**                | \`importEntity                                                                 | addTx | proposeFrame | signFrame | commitFrame\` |
| **Transaction (EntityTx)** | Signed atomic state mutation                                                   |       |              |           |               |
| **Frame**                  | Ordered batch of txs + post-state root snapshot                                |       |              |           |               |
| **FrameHeader**            | Static fields of a Frame, hashed for propose/sign consensus                    |       |              |           |               |
| **Hanko**                  | 48-byte BLS aggregate signature proving quorum approval                        |       |              |           |               |
| **Replica**                | In-memory copy of an Entity under a specific signer                            |       |              |           |               |
| **ServerFrame**            | Global state snapshot for a tick, containing Merkle roots of states and inputs |       |              |           |               |
| **Snapshot**               | Last serialised state of every replica                                         |       |              |           |               |
| **CAS blob**               | Immutable, content-addressed store of historic frames                          |       |              |           |               |
| **Channel frame**          | Off-chain batch inside a two-party channel (phase 2)                           |       |              |           |               |
