# XLN: Cross-Local Network

A Byzantine Fault Tolerant consensus system for cross-jurisdictional off-chain settlement with on-chain anchoring.

## Table of Contents

1. [What is XLN?](#what-is-xln)
2. [Core Concepts](#core-concepts)
3. [Architecture Deep Dive](#architecture-deep-dive)
4. [Consensus Flow](#consensus-flow)
5. [Implementation Details](#implementation-details)
6. [Running the System](#running-the-system)
7. [Security Model](#security-model)
8. [Design Philosophy](#design-philosophy)

## What is XLN?

XLN (Cross-Local Network) is a consensus protocol that enables distributed entities to:

- Exchange messages and value instantly off-chain
- Achieve Byzantine fault-tolerant consensus without a blockchain
- Anchor final outcomes on-chain only when necessary
- Operate across different jurisdictions with local compliance

Think of it as a **high-speed rail system** where:

- Trains (transactions) run on local tracks (entities)
- Stations (server ticks) coordinate schedules globally
- Tickets (signatures) prove consensus among conductors
- The destination ledger (blockchain) only records arrivals

### Version 0.6 XLN Specification Compliance

This version brings the implementation into alignment with the XLN v1.4.1-RC2 specification:

- **Frame Structure Compliance**: Frames now include proper header/body structure with parentHash and proposer fields
- **BigInt Timestamps**: FrameHeader uses bigint timestamps as required by the spec
- **Transaction Sorting**: Implements spec-compliant sorting (nonce → signerId → kind)
- **Backward Compatibility**: Maintains support for legacy frame format during migration
- **84%+ Test Coverage**: Added comprehensive tests for spec compliance

### Version 0.5 Production Features

Previous implementation added critical production-grade capabilities from xlnfinance/xln:

- **BLS Aggregate Signatures**: Real cryptographic verification using BLS12-381 signatures
- **RLP Encoding**: Ethereum-compatible recursive length prefix encoding for deterministic serialization
- **Write-Ahead Log (WAL)**: LevelDB-based persistence for crash recovery and audit trails
- **Snapshot System**: Periodic state snapshots with compaction for fast sync
- **Leader Rotation**: Deterministic proposer selection with timeout-based re-proposal
- **QuorumHash Validation**: Prevents replay attacks across different quorum configurations
- **Multi-Entity ServerFrames**: Global merkle root computation across all entities

### Version 0.4 Improvements

Previous improvements for production readiness:

- **Parent Hash Linking**: Added blockchain-style parent hash linking for replay protection
- **Mempool Deduplication**: Prevents duplicate transactions based on signature uniqueness
- **RLP Codec Enhancements**: Fixed timestamp encoding and proper BigInt serialization
- **Server Robustness**: Early COMMIT height validation and replica lookup fallback
- **Deterministic State Root**: Added Object.freeze to ensure immutable state computation
- **Property-Based Testing**: Added fuzz testing for RLP codec round-trip verification

Previous v0.3 improvements:

- **Canonical JSON**: RFC 8785-compliant serialization ensures deterministic hashing
- **Pure BigInt Arithmetic**: Eliminates Number overflow risks
- **Weighted Voting**: Proper share-based consensus
- **State Integrity**: Fixed RLP codec frame encoding
- **Deterministic Ordering**: Stable transaction sorting

## Core Concepts

### 1. **Entity** - The Local Consensus Machine

An Entity is a pure state machine that manages consensus for a specific group. Like a local parliament:

- **Members**: Signers with voting shares (e.g., 5 members)
- **Quorum**: Threshold for decisions (e.g., 3 of 5 must agree)
- **Mempool**: Pending transactions awaiting consensus
- **Frames**: Finalized blocks of transactions with resulting state

### 2. **Server** - The Global Coordinator

The Server orchestrates all entities without participating in consensus. Like air traffic control:

- Routes commands to appropriate entities
- Generates ServerFrames every 100ms (tick)
- Computes Merkle roots of all entity states
- Never holds funds or makes consensus decisions

### 3. **Runtime** - The Bridge to Reality

The Runtime handles all side effects. Like the physical infrastructure:

- Manages cryptographic operations (signing, verification)
- Persists state (future: WAL, snapshots)
- Handles network I/O (future: P2P transport)
- Provides deterministic randomness

### 4. **Hanko (判子)** - The Seal of Consensus

A Hanko is a BLS aggregate signature that proves quorum agreement. Like a traditional Japanese seal:

- Combines multiple signatures into one 48-byte proof
- Mathematically proves the required threshold was met
- Cannot be forged without the original private keys
- Efficient to verify even with many signers

## Architecture Deep Dive

```
┌─────────────────────────────────────────────────────────────┐
│                         Runtime                              │
│  • Cryptography (BLS signing/verification)                  │
│  • State persistence                                        │
│  • Network I/O                                              │
└─────────────────┬───────────────────────────┬───────────────┘
                  │                           │
                  ▼                           ▼
┌─────────────────────────────┐ ┌─────────────────────────────┐
│         Server              │ │         Entity              │
│  • Routes commands          │ │  • Processes transactions   │
│  • Forms ServerFrames       │ │  • Manages consensus        │
│  • Computes Merkle roots    │ │  • Maintains quorum state   │
│  • Pure functional          │ │  • Pure functional          │
└─────────────────────────────┘ └─────────────────────────────┘
                                 │
                                 ▼
              ┌─────────────────────────────┐
              │      Codec Layer           │
              │  • Canonical JSON (RFC 8785)│
              │  • RLP encoding/decoding    │
              │  • Deterministic hashing    │
              └─────────────────────────────┘
```

### Layer Responsibilities

1. **Entity Layer** (`src/core/entity.ts`)
   - Pure functional state transitions
   - No I/O, no randomness, no timestamps
   - Deterministic replay from genesis
   - Commands: `ADD_TX`, `PROPOSE`, `SIGN`, `COMMIT`
   - Validates consensus rules and quorum thresholds

2. **Server Layer** (`src/core/server.ts`)
   - Pure functional routing and aggregation
   - Maintains global view of all entities
   - Generates deterministic ServerFrames
   - Computes canonical Merkle roots
   - Uses voting shares (not just signature count) for consensus

3. **Runtime Layer** (`src/core/runtime.ts`)
   - Handles all side effects
   - Fulfills cryptographic signatures
   - Manages persistence and networking
   - Provides tick-based execution

4. **Codec Layer** (`src/codec/`)
   - Canonical JSON serialization (RFC 8785)
   - RLP encoding for frames and transactions
   - Deterministic BigInt serialization
   - Proper timestamp encoding with BigInt conversion
   - Hex utilities for consistent address handling
   - Ensures cross-platform consistency

## Consensus Flow

The consensus process follows a precise 4-tick choreography:

### Tick 1: ADD_TX (Transaction Submission)

```
User → Runtime → Server → Entity
         │
         └─> Transaction enters mempool
```

- User submits a signed transaction
- Server routes it to the correct entity
- Entity validates signature and nonce
- Transaction waits in mempool

### Tick 2: PROPOSE (Frame Creation)

```
Server → Entity (Proposer)
          │
          └─> Creates ProposedFrame from mempool
               └─> Broadcasts SIGN requests
```

- Server detects pending transactions
- Triggers proposer to create a frame
- Frame includes all mempool transactions
- SIGN commands sent to all quorum members

### Tick 3: SIGN (Signature Collection)

```
Entity → Runtime → Entity (Proposer)
           │
           └─> Each signer creates signature
                └─> Proposer collects until threshold
```

- Each signer validates the proposed frame
- Runtime fulfills signature creation
- Proposer accumulates signatures
- When threshold reached, triggers COMMIT

### Tick 4: COMMIT (Finalization)

```
Entity (Proposer) → All Entities
                     │
                     └─> Hanko proves consensus
                          └─> All replicas update state
```

- Proposer aggregates signatures into Hanko
- COMMIT broadcast to all replicas
- Each replica independently validates
- State converges across all replicas

## Implementation Details

### Type System

```typescript
// Core identity types
type Address = `0x${string}`; // 20-byte Ethereum-style address
type Hex = `0x${string}`; // Hex-encoded data
type UInt64 = bigint; // For nonces, timestamps, amounts

// Consensus structures
interface Frame<T> {
	height: UInt64; // Monotonic frame number
	ts: number; // Unix timestamp
	txs: Transaction[]; // Ordered transactions
	state: T; // Resulting state
}

interface Quorum {
	threshold: bigint; // Signatures required
	members: Record<
		Address,
		{
			// Voting members
			nonce: UInt64; // Replay protection
			shares: bigint; // Voting weight
		}
	>;
}
```

### Determinism Rules

1. **Transaction Ordering**: By `nonce` → `from` → `kind` → insertion order
2. **Timestamp Handling**: Only at Server level, not Entity
3. **State Computation**: Pure functions, no randomness
4. **Hash Computation**: RFC 8785-style canonical JSON
5. **Canonical Serialization**: Deterministic key ordering, bigint→string conversion
6. **Parent Hash Linking**: Each ServerFrame includes previous frame hash
7. **Mempool Uniqueness**: Transactions deduplicated by signature

### Cryptographic Primitives

- **Signatures**: BLS12-381 for aggregation capability (via @noble/curves)
- **Hashing**: Keccak-256 (Ethereum compatible)
- **Encoding**: RLP for canonical serialization (compatible with Ethereum)
- **Addresses**: Last 20 bytes of keccak(pubkey)

### Leader Rotation

The system implements deterministic leader rotation to ensure liveness:

- **Round-Robin Selection**: Proposer rotates based on `height % members.length`
- **Deterministic Ordering**: Members sorted lexicographically for consistency
- **Timeout Mechanism**: Exponential backoff (5s base, 1.5x multiplier, 60s max)
- **Re-proposal**: If proposer times out, any node can trigger re-proposal

## Running the System

### Prerequisites

```bash
# Install Bun runtime
curl -fsSL https://bun.sh/install | bash

# Clone and install
git clone <repository>
cd xln-v02
bun install
```

### Demo Execution

```bash
bun run start
```

This runs a complete consensus demonstration:

1. Initializes 5 signers (Alice, Bob, Carol, Dave, Eve)
2. Sets quorum threshold to 3 of 5
3. Executes multiple consensus rounds
4. Verifies state convergence across all replicas

### Test Suite

```bash
bun test                          # All tests
bun test snapshot                 # Snapshot tests
bun test negative                 # Failure scenarios
bun test rlp-codec                # RLP encoding tests
bun test proposer                 # Leader rotation tests
bun test wal                      # WAL persistence tests
bun test integration              # Integration tests

# Development commands
bun run test:coverage             # Run tests with coverage report
bun run lint                      # Run ESLint
bun run format                    # Format with Prettier
bun run check:all                 # Lint, format, and test
```

## Security Model

### Byzantine Fault Tolerance

- Tolerates up to `f` Byzantine nodes where `n ≥ 3f + 1`
- Default: 5 nodes tolerating 1 Byzantine (3 of 5 threshold)
- Ensures safety: no conflicting commits
- Ensures liveness: progress with honest majority

### Cryptographic Security

- **Signature Forgery**: Computationally infeasible (BLS12-381)
- **Replay Attacks**: Prevented by per-signer nonces
- **State Tampering**: Detected via Merkle root verification
- **Sybil Attacks**: Prevented by permissioned quorum

### Deterministic Execution

- Same inputs always produce same outputs
- Enables fraud proofs and state verification
- Allows replay from genesis or snapshots
- Critical for cross-jurisdiction dispute resolution

## Design Philosophy

### 1. **Pure Functional Core**

The Entity and Server layers are pure functions:

- No side effects, I/O, or mutable state
- Enables easy testing and formal verification
- Allows deterministic replay and debugging
- Simplifies reasoning about consensus

### 2. **Explicit Effects Boundary**

All side effects isolated in Runtime:

- Clear separation of concerns
- Mockable for testing
- Swappable implementations
- Audit-friendly architecture

### 3. **Tick-Based Execution**

Fixed 100ms ticks provide:

- Predictable performance characteristics
- Natural batching of operations
- Simplified timeout handling
- Deterministic ordering

### 4. **Local-First Design**

Entities operate independently:

- No global blockchain required
- Minimal coordination overhead
- Jurisdiction-specific compliance
- Scalable to many entities

## Recent Improvements

### v0.4 - Production Hardening

1. **Blockchain-Style Security**
   - Parent hash linking in ServerFrames prevents history manipulation
   - Mempool deduplication based on cryptographic signatures
   - Early height validation saves computational resources

2. **RLP Codec Refinements**
   - Proper timestamp encoding using BigInt conversion
   - Consistent Buffer handling for all encode functions
   - Comprehensive fuzz testing with fast-check library

3. **Server Layer Robustness**
   - Fallback replica lookup doesn't trust input routing
   - Deterministic state root with Object.freeze protection
   - Quick-fail for invalid COMMIT heights

### v0.3 - Consensus Integrity

1. **Deterministic Serialization**
   - Implemented RFC 8785-style canonical JSON
   - Fixed key ordering across JavaScript engines
   - Proper BigInt to string conversion

2. **Consensus Improvements**
   - Fixed voting power calculation to use shares
   - Corrected RLP frame decoding
   - Pure BigInt comparison in transaction sorting

3. **Code Quality**
   - Full TypeScript strict mode compliance
   - ESLint functional programming rules
   - Comprehensive test coverage

## Verification Strategy

A comprehensive verification approach is documented in [Issue #5](https://github.com/adimov-eth/xln01/issues/5):

- Property-based testing for invariants
- Byzantine fault scenario testing
- Formal verification preparation
- Simulation framework for edge cases

## Implemented Production Features (v0.5)

### Persistence Layer

- ✅ **Write-Ahead Log (WAL)**: LevelDB-based crash recovery with atomic writes
- ✅ **State Snapshots**: Periodic snapshots with automatic compaction
- ✅ **Deterministic Replay**: Full state reconstruction from WAL entries
- ✅ **Consistency Validation**: Input/frame count verification

### Cryptographic Layer

- ✅ **BLS12-381 Signatures**: Aggregate signature verification
- ✅ **QuorumHash**: Prevents cross-quorum replay attacks
- ✅ **RLP Encoding**: Ethereum-compatible serialization

### Consensus Features

- ✅ **Leader Rotation**: Round-robin proposer selection
- ✅ **Proposal Timeouts**: Exponential backoff for network delays
- ✅ **Multi-Entity Support**: Global merkle root across entities

## Future Extensions

### Network Transport

- P2P message routing between nodes
- Gossip protocol for command propagation
- TCP/QUIC transport options
- NAT traversal and peer discovery

### Cross-Jurisdiction Features

- Multi-entity transactions
- Atomic swaps between entities
- Cross-jurisdiction message routing
- On-chain anchoring protocols

### Production Enhancements

- Dynamic quorum adjustment
- Member addition/removal protocols
- Fee mechanisms and rate limiting
- Monitoring and observability

---

_XLN demonstrates that sophisticated consensus systems can be built with pure functional cores, explicit effect boundaries, and careful architectural layering. The result is a system that's both theoretically sound and practically efficient._
