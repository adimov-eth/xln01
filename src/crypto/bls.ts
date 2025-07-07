import { bls12_381 as bls } from '@noble/curves/bls12-381';
import { keccak_256 as keccak } from '@noble/hashes/sha3';
import { ADDRESS_LENGTH, HEX_PREFIX_LENGTH } from '../constants';
import type { Hex } from '../types';

const convertBytesToHex = (bytes: Uint8Array): Hex => `0x${Buffer.from(bytes).toString('hex')}`;
const convertHexToBytes = (hex: Hex) => Uint8Array.from(Buffer.from(hex.slice(HEX_PREFIX_LENGTH), 'hex'));

/* ──────────── key helpers ──────────── */
export type PrivKey = Uint8Array;
export type PubKey = Uint8Array;

export const randomPriv = (): PrivKey => bls.utils.randomPrivateKey();

export interface GetPublicKeyParams {
	privateKey: PrivKey;
}

export const getPublicKey = ({ privateKey }: GetPublicKeyParams): PubKey => bls.getPublicKey(privateKey);

export interface DeriveAddressParams {
	publicKey: PubKey;
}

export const deriveAddress = ({ publicKey }: DeriveAddressParams): Hex => {
	const hash = keccak(publicKey);
	return convertBytesToHex(hash.slice(-ADDRESS_LENGTH));
	// take rightmost 20 bytes of keccak(pubkey) as address (ETH-style)
};

/* ──────────── RORO Pattern Types ──────────── */
export interface SignParams {
	message: Uint8Array;
	privateKey: PrivKey;
}

export interface VerifyParams {
	message: Uint8Array;
	signature: Hex;
	publicKey: PubKey;
}

export interface VerifyAggregateParams {
	hanko: Hex;
	messageHash: Hex;
	publicKeys: PubKey[];
}

/* ──────────── signatures ──────────── */
export const sign = ({ message, privateKey }: SignParams): Hex => convertBytesToHex(bls.sign(message, privateKey));

export const verify = ({ message, signature, publicKey }: VerifyParams): boolean =>
	bls.verify(convertHexToBytes(signature), message, publicKey);

export interface AggregateParams {
	signatures: Hex[];
}

export const aggregate = ({ signatures }: AggregateParams): Hex =>
	convertBytesToHex(bls.aggregateSignatures(signatures.map(convertHexToBytes)));

export const verifyAggregate = ({ hanko, messageHash, publicKeys }: VerifyAggregateParams): boolean =>
	bls.verifyBatch(
		convertHexToBytes(hanko),
		publicKeys.map(() => convertHexToBytes(messageHash)),
		publicKeys,
	);
