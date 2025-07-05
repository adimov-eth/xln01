# XLN Proof of Concept

A minimal implementation of the XLN (Cross-Local Network) consensus protocol demonstrating Byzantine Fault Tolerant (BFT) consensus for a chat application.

## Overview

This proof-of-concept implements:

- 5-signer BFT consensus with threshold of 3
- Pure functional state machines for deterministic execution
- BLS12-381 aggregate signatures (Hanko)
- RLP encoding for canonical serialization
- 100ms tick-based ServerFrame generation
- Complete ADD_TX → PROPOSE → SIGN → COMMIT flow

## Architecture

```
src/
├─ core/
│    ├─ entity.ts    # Pure Entity consensus state machine
│    ├─ server.ts    # Pure Server routing and state management
│    └─ runtime.ts   # Side-effectful runtime orchestration
├─ codec/
│    └─ rlp.ts       # RLP encoding/decoding
├─ crypto/
│    └─ bls.ts       # BLS12-381 cryptographic operations
├─ types.ts          # Canonical type definitions
└─ index.ts          # Demo script
```

## Installation

```bash
# Install Bun runtime (if not already installed)
curl -fsSL https://bun.sh/install | bash

# Install dependencies
bun install
```

## Running the Demo

```bash
bun run start
```

This will:

1. Initialize 5 signers with equal voting weight
2. Create a chat transaction from the first signer
3. Process the consensus flow through 4 ticks:
   - Tick 1: Add transaction to mempool
   - Tick 2: Propose frame
   - Tick 3: Collect signatures
   - Tick 4: Commit with aggregate signature
4. Display the final consensus state

## Key Concepts

- **Frame**: Entity-level block containing transactions and resulting state
- **ServerFrame**: Global tick snapshot with Merkle root of all entities
- **Hanko**: 48-byte BLS aggregate signature proving quorum consensus
- **Pure State Machines**: No side effects in consensus logic
- **Deterministic Ordering**: Transactions sorted by nonce→from→kind

## Security Properties

- BLS signatures prevent forgery
- Per-signer nonces prevent replay attacks
- Deterministic execution ensures consistency
- Merkle roots enable efficient state verification
- 3/5 threshold provides Byzantine fault tolerance

## Future Extensions

This PoC provides a foundation for:

- Persistence (WAL and snapshots)
- Network transport
- Multi-entity support
- Channel/payment layers
- Cross-jurisdiction anchoring
