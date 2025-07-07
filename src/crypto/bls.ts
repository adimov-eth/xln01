import { bls12_381 } from '@noble/curves/bls12-381';
import { keccak_256 as keccak } from '@noble/hashes/sha3';
import { ADDRESS_LENGTH } from '../constants';
import type { Hex } from '../types';

const bls = bls12_381;

const bytesToHex = (b: Uint8Array): Hex => `0x${Buffer.from(b).toString('hex')}`;
const hexToBytes = (h: Hex) => Uint8Array.from(Buffer.from(h.slice(2), 'hex'));

/* ──────────── key helpers ──────────── */
export type PrivKey = Uint8Array;
export type PubKey = Uint8Array;

export const randomPriv = (): PrivKey => bls.utils.randomPrivateKey();
export const pub = (pr: PrivKey): PubKey => bls.getPublicKey(pr);
export const addr = (pb: PubKey): Hex => {
	const h = keccak(pb);
	return bytesToHex(h.slice(-ADDRESS_LENGTH));
	// take rightmost 20 bytes of keccak(pubkey) as address (ETH-style)
};

/* ──────────── signatures ──────────── */
export const sign = (msg: Uint8Array, pr: PrivKey): Hex => bytesToHex(bls.sign(msg, pr));

export const verify = (msg: Uint8Array, sig: Hex, pb: PubKey): boolean => bls.verify(hexToBytes(sig), msg, pb);

export const aggregate = (sigs: Hex[]): Hex => bytesToHex(bls.aggregateSignatures(sigs.map(hexToBytes)));

export const verifyAggregate = (hanko: Hex, msgHash: Hex, pubs: PubKey[]): boolean =>
	bls.verifyBatch(
		hexToBytes(hanko),
		pubs.map(() => hexToBytes(msgHash)),
		pubs,
	);
