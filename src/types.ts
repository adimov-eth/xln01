export type Hex = `0x${string}`;
export type Address = Hex;
export type UInt64 = bigint;
export type Nonce = UInt64;
export type TS = number;

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

export interface Frame<T = unknown> {
	height: UInt64;
	ts: TS;
	txs: Transaction[];
	state: T;
}
export interface ProposedFrame<T = unknown> extends Frame<T> {
	sigs: Map<Address, Hex>;
	hash: Hex;
}
export type Hanko = Hex;

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
	| { type: 'PROPOSE'; addrKey: string; ts: TS }
	| { type: 'SIGN'; addrKey: string; signer: Address; frameHash: Hex; sig: Hex }
	| { type: 'COMMIT'; addrKey: string; hanko: Hanko; frame: Frame<EntityState>; signers: Address[] };

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
