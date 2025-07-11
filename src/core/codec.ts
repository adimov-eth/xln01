import { keccak_256 as keccak } from '@noble/hashes/sha3';
import * as rlp from 'rlp';
import type { EntityState, Hex, Quorum, Transaction } from '../types';

interface FrameHeader {
	height: bigint;
	timestamp: number;
	parentHash: Hex;
	proposer: Hex;
}

const convertBigIntToBuffer = (n: bigint): Buffer => {
	if (n === 0n) return Buffer.alloc(0);
	const hex = n.toString(16);
	return Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex');
};

const hexToBuf = (hex: Hex): Buffer => Buffer.from(hex.startsWith('0x') ? hex.slice(2) : hex, 'hex');

const encodeHeader = (h: FrameHeader): Buffer[] => [
	convertBigIntToBuffer(h.height),
	convertBigIntToBuffer(BigInt(h.timestamp)),
	hexToBuf(h.parentHash),
	hexToBuf(h.proposer),
];

const encodeTx = (tx: Transaction): Buffer[] => [
	Buffer.from(tx.kind),
	convertBigIntToBuffer(tx.nonce),
	hexToBuf(tx.from),
	Buffer.from(JSON.stringify(tx.body)),
	hexToBuf(tx.sig),
];

export const encodeFrame = (h: FrameHeader, txs: readonly Transaction[]): Uint8Array =>
	rlp.encode([encodeHeader(h), txs.map(encodeTx)]);

export const hashFrame = (h: FrameHeader, txs: readonly Transaction[]): Hex =>
	`0x${Buffer.from(keccak(encodeFrame(h, txs))).toString('hex')}`;

export const encodeQuorum = (quorum: Quorum): Uint8Array => {
	// eslint-disable-next-line fp/no-mutating-methods
	const sortedEntries = [...Object.entries(quorum.members)].sort(([a], [b]) => a.localeCompare(b));
	return rlp.encode([
		convertBigIntToBuffer(BigInt(quorum.threshold)),
		sortedEntries.map(([addr, member]) => [
			hexToBuf(addr as Hex),
			convertBigIntToBuffer(member.nonce),
			convertBigIntToBuffer(member.shares),
		]),
	]);
};

export const hashQuorum = (quorum: Quorum): Hex => `0x${Buffer.from(keccak(encodeQuorum(quorum))).toString('hex')}`;

export const encodeEntityState = (state: EntityState): Uint8Array =>
	rlp.encode([
		encodeQuorum(state.quorum),
		state.chat.map(c => [hexToBuf(c.from), Buffer.from(c.msg), convertBigIntToBuffer(BigInt(c.ts))]),
	]);

export const computeStateRoot = (state: EntityState): Hex =>
	`0x${Buffer.from(keccak(encodeEntityState(state))).toString('hex')}`;
