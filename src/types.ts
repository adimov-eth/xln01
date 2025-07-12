export type Hex = `0x${string}`;
export type Address = Hex;
export type UInt64 = bigint;
export type Nonce = UInt64;
export type TS = number; // TODO: Convert to bigint for spec compliance

export interface SignerRecord {
	nonce: Nonce;
	shares: bigint;
}
export interface Quorum {
	threshold: bigint;
	members: Record<Address, SignerRecord>;
}

export interface EntityState {
	quorum: Quorum;
	chat: { from: Address; msg: string; ts: TS }[];
}

export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export type TxKind = 'chat';
export interface BaseTx<K extends TxKind = TxKind> {
	kind: K;
	nonce: Nonce;
	from: Address;
	body: unknown;
	sig: Hex;
}
export type ChatTx = BaseTx<'chat'> & { body: { message: string } };
export type Transaction = ChatTx;

// Spec-compliant Frame structure
export interface FrameHeader {
	height: UInt64;
	timestamp: UInt64; // Changed from TS (number) to bigint per spec
	parentHash: Hex;
	proposer: Address;
}

export interface FrameBody<T = unknown> {
	transactions: Transaction[];
	state?: T; // Optional, for backward compatibility
}

// Backward-compatible Frame interface
// TODO: Remove legacy fields after migration
export interface Frame<T = unknown> {
	// New spec-compliant fields
	header?: FrameHeader; // Optional during migration
	body?: FrameBody<T>; // Optional during migration

	// Legacy fields (will be removed)
	height: UInt64;
	ts: TS;
	txs: Transaction[];
	state: T;
}
export interface ProposedFrame<T = unknown> extends Frame<T> {
	sigs: Map<Address, Hex>;
	hash: Hex;
	proposalTs?: TS; // When this proposal was created (for timeout tracking)
}
export type Hanko = Hex;

// Helper to create spec-compliant frames
export const createFrame = <T>(params: {
	height: UInt64;
	timestamp: UInt64;
	parentHash: Hex;
	proposer: Address;
	transactions: Transaction[];
	state: T;
}): Frame<T> => ({
	// New spec fields
	header: {
		height: params.height,
		timestamp: params.timestamp,
		parentHash: params.parentHash,
		proposer: params.proposer,
	},
	body: {
		transactions: params.transactions,
		state: params.state,
	},
	// Legacy fields for compatibility
	height: params.height,
	ts: Number(params.timestamp), // Convert bigint to number for legacy
	txs: params.transactions,
	state: params.state,
});

// Helper to migrate legacy frames
export const migrateFrame = <T>(legacy: Frame<T>, parentHash: Hex, proposer: Address): Frame<T> => ({
	...legacy,
	header: {
		height: legacy.height,
		timestamp: BigInt(legacy.ts),
		parentHash,
		proposer,
	},
	body: {
		transactions: legacy.txs,
		state: legacy.state,
	},
});

export interface ReplicaAddr {
	jurisdiction: string;
	entityId: string;
	signerId?: string;
}
export const getAddrKey = (a: ReplicaAddr) => `${a.jurisdiction}:${a.entityId}`;

export interface Replica {
	address: ReplicaAddr;
	proposer: Address;
	isAwaitingSignatures: boolean;
	mempool: Transaction[];
	last: Frame<EntityState>;
	proposal?: ProposedFrame<EntityState>;
}

export type Command =
	| { type: 'IMPORT'; replica: Replica }
	| { type: 'ADD_TX'; addrKey: string; tx: Transaction }
	| { type: 'PROPOSE'; addrKey: string; ts: TS; quorumHash: Hex }
	| { type: 'SIGN'; addrKey: string; signer: Address; frameHash: Hex; sig: Hex; quorumHash: Hex }
	| { type: 'COMMIT'; addrKey: string; hanko: Hanko; frame: Frame<EntityState>; signers: Address[]; quorumHash: Hex };

export interface Input {
	from: Address;
	to: Address;
	cmd: Command;
}

export interface ServerFrame {
	height: UInt64;
	ts: TS;
	inputs: Input[];
	root: Hex;
	parent: Hex;
	hash: Hex;
}

export interface ServerState {
	height: UInt64;
	replicas: Map<string, Replica>;
	lastHash: Hex;
}
