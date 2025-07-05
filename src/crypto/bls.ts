import { keccak_256 as keccak } from '@noble/hashes/sha3';
import { bls12_381 as bls } from '@noble/curves/bls12-381';
import type { Hex } from '../types';

const bytesToHex = (b: Uint8Array): Hex =>
  ('0x' + Buffer.from(b).toString('hex')) as Hex;
const hexToBytes = (h: Hex) =>
  Uint8Array.from(Buffer.from(h.slice(2), 'hex'));

/* ──────────── key helpers ──────────── */
export type PrivKey = Uint8Array;
export type PubKey  = Uint8Array;

export const randomPriv = (): PrivKey =>
  bls.utils.randomPrivateKey();
export const pub = (pr: PrivKey): PubKey =>
  bls.getPublicKey(pr);
export const addr = (pb: PubKey): Hex => {
  const h = keccak(pb);
  return bytesToHex(h.slice(-20));
  // take rightmost 20 bytes of keccak(pubkey) as address (ETH-style)
};

/* ──────────── signatures ──────────── */
export const sign = async (msg: Uint8Array, pr: PrivKey): Promise<Hex> =>
  bytesToHex(await bls.sign(msg, pr));

export const verify = async (msg: Uint8Array, sig: Hex, pb: PubKey): Promise<boolean> =>
  bls.verify(hexToBytes(sig), msg, pb);

export const aggregate = (sigs: Hex[]): Hex =>
  bytesToHex(bls.aggregateSignatures(sigs.map(hexToBytes)));

export const verifyAggregate = (
  hanko: Hex, msgHash: Hex, pubs: PubKey[],
): boolean => bls.verifyMultipleAggregate(
  hexToBytes(hanko),
  pubs,
  pubs.map(() => hexToBytes(msgHash)),
);