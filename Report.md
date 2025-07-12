# XLN v0.0.1 Architecture Report

## Overview

This report documents the architecture and implementation details of XLN Proof of concept build.

## Core Architecture

### Layer Structure

The system follows a three-layer architecture:

1. **Entity Layer** - Pure functional BFT consensus state machine
2. **Server Layer** - Routes inputs and maintains global state via ServerFrames
3. **Runtime Layer** - Side-effectful shell managing cryptography and I/O

## Implementation Walkthrough

### 1. System Initialization

The demo begins by setting up the runtime which creates 5 signers (cryptographic identities):

```typescript
// Initialize the runtime (which sets up the 5 signers and genesis state)
const runtime = createRuntime();

// Use the addresses and keys from the runtime
const DEMO_ADDRS = runtime.ADDRS;
const DEMO_PRIVS = runtime.PRIVS;
```

- Runtime generates 5 key pairs (private keys, public keys, addresses)
- Addresses are derived as `keccak256(pubkey)[-20:]`
- These signers will form the quorum for consensus

<details>
<summary><strong>How createRuntime() works</strong></summary>

The `createRuntime()` function is the entry point that sets up the entire system. It creates a stateful runtime that manages cryptography and orchestrates the consensus process.

#### 1. Key Generation and Setup

First, it generates cryptographic identities for all signers:

```typescript
const generateSigners = (count: number) => {
	const privs = Array.from({ length: count }, randomPriv);
	const pubs = privs.map(getPublicKey);
	const addrs = pubs.map(deriveAddress);
	const privHexes = privs.map(priv => `0x${Buffer.from(priv).toString('hex')}`) as readonly Hex[];

	return { privs, pubs, addrs, privHexes };
};

const { privs: PRIVS, pubs: PUBS, addrs: ADDRS, privHexes: PRIV_HEXES } = generateSigners(TOTAL_SIGNERS);
```

**Key Points:**

- Generates `TOTAL_SIGNERS` (5) BLS12-381 key pairs
- `randomPriv()` creates cryptographically secure private keys
- Public keys derived from private keys
- Addresses are last 20 bytes of keccak256(pubkey)
- Keys stored as module-level constants (UPPERCASE naming indicates immutability)

#### 2. Runtime State Initialization

```typescript
export const createRuntime = (): Runtime => {
    const initialReplicas = new Map<string, Replica>();

    const stateRef = {
        current: {
            replicas: initialReplicas,
            height: INITIAL_HEIGHT,
            lastHash: EMPTY_HASH,
        },
    };
```

**Key Points:**

- Starts with empty replicas map (entities created via IMPORT command)
- Uses a mutable reference (`stateRef`) to maintain server state between ticks
- Initial height is 0, lastHash is all zeros

#### 3. Tick and Signature fulfillment

The runtime provides two key functions:

- **`tick()`**: Processes incoming messages, updates state, and returns outgoing messages
- **`fulfillSignature()`**: Replaces dummy signatures with real cryptographic signatures

These functions bridge the pure functional core with the side-effectful operations needed for BFT consensus. Alse necessary for Persistence and Networking layers coming later.

#### 4. Exposed Interface

The runtime returns a minimal interface:

```typescript
return {
	ADDRS,
	PRIVS: PRIV_HEXES,
	debugReplicas: () => stateRef.current.replicas,
	tick,
};
```

**Key Points:**

- Exposes addresses and private keys for demo purposes
- `debugReplicas()` allows inspection of current state
- `tick()` is the main entry point for processing messages

</details>

### 2. Entity Bootstrapping via Genesis Replica

Before the system can process transactions, it needs to create an Entity. This is done through the IMPORT command with a Genesis Replica.

#### What is an Entity?

An **Entity** is a logical consensus group that maintains its own state. In this demo, we have one entity called "chat" that manages a chat message log. Each entity:

- Has a unique identifier (jurisdiction:entityId)
- Maintains its own state (chat messages)
- Has its own quorum configuration
- Processes transactions independently

#### What is a Replica?

A **Replica** is a signer's local view of an entity's state. Key relationships:

- Each entity has multiple replicas (one per signer)
- All replicas of an entity should converge to the same state
- Each replica tracks:
  - The entity's consensus state (`last` frame)
  - Pending transactions (`mempool`)
  - Active proposals during consensus
  - Which signer acts as proposer for this replica

```typescript
interface Replica {
	address: ReplicaAddr; // {jurisdiction, entityId, signerId}
	proposer: Address; // Who proposes for this replica
	isAwaitingSignatures: boolean; // Is consensus in progress?
	mempool: Transaction[]; // Pending transactions
	last: Frame<EntityState>; // Latest committed state
	proposal?: ProposedFrame; // Active proposal (if any)
}
```

#### Genesis Replica Creation

The `createGenesisReplica()` function creates the initial replica configuration:

```typescript
const createGenesisReplica = (): Replica => {
	// Create member records for all signers
	const members = DEMO_ADDRS.reduce<Record<Address, SignerRecord>>(
		(acc, addr) => ({
			...acc,
			[addr as Address]: { nonce: 0n, shares: 100n },
		}),
		{},
	);

	// Define the quorum (3 of 5 threshold)
	const quorum: Quorum = {
		threshold: BigInt(QUORUM_THRESHOLD),
		members,
	};

	// Initial entity state
	const initState: EntityState = { quorum, chat: [] };
	const initFrame: Frame<EntityState> = {
		height: 0n,
		ts: 0,
		txs: [],
		state: initState,
	};

	return {
		address: { jurisdiction: DEMO_JURISDICTION, entityId: DEMO_ENTITY_ID },
		proposer: DEMO_ADDRS[0] as Address,
		isAwaitingSignatures: false,
		mempool: [],
		last: initFrame,
	};
};
```

**Key Points:**

- Each signer gets 100 shares and starts with nonce 0
- Quorum requires 3 of 5 signatures (Byzantine fault tolerance)
- Initial state has empty chat and the quorum configuration
- First signer (DEMO_ADDRS[0]) is set as proposer

#### The IMPORT Process

```typescript
// Create IMPORT command to bootstrap the entity
const importInput: Input = {
	from: DEMO_ADDRS[0] as Address,
	to: DEMO_ADDRS[0] as Address,
	cmd: {
		type: 'IMPORT',
		replica: createGenesisReplica(),
	},
};

// Process IMPORT command
const { frame: importFrame } = runtime.tick({
	now: baseTime,
	incoming: [importInput],
});
```

**What happens during IMPORT:**

1. Server receives the IMPORT command
2. Creates 5 replicas (one per signer) from the genesis template
3. Each replica's `proposer` field is set to its own signer address
4. All replicas start with identical state (except for the proposer field)
5. System is now ready to process transactions

**Note on Proposer Selection:**

- In the current implementation, each replica has its own address as the `proposer` field
- However, since all transactions are routed to the first signer's replica (DEMO_ADDRS[0]), only that replica ever initiates proposals
- This effectively makes the first signer the sole proposer for the demo, even though each replica technically could propose
- Future implementations should move proposer to entity state and implement proper rotation or leader election logic to ensure all replicas agree on a single proposer

### 3. Transaction Creation and Signing

#### Transaction Structure

Transactions in XLN are signed messages that modify entity state:

```typescript
interface Transaction {
	kind: 'chat'; // Transaction type
	nonce: bigint; // Prevents replay attacks
	from: Address; // Signer's address
	body: { message: string }; // Payload
	sig: Hex; // BLS signature
}
```

#### Creating Signed Transactions

The `createSignedTransaction` helper shows the complete flow:

```typescript
const createSignedTransaction = (fromIndex: number, message: string): Transaction => {
	const fromAddr = DEMO_ADDRS[fromIndex];
	const privKey = DEMO_PRIVS[fromIndex];

	// Get current nonce from any replica (they should all agree on state)
	// In a real distributed system, each signer would read from their local replica
	const proposerReplica = runtime.debugReplicas().get(`${DEMO_JURISDICTION}:${DEMO_ENTITY_ID}:${DEMO_ADDRS[0]}`);
	const memberRecord = proposerReplica?.last.state.quorum.members[fromAddr];
	const currentNonce = memberRecord?.nonce ?? 0n;

	// Create transaction without signature
	const baseTx: Omit<Transaction, 'sig'> = {
		kind: 'chat',
		nonce: currentNonce,
		from: fromAddr,
		body: { message },
	};

	// Sign the canonical JSON representation
	const msgToSign = Buffer.from(
		JSON.stringify({
			kind: baseTx.kind,
			nonce: baseTx.nonce.toString(),
			from: baseTx.from,
			body: baseTx.body,
		}),
	);

	const signature = sign({
		message: msgToSign,
		privateKey: Buffer.from(privKey.slice(2), 'hex'),
	});

	return { ...baseTx, sig: signature };
};
```

**Key Security Features:**

- **Nonces**: Each signer has a nonce that increments with each transaction, preventing replay attacks
- **BLS Signatures**: Cryptographically prove the transaction came from the claimed sender
- **Canonical Serialization**: Ensures all nodes compute the same signature for the same transaction

**Important Note on Distributed Architecture:**

- In this demo, all signers run in a single process for simplicity
- In a real deployment, each signer would:
  - Run on a separate computer
  - Read nonces from their local replica
  - Send transactions asynchronously over the network
  - Only the proposer creates frames; other signers only sign and validate
- All replicas converge to the same state through the consensus process

### 4. Consensus Rounds

Each Frame follows a predictable 4-tick pattern:

#### Phase 1: ADD_TX (Add to Mempool)

```typescript
const addTxInputs: Input[] = transactions.map(tx => ({
	from: tx.from,
	to: DEMO_ADDRS[0], // Send to proposer
	cmd: {
		type: 'ADD_TX',
		addrKey: `${DEMO_JURISDICTION}:${DEMO_ENTITY_ID}`,
		tx,
	},
}));
```

- Transactions sent to the proposer's replica
- Validated (signature, nonce) and added to mempool
- Triggers PROPOSE command if mempool not empty

#### Phase 2: PROPOSE (Create Frame)

- Proposer creates a frame from mempool transactions
- Transactions ordered deterministically
- Frame hash computed
- SIGN commands sent to all quorum members

<details>
<summary><strong>PROPOSE Implementation</strong></summary>

The PROPOSE handler in `entity.ts` creates a new frame from mempool transactions:

```typescript
const handlePropose: CommandHandler = (replica, command) => {
	if (command.type !== 'PROPOSE') return replica;
	if (!replica.isAwaitingSignatures) return replica;
	if (!replica.mempool.length) return replica;

	// Execute frame with sorted transactions
	const frameResult = execFrame({
		prev: replica.last,
		transactions: replica.mempool,
		timestamp: command.ts,
	});

	if (!frameResult.ok) {
		console.log(`PROPOSE failed: ${frameResult.error}`);
		return replica;
	}

	const frame = frameResult.value;
	const proposal: ProposedFrame<EntityState> = {
		...frame,
		hash: hashFrame(frame),
		sigs: new Map<Address, Hex>(), // Empty signatures map
	};

	return {
		...replica,
		mempool: [], // Clear mempool
		isAwaitingSignatures: true, // Await signatures
		proposal,
	};
};
```

**The execFrame function processes transactions:**

```typescript
export const execFrame = ({ prev, transactions, timestamp }: ExecFrameParams): Result<Frame<EntityState>> => {
	// Sort transactions deterministically
	const sorted = transactions.slice().sort((a, b) => {
		const nonceDiff = Number(a.nonce - b.nonce);
		if (nonceDiff !== 0) return nonceDiff;

		const fromCmp = a.from.localeCompare(b.from);
		if (fromCmp !== 0) return fromCmp;

		const kindCmp = a.kind.localeCompare(b.kind);
		if (kindCmp !== 0) return kindCmp;

		return transactions.indexOf(a) - transactions.indexOf(b);
	});

	// Apply transactions sequentially
	const finalState = sorted.reduce<Result<EntityState>>(
		(stateResult, tx) =>
			stateResult.ok ? applyTx({ state: stateResult.value, transaction: tx, timestamp }) : stateResult,
		ok(prev.state),
	);

	if (!finalState.ok) return err(finalState.error);

	return ok({
		height: prev.height + 1n,
		ts: timestamp,
		txs: sorted,
		state: finalState.value,
	});
};
```

**Key aspects of frame creation:**

- **Deterministic ordering**: Transactions sorted by nonce → from → kind → insertion order
- **Sequential application**: Each transaction updates state (nonces, chat messages)
- **Atomic execution**: All transactions succeed or entire frame fails
- **Frame hashing**: Uses RLP encoding + keccak256 for consensus agreement

</details>

#### Phase 3: SIGN (Collect Signatures)

- Each signer validates the proposed frame
- Signs the frame hash with their private key
- Sends signature back to proposer
- When threshold reached (3 of 5), triggers COMMIT

<details>
<summary><strong>SIGN Implementation</strong></summary>

The SIGN handler in `entity.ts` collects signatures from quorum members:

```typescript
const handleSign: CommandHandler = (replica, command) => {
	if (command.type !== 'SIGN') return replica;

	const { proposal, isAwaitingSignatures, last } = replica;
	if (!isAwaitingSignatures || !proposal) return replica;

	const { frameHash, signer, sig } = command;

	// Validate signature is for current proposal
	if (frameHash !== proposal.hash) return replica;

	// Validate signer is a quorum member
	if (!last.state.quorum.members[signer]) return replica;

	// Prevent duplicate signatures
	if (proposal.sigs.has(signer)) return replica;

	return {
		...replica,
		proposal: {
			...proposal,
			sigs: new Map(proposal.sigs).set(signer, sig),
		},
	};
};
```

**Entity-side threshold detection:**

The entity layer properly handles threshold detection. When processing SIGN commands, the proposer's replica checks if the voting threshold has been reached:

```typescript
const handleSign: CommandHandler = (replica, command) => {
	// ... validation checks ...

	const updatedProposal = {
		...proposal,
		sigs: new Map(proposal.sigs).set(signer, sig),
	};

	// Check if threshold is reached
	const quorum = last.state.quorum;
	const prevPower = calculateQuorumPower(quorum, proposal.sigs);
	const newPower = calculateQuorumPower(quorum, updatedProposal.sigs);

	if (prevPower < quorum.threshold && newPower >= quorum.threshold) {
		// Threshold reached: generate COMMIT commands for all replicas
		const outbox: Input[] = Object.keys(quorum.members).map(signerAddr => ({
			from: replica.proposer,
			to: signerAddr as Address,
			cmd: {
				type: 'COMMIT' as const,
				addrKey: command.addrKey,
				hanko: DUMMY_SIGNATURE, // Runtime will fill real signature
				frame: {
					height: updatedProposal.height,
					ts: updatedProposal.ts,
					txs: updatedProposal.txs,
					state: updatedProposal.state,
				},
				signers: [], // Runtime will fill
				_sigs: Object.fromEntries(updatedProposal.sigs), // Pass for aggregation
			},
		}));
		return { replica: updatedReplica, outbox };
	}

	return { replica: updatedReplica, outbox: [] };
};
```

**Signature fulfillment in runtime:**

```typescript
if (cmd.type === 'SIGN' && cmd.sig === DUMMY_SIGNATURE) {
	const signerIndex = ADDRS.findIndex(addr => addr === cmd.signer);
	const signature = sign({
		message: Buffer.from(cmd.frameHash.slice(2), 'hex'),
		privateKey: PRIVS[signerIndex],
	});
	return { ...message, cmd: { ...cmd, sig: signature } };
}
```

**Key aspects of signature collection:**

- **Frame hash validation**: Only sign if hash matches current proposal
- **Member validation**: Only quorum members can sign
- **Duplicate prevention**: Each signer can only sign once per proposal
- **Power calculation**: Weighted voting based on shares
- **Threshold detection**: Automatic COMMIT when 3 of 5 signatures collected

</details>

#### Phase 4: COMMIT (Finalize Consensus)

- Proposer aggregates signatures into a Hanko
- Broadcasts COMMIT with the frame and Hanko
- All replicas update their state
- Nonces increment, mempool clears

<details>
<summary><strong>COMMIT Implementation</strong></summary>

The COMMIT handler in `entity.ts` finalizes the consensus round by applying rigorous validation before accepting a new frame.

**High-level COMMIT validation logic:**

1. **Height Validation**: Ensures the frame is exactly the next expected height
2. **State Replay**: Re-executes all transactions to verify the resulting state hash matches
3. **Voting Power**: Confirms signers have sufficient shares to meet the quorum threshold
4. **Cryptographic Verification**: Validates the BLS aggregate signature (Hanko) against all signers

Only after passing all validations does the replica:

- Update to the new frame state
- Clear the pending proposal
- Remove committed transactions from mempool
- Reset consensus flags

<details>
<summary><strong>COMMIT Implementation Details</strong></summary>

The actual implementation uses a sophisticated validation pipeline:

```typescript
const handleCommit: CommandHandler = (replica, command) => {
	if (command.type !== 'COMMIT') return { replica, outbox: [] };

	const isValid = validateCommit({
		frame: command.frame,
		hanko: command.hanko,
		prev: replica.last,
		signers: command.signers,
	});

	if (!isValid) return { replica, outbox: [] };

	const newMempool = replica.mempool.filter(tx => !command.frame.txs.some(c => c.sig === tx.sig));

	return {
		replica: {
			...replica,
			last: command.frame,
			mempool: newMempool,
			isAwaitingSignatures: false,
			proposal: undefined,
		},
		outbox: [],
	};
};
```

**The validation pipeline uses functional composition:**

