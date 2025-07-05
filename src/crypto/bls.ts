import { keccak_256 as keccak } from '@noble/hashes/sha3';
import { bls12_381 as bls } from '@noble/curves/bls12-381';
import type { Hex } from '../types';
import { HASH_HEX_PREFIX, ADDRESS_LENGTH } from '../constants';

const bytesToHex = (b: Uint8Array): Hex => (HASH_HEX_PREFIX + Buffer.from(b).toString('hex')) as Hex;
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
export const sign = async (msg: Uint8Array, pr: PrivKey): Promise<Hex> => bytesToHex(bls.sign(msg, pr));

export const verify = (msg: Uint8Array, sig: Hex, pb: PubKey): boolean =>
	bls.verify(hexToBytes(sig), msg, pb);

export const aggregate = (sigs: Hex[]): Hex => bytesToHex(bls.aggregateSignatures(sigs.map(hexToBytes)));

export const verifyAggregate = (hanko: Hex, msgHash: Hex, pubs: PubKey[]): boolean =>
	bls.verifyBatch(
		hexToBytes(hanko),
		pubs.map(() => hexToBytes(msgHash)),
		pubs,
	);
