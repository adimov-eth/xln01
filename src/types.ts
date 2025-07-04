/* Primitive brands */
export type Hex = `0x${string}`;
export type Address = Hex;
export type UInt64 = bigint;
export type Nonce = UInt64;
export type TS = number;

/* Signer and quorum */
export interface SignerRecord {
  nonce: Nonce;
  shares: number;
}
export interface Quorum {
  threshold: number;
  members: Record<Address, SignerRecord>;
}

/* Entity state */
export interface EntityState {
  quorum: Quorum;
  chat: { from: Address; msg: string; ts: TS }[];
}

/* Transactions */
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

/* Frames */
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

/* Replica addressing */
export interface ReplicaAddr {
  jurisdiction: string;
  entityId: string;
  signerId?: string;
}
export const addrKey = (a: ReplicaAddr) => `${a.jurisdiction}:${a.entityId}`;

/* Replica runtime view */
export interface Replica {
  address: ReplicaAddr;
  proposer: Address;
  isAwaitingSignatures: boolean;
  mempool: Transaction[];
  last: Frame<EntityState>;
  proposal?: ProposedFrame<EntityState>;
}

/* Commands */
export type Command =
  | { type: 'IMPORT'; replica: Replica }
  | { type: 'ADD_TX'; addrKey: string; tx: Transaction }
  | { type: 'PROPOSE'; addrKey: string; ts: TS }
  | { type: 'SIGN'; addrKey: string; signer: Address; frameHash: Hex; sig: Hex }
  | { type: 'COMMIT'; addrKey: string; hanko: Hanko; frame: Frame<EntityState> };

/* Input envelope */
export interface Input {
  from: Address;
  to: Address;
  cmd: Command;
}

/* Server frame */
export interface ServerFrame {
  height: UInt64;
  ts: TS;
  inputs: Input[];
  root: Hex;
  hash: Hex;
}

/* Server state */
export interface ServerState {
  height: UInt64;
  replicas: Map<string, Replica>;
}