```typescript
const validateCommit = (params: ValidateCommitParams): boolean => {
	const validator = compose(checkHeight, checkStateReplay, checkSigningPower, checkSignatures);

	const result = validator(params);
	if (!result.ok) console.error(`Commit validation failed: ${result.error}`);
	return result.ok;
};
```

**Individual validators:**

1. **checkHeight**: Verifies `frame.height === prev.height + 1n`

2. **checkStateReplay**: Re-executes the frame to ensure deterministic state

```typescript
const checkStateReplay: Validator<ValidateCommitParams> = params => {
	const replayResult = execFrame({
		prev: params.prev,
		transactions: params.frame.txs,
		timestamp: params.frame.ts,
	});
	if (!replayResult.ok) return err('Failed to replay frame');

	const replayHash = hashFrame(replayResult.value);
	const frameHash = hashFrame(params.frame);
	return replayHash === frameHash ? ok(params) : err('State hash mismatch');
};
```

3. **checkSigningPower**: Validates quorum threshold is met

```typescript
const checkSigningPower: Validator<ValidateCommitParams> = params => {
	const quorum = params.prev.state.quorum;
	const uniqueSigners = [...new Set(params.signers)];
	const totalPower = calculateQuorumPower(quorum, uniqueSigners);
	return totalPower >= quorum.threshold ? ok(params) : err(`Insufficient power`);
};
```

4. **checkSignatures**: Verifies the BLS aggregate signature

```typescript
const checkSignatures: Validator<ValidateCommitParams> = params => {
	const uniqueSigners = [...new Set(params.signers)];
	const pubKeys = uniqueSigners.map(addr => ADDR_TO_PUB.get(addr)).filter(Boolean);

	const isValid = verifyAggregate({
		hanko: params.hanko,
		messageHash: hashFrame(params.frame),
		publicKeys: pubKeys,
	});
	return isValid ? ok(params) : err('Invalid aggregate signature');
};
```

This composable validation ensures Byzantine fault tolerance by preventing any invalid state transitions.

</details>

</details>

<details>
<summary><strong>BLS Signature Aggregation (Hanko)</strong></summary>

The runtime layer handles the cryptographic aggregation of signatures:

```typescript
if (cmd.type === 'COMMIT' && cmd.hanko === DUMMY_SIGNATURE) {
	const cmdWithSigs = cmd as typeof cmd & { _sigs?: Map<Address, Hex> | Record<string, Hex> };
	const [signatures, signers] = extractSignatures(cmdWithSigs._sigs);

	if (signatures.length === 0) {
		console.error('WARNING: No signatures found for aggregation');
	}

	const hanko = signatures.length > 0 ? aggregate(signatures) : createEmptyHanko();
	const { _sigs, ...cleanCmd } = cmdWithSigs;

	return { ...message, cmd: { ...cleanCmd, hanko, signers } };
}
```

**BLS Aggregate Signatures (Hanko):**

- BLS signatures can be aggregated into a single 96-byte signature
- The aggregate signature proves that all included signers signed the same message
- Verification requires the public keys of all signers
- This reduces on-chain storage from N signatures to 1 aggregate

**The \_sigs pattern:**

- Server passes individual signatures via `_sigs` field
- Runtime extracts valid signatures (non-dummy)
- Aggregates them into a single Hanko
- Removes `_sigs` from final command
- This keeps the entity layer pure while handling crypto in runtime

</details>

### 5. Demo Execution Flow

The demo runs three complete consensus rounds to demonstrate the system:

```typescript
// Run three consensus rounds
let tick = 0;

// Round 1: Single transaction from Alice
tick = runConsensusRound([createSignedTransaction(0, 'Hello from Alice!')], tick);

// Round 2: Multiple transactions (Bob and Charlie)
tick = runConsensusRound(
	[createSignedTransaction(1, 'Hey, this is Bob'), createSignedTransaction(2, 'Charlie here!')],
	tick,
);

// Round 3: Another transaction from Alice (nonce incremented)
tick = runConsensusRound([createSignedTransaction(0, 'Alice again with nonce 1')], tick);
```

Each consensus round follows a strict 4-tick pattern:

1. **Tick N+1**: ADD_TX - Transactions added to proposer's mempool
2. **Tick N+2**: PROPOSE - Proposer creates frame and requests signatures
3. **Tick N+3**: SIGN - Signers validate and sign the frame hash
4. **Tick N+4**: COMMIT - Aggregate signature created, state finalized

The demo outputs detailed logs showing:

- ServerFrame creation with Merkle roots
- Message routing between replicas
- Signature collection progress
- Final state updates

## Key Architectural Patterns

