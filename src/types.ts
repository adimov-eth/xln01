/* ──────────── primitive brands ──────────── */
export type Hex = `0x${string}`;
export type Address = Hex;
export type UInt64 = bigint; // big-endian, left-stripped BigInt
export type Nonce = UInt64;
export type TS = number; // millisecond timestamp since epoch

/* ──────────── signer & quorum ──────────── */
export interface SignerRecord {
	nonce: Nonce;
	shares: number; // voting power for this signer
}
export interface Quorum {
	threshold: number; // total shares needed to commit a frame (>=)
	members: Record<Address, SignerRecord>; // signers by address
}

/* ──────────── entity state ──────────── */
export interface EntityState {
	quorum: Quorum;
	chat: { from: Address; msg: string; ts: TS }[]; // simple chat log
}

/* ──────────── Result type for functional error handling ──────────── */
export type Result<T, E = string> = 
	| { ok: true; value: T }
	| { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/* ──────────── transactions ──────────── */
export type TxKind = 'chat';
export interface BaseTx<K extends TxKind = TxKind> {
	kind: K;
	nonce: Nonce;
	from: Address;
	body: unknown;
	sig: Hex; // BLS12-381 signature (signer's signature of the tx)
}
export type ChatTx = BaseTx<'chat'> & { body: { message: string } };
export type Transaction = ChatTx; // In MVP, only 'chat' transactions exist

/* ──────────── frames (Entity-level and proposed) ──────────── */
export interface Frame<T = unknown> {
	height: UInt64; // monotonically increasing frame number for the entity
	ts: TS; // timestamp at frame creation (ms)
	txs: Transaction[]; // transactions included in this frame (ordered)
	state: T; // resultant Entity state after applying txs
}
export interface ProposedFrame<T = unknown> extends Frame<T> {
	sigs: Map<Address, Hex>; // individual signatures from signers on hash(frame)
	hash: Hex; // hash of the frame contents (unique identifier for frame)
}
export type Hanko = Hex; // 48-byte BLS aggregate signature attesting a frame (commit signature)

/* ──────────── replica addressing ──────────── */
export interface ReplicaAddr {
	jurisdiction: string;
	entityId: string;
	signerId?: string; // optional: identifies a particular signer's replica
}
export const getAddrKey = (a: ReplicaAddr) => `${a.jurisdiction}:${a.entityId}`; // canonical key for an entity (excludes signerId)

/* ──────────── replica runtime view ──────────── */
export interface Replica {
	address: ReplicaAddr;
	proposer: Address; // signer's address acting as proposer for this replica
	isAwaitingSignatures: boolean;
	mempool: Transaction[]; // queued txs waiting to be proposed
	last: Frame<EntityState>; // last committed frame for this replica's entity
	proposal?: ProposedFrame<EntityState>; // current in-flight proposal (if any)
}

/* ──────────── server-level commands (Input.cmd union) ──────────── */
export type Command =
	| { type: 'IMPORT'; replica: Replica }
	| { type: 'ADD_TX'; addrKey: string; tx: Transaction }
	| { type: 'PROPOSE'; addrKey: string; ts: TS }
	| { type: 'SIGN'; addrKey: string; signer: Address; frameHash: Hex; sig: Hex }
	| { type: 'COMMIT'; addrKey: string; hanko: Hanko; frame: Frame<EntityState>; signers: Address[] };

/* ──────────── wire envelope (transport-neutral) ──────────── */
export interface Input {
	from: Address;
	to: Address;
	cmd: Command;
}

/* ──────────── server frame (tick diary) ──────────── */
export interface ServerFrame {
	height: UInt64; // global server frame counter (increments every tick)
	ts: TS; // wall-clock timestamp of the tick
	inputs: Input[]; // all Inputs processed during this tick (in execution order)
	root: Hex; // Merkle root of [signerAddr -> entity state] snapshots after execution
	hash: Hex; // keccak256 hash of the RLP-encoded frame *excluding* this hash (frame ID)
}

/* ──────────── server in-memory state ──────────── */
export interface ServerState {
	height: UInt64; // height of last committed ServerFrame
	replicas: Map<string, Replica>; // active replicas, keyed by "jurisdiction:entityId:signerAddr"
}
