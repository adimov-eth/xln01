import type { Hex, Result } from '../types';
import { err, ok } from '../types';
import { type PubKey, verify as blsVerifyRaw, verifyAggregate as blsVerifyAggregateRaw } from '../crypto/bls';

export interface VerifyInput {
	sig: Hex;
	msgHash: Hex;
	pubKeys: PubKey[];
}

export interface VerifySingleInput {
	sig: Hex;
	message: Uint8Array;
	pubKey: PubKey;
}

/**
 * Functional wrapper for BLS signature verification.
 * Returns Result<true, Error> for consistent error handling.
 */
export const blsVerify = ({ sig, message, pubKey }: VerifySingleInput): Result<true, Error> => {
	try {
		const isValid = blsVerifyRaw({ message, signature: sig, publicKey: pubKey });
		return isValid ? ok(true) : err(new Error('Invalid signature'));
	} catch (e) {
		return err(e as Error);
	}
};

/**
 * Functional wrapper for BLS aggregate signature verification.
 * Returns Result<true, Error> for consistent error handling.
 */
export const blsVerifyAggregate = ({ sig, msgHash, pubKeys }: VerifyInput): Result<true, Error> => {
	try {
		const isValid = blsVerifyAggregateRaw({ hanko: sig, messageHash: msgHash, publicKeys: pubKeys });
		return isValid ? ok(true) : err(new Error('Invalid aggregate signature'));
	} catch (e) {
		return err(e as Error);
	}
};

// Re-export the pure functions that don't need wrapping
export { aggregate as blsAggregate } from '../crypto/bls';