### 1. Pure Functional Core with Side-effectful Shell

The system strictly separates pure functions from side effects:

- **Pure Core** (entity.ts, server.ts): Deterministic state transitions
- **Side-effectful Shell** (runtime.ts): Cryptography, I/O, time

This enables:

- Easy testing and debugging
- Deterministic replay from logs
- Clear reasoning about state changes

### 2. Signature Fulfillment Pattern

The runtime uses a clever pattern to inject real signatures:

1. Pure functions create commands with `DUMMY_SIGNATURE`
2. Runtime's `fulfillSignature()` replaces dummies with real signatures
3. This keeps the core logic pure while enabling cryptography

```typescript
const fulfillSignature = (message: Input): Input => {
	const { cmd } = message;

	if (cmd.type === 'SIGN' && cmd.sig === DUMMY_SIGNATURE) {
		// Sign the frame hash
		const signature = sign({
			message: Buffer.from(cmd.frameHash.slice(2), 'hex'),
			privateKey: PRIVS[signerIndex],
		});
		return { ...message, cmd: { ...cmd, sig: signature } };
	}

	if (cmd.type === 'COMMIT' && cmd.hanko === DUMMY_SIGNATURE) {
		// Aggregate signatures into Hanko
		const hanko = aggregate(signatures);
		return { ...message, cmd: { ...cleanCmd, hanko, signers } };
	}

	return message;
};
```

### 3. Tick-based Orchestration

The runtime processes all inputs synchronously every 100ms:

```typescript
const tick = ({ now, incoming }: TickParams): TickResult => {
	// Apply all inputs to server state
	const {
		state: nextState,
		frame,
		outbox,
	} = applyServerBlock({
		prev: stateRef.current,
		inputs: incoming,
		timestamp: now,
	});

	// Fulfill signatures in outbox messages
	const fulfilledOutbox = outbox.map(fulfillSignature);

	// Update state reference
	stateRef.current = nextState;

	return { outbox: fulfilledOutbox, frame };
};
```

This provides:

- Predictable message ordering
- Deterministic state progression
- Clear causality chains

### 4. Replica-based Architecture

Each signer maintains their own replica of entity state:

- All replicas converge to same state through consensus
- Proposer role determines who creates frames
- Messages routed based on replica addresses
- Enables future distribution across network

## Server Layer (`src/core/server.ts`)

The server layer acts as a global message router and state aggregator. It maintains all entity replicas and forms ServerFrames that capture the entire system state at each tick.

### ServerFrame Formation

ServerFrames provide a global snapshot of all entities at a specific tick:

```typescript
interface ServerFrame {
	height: bigint; // Monotonically increasing counter
	ts: TimestampMs; // Unix timestamp in milliseconds
	inputs: Input[]; // All inputs processed this tick
	root: Hex; // Merkle root of all entity states
	parent: Hex; // Hash of previous ServerFrame
	hash: Hex; // Hash of this ServerFrame (computed via keccak256)
}
```

The server creates a new ServerFrame every tick:

```typescript
export const applyServerBlock = ({ prev, inputs, timestamp }: ApplyBlockParams): ApplyBlockResult => {
	// Process all inputs and collect entity updates
	const { nextReplicas, allOutbox } = inputs.reduce(
		(acc, input) => {
			const result = applyServerMessage({
				replicas: acc.nextReplicas,
				message: input,
			});
			return {
				nextReplicas: result.updatedReplicas,
				allOutbox: [...acc.allOutbox, ...result.outbox],
			};
		},
		{ nextReplicas: prev.replicas, allOutbox: [] as Input[] },
	);

	// Compute Merkle root of all entity states
	const entityStates = new Map<string, Hex>();
	for (const [key, replica] of nextReplicas) {
		const [jurisdiction, entityId] = key.split(':');
		const entityKey = `${jurisdiction}:${entityId}`;
		if (!entityStates.has(entityKey)) {
			entityStates.set(entityKey, hashFrame(replica.last));
		}
	}

	const root = computeMerkleRoot([...entityStates.values()]);

	// Create new ServerFrame
	const frame: ServerFrame = {
		height: prev.height + 1n,
		ts: timestamp,
		inputs,
		root,
		parent: prev.lastHash,
	};

	return {
		state: {
			replicas: nextReplicas,
			height: frame.height,
			lastHash: hashServerFrame(frame),
		},
		frame,
		outbox: allOutbox,
	};
};
```

**Key aspects:**

- Processes all inputs in order
- Updates all affected replicas
- Computes Merkle root for efficient verification
- Links to previous frame via parent hash
- Returns outbox of generated messages

### Message Routing

The server routes messages to appropriate entity replicas:

```typescript
const applyServerMessage = ({ replicas, message }: ApplyMessageParams): ApplyMessageResult => {
	const { cmd } = message;

	// Route based on command type
	switch (cmd.type) {
		case 'IMPORT': {
			// Create new replicas for all signers
			// TODO: doublecheck case for distributed Network
			const { replica } = cmd;
			const { jurisdiction, entityId } = replica.address;
			const updatedReplicas = new Map(replicas);

			// Create a replica for each quorum member
			for (const signerAddr of Object.keys(replica.last.state.quorum.members)) {
				const replicaKey = makeReplicaKey({
					jurisdiction,
					entityId,
					signerId: signerAddr as Address,
				});

				updatedReplicas.set(replicaKey, {
					...replica,
					address: { jurisdiction, entityId },
				});
			}

			return { updatedReplicas, outbox: [] };
		}

		case 'ADD_TX':
		case 'PROPOSE':
		case 'SIGN':
		case 'COMMIT': {
			// Route to specific replica based on addrKey
			const targetKey = `${cmd.addrKey}:${message.to}`;
			const replica = replicas.get(targetKey);

			if (!replica) {
				console.error(`No replica found for key: ${targetKey}`);
				return { updatedReplicas: replicas, outbox: [] };
			}

			// Apply command to entity replica
			const { state: updatedReplica, outbox } = applyCommand({
				replica,
				command: cmd,
			});

			// Update replica map
			const updatedReplicas = new Map(replicas);
			updatedReplicas.set(targetKey, updatedReplica);

			// Generate follow-up messages based on state changes
			const serverOutbox = generateServerOutbox(replica, updatedReplica, cmd);

			return {
				updatedReplicas,
				outbox: [...outbox, ...serverOutbox],
			};
		}

		default:
			return { updatedReplicas: replicas, outbox: [] };
	}
};
```

**Routing logic:**

- IMPORT: Creates replicas for all quorum members
- ADD_TX/PROPOSE/SIGN/COMMIT: Routes to specific replica
- Uses composite key: `jurisdiction:entityId:signerId`
- Handles missing replicas gracefully

### Message Generation

The server layer focuses purely on routing messages between replicas. The entity layer handles all consensus logic including threshold detection, while the server ensures messages reach their intended destinations.

## Entity Layer (`src/core/entity.ts`)

The entity layer implements the pure functional BFT consensus state machine. It processes commands deterministically without any side effects.

### Core State Machine

The `applyCommand` function is the heart of the consensus logic:

```typescript
export const applyCommand = ({ replica, command }: ApplyCommandParams): ApplyCommandResult => {
	// Route to appropriate handler based on command type
	const handlers: Record<Command['type'], CommandHandler> = {
		ADD_TX: handleAddTx,
		PROPOSE: handlePropose,
		SIGN: handleSign,
		COMMIT: handleCommit,
		IMPORT: r => r, // No-op at entity level
	};

	const handler = handlers[command.type];
	const nextReplica = handler(replica, command);

	// Generate outbox messages based on state changes
	const outbox = generateOutbox(replica, nextReplica, command);

	return { state: nextReplica, outbox };
};
```

### Transaction Validation

Transactions must pass several checks before entering the mempool:

```typescript
const validateTransaction = (
    tx: Transaction,
    quorum: Quorum,
    timestamp: TimestampMs,
): Result<true> => {
    // 1. Validate signature
    const msgToSign = Buffer.from(
        JSON.stringify({
            kind: tx.kind,
            nonce: tx.nonce.toString(),
            from: tx.from,
            body: tx.body,
        }),
    );

    const pubkey = /* lookup from quorum */;
    if (!verify(tx.sig, msgToSign, pubkey)) {
        return err('Invalid signature');
    }

    // 2. Check signer is quorum member
    const member = quorum.members[tx.from];
    if (!member) {
        return err('Signer not in quorum');
    }

    // 3. Validate nonce
    if (tx.nonce !== member.nonce) {
        return err(`Invalid nonce: expected ${member.nonce}, got ${tx.nonce}`);
    }

    return ok(true);
};
```

### State Updates

The `applyTx` function updates entity state for each transaction:

