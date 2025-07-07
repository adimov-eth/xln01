import { bls12_381 as bls } from '@noble/curves/bls12-381';
import { keccak_256 as keccak } from '@noble/hashes/sha3';
import { ADDRESS_LENGTH } from '../constants';
import type { Hex } from '../types';

export type PrivKey = Uint8Array;
export type PubKey = Uint8Array;

export const randomPriv = (): PrivKey => bls.utils.randomPrivateKey();

export const getPublicKey = (privateKey: PrivKey): PubKey => bls.getPublicKey(privateKey);

export const deriveAddress = (publicKey: PubKey): Hex => {
	const hash = keccak(publicKey);
	return `0x${Buffer.from(hash.slice(-ADDRESS_LENGTH)).toString('hex')}`;
};

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

export const sign = ({ message, privateKey }: SignParams): Hex =>
	`0x${Buffer.from(bls.sign(message, privateKey)).toString('hex')}`;

export const verify = ({ message, signature, publicKey }: VerifyParams): boolean =>
	bls.verify(Uint8Array.from(Buffer.from(signature.slice(2), 'hex')), message, publicKey);

export const aggregate = (signatures: Hex[]): Hex =>
	`0x${Buffer.from(bls.aggregateSignatures(signatures.map(sig => Uint8Array.from(Buffer.from(sig.slice(2), 'hex'))))).toString('hex')}`;

export const verifyAggregate = ({ hanko, messageHash, publicKeys }: VerifyAggregateParams): boolean =>
	bls.verifyBatch(
		Uint8Array.from(Buffer.from(hanko.slice(2), 'hex')),
		publicKeys.map(() => Uint8Array.from(Buffer.from(messageHash.slice(2), 'hex'))),
		publicKeys,
	);