```typescript
const applyTx = ({ state, transaction, timestamp }: ApplyTxParams): Result<EntityState> => {
	// Update signer's nonce
	const member = state.quorum.members[transaction.from];
	const updatedMember = { ...member, nonce: member.nonce + 1n };

	const updatedQuorum = {
		...state.quorum,
		members: {
			...state.quorum.members,
			[transaction.from]: updatedMember,
		},
	};

	// Apply transaction-specific logic (chat message)
	const updatedChat = [
		...state.chat,
		{
			from: transaction.from,
			msg: transaction.body.message,
			ts: timestamp,
		},
	];

	return ok({
		quorum: updatedQuorum,
		chat: updatedChat,
	});
};
```

### Deterministic Ordering

Transactions are sorted to ensure all nodes process them identically:

```typescript
const sortTransactions = (txs: Transaction[]): Transaction[] => {
	return txs.slice().sort((a, b) => {
		// 1. Sort by nonce (ascending)
		const nonceDiff = Number(a.nonce - b.nonce);
		if (nonceDiff !== 0) return nonceDiff;

		// 2. Sort by sender address
		const fromCmp = a.from.localeCompare(b.from);
		if (fromCmp !== 0) return fromCmp;

		// 3. Sort by transaction kind
		const kindCmp = a.kind.localeCompare(b.kind);
		if (kindCmp !== 0) return kindCmp;

		// 4. Maintain insertion order as final tiebreaker
		return txs.indexOf(a) - txs.indexOf(b);
	});
};
```

## Data Structures

### Core Types

```typescript
// Cryptographic types
type Hex = `0x${string}`;
type Address = Hex; // 20 bytes: keccak256(pubkey)[-20:]
type Signature = Hex; // 96 bytes: BLS signature
type Hanko = Hex; // 96 bytes: BLS aggregate signature

// Entity state
interface EntityState {
	quorum: Quorum; // Consensus configuration
	chat: ChatMessage[]; // Application-specific state
}

// Consensus frame
interface Frame<TState> {
	height: bigint; // Sequential block number
	ts: TimestampMs; // Unix timestamp
	txs: Transaction[]; // Ordered transactions
	state: TState; // Resulting state
}

// Quorum configuration
interface Quorum {
	threshold: bigint; // Voting power needed (e.g., 3)
	members: Record<Address, SignerRecord>;
}

// Signer information
interface SignerRecord {
	nonce: bigint; // Replay protection counter
	shares: bigint; // Voting power
}
```

### Codec Layer

The system uses different encoding methods for different types of hashing:

1. **Entity Frames**: Use canonical JSON encoding followed by keccak256 hashing
2. **Server Frames**: Use RLP encoding followed by keccak256 hashing (as of v0.4)

#### Canonical JSON (for Entity Frames)

The `canonical()` function converts values to a deterministic JSON string following RFC 8785 principles:

- Object keys are sorted alphabetically
- BigInts are converted to strings
- Circular references are handled

```typescript
// Canonical encoding creates deterministic JSON
export const canonical = (value: unknown): string => {
	const walk = (v: unknown, stack: unknown[]): unknown => {
		if (typeof v === 'bigint') {
			return v.toString();
		}
		if (v && typeof v === 'object') {
			if (Array.isArray(v)) {
				return v.map(item => walk(item, stack));
			}
			// Sort object keys for determinism
			const sortedKeys = [...Object.keys(v)].sort();
			return sortedKeys.reduce(
				(acc, k) => ({
					...acc,
					[k]: walk(v[k], [...stack, v]),
				}),
				{},
			);
		}
		return v;
	};
	return JSON.stringify(walk(value, []));
};

// Entity frame hashing uses canonical JSON + keccak256
export const hashFrame = <TState>(frame: Frame<TState>): Hex => {
	return `0x${Buffer.from(keccak(canonical(frame))).toString('hex')}`;
};
```

#### RLP Encoding (for Server Frames)

Server frames use RLP (Recursive Length Prefix) encoding for deterministic binary serialization:

```typescript
// Server frame hashing uses RLP encoding + keccak256
const frame: ServerFrame = {
	height: newHeight,
	ts: timestamp,
	inputs,
	root: rootHash,
	parent: prev.lastHash ?? EMPTY_HASH,
	hash: `0x${Buffer.from(
		keccak(
			encodeServerFrame({
				height: newHeight,
				ts: timestamp,
				inputs,
				root: rootHash,
				parent: prev.lastHash ?? EMPTY_HASH,
				hash: DUMMY_SIGNATURE,
			}),
		),
	).toString('hex')}`,
};
```

The RLP encoding handles BigInts and timestamps carefully to ensure deterministic binary representation across all nodes. This enhancement in v0.4 provides more efficient binary serialization for server-level consensus data.
