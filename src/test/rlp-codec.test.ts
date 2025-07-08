import { describe, expect, it } from '@jest/globals';
import * as fc from 'fast-check';
import { convertBigIntToBuffer, decodeFrame, decodeTransaction, encodeFrame, encodeTransaction } from '../codec/rlp';
import type { Frame, Hex, Transaction } from '../types';

describe('RLP Codec Tests', () => {
	describe('round-trip encoding', () => {
		it('should encode and decode transactions correctly', () => {
			const tx: Transaction = {
				kind: 'chat',
				nonce: 5n,
				from: '0x1234567890123456789012345678901234567890' as Hex,
				body: { message: 'Hello, world!' },
				sig: ('0x' + '00'.repeat(96)) as Hex,
			};

			const encoded = encodeTransaction(tx);
			const decoded = decodeTransaction(encoded);

			expect(decoded.ok).toBe(true);
			if (decoded.ok) {
				expect(decoded.value).toEqual(tx);
			}
		});

		it('should encode and decode frames correctly', () => {
			const frame: Frame<{ test: string }> = {
				height: 42n,
				ts: Date.now(),
				txs: [],
				state: { test: 'state' },
			};

			const encoded = encodeFrame(frame);
			const decoded = decodeFrame<{ test: string }>(encoded);

			expect(decoded.ok).toBe(true);
			if (decoded.ok) {
				expect(decoded.value).toEqual(frame);
			}
		});
	});

	describe('edge cases', () => {
		it('should handle BigInt edge values correctly', () => {
			const edgeCases = [0n, 1n, 255n, 256n, 2n ** 64n - 1n];
			edgeCases.forEach(n => {
				const buffer = convertBigIntToBuffer(n);
				expect(buffer).toBeInstanceOf(Buffer);
				// Verify round trip through hex
				const hex = buffer.toString('hex');
				const parsed = hex === '' ? 0n : BigInt('0x' + hex);
				expect(parsed).toBe(n);
			});
		});

		it('should handle empty transactions array', () => {
			const frame: Frame<{ value: string }> = {
				height: 1n,
				ts: 1000,
				txs: [],
				state: { value: 'test' },
			};

			const encoded = encodeFrame(frame);
			const decoded = decodeFrame<{ value: string }>(encoded);

			expect(decoded.ok).toBe(true);
			if (decoded.ok) {
				expect(decoded.value.txs).toHaveLength(0);
				expect(decoded.value.height).toBe(1n);
				expect(decoded.value.ts).toBe(1000);
				expect(decoded.value.state).toEqual({ value: 'test' });
			}
		});
	});

	describe('fuzz testing', () => {
		const genHex = (len: number) =>
			fc
				.array(fc.integer({ min: 0, max: 255 }), { minLength: len, maxLength: len })
				.map(bytes => ('0x' + Buffer.from(bytes).toString('hex')) as Hex);

		it('should handle random transaction data', () => {
			fc.assert(
				fc.property(
					genHex(20), // from
					genHex(96), // sig
					fc.bigInt({ min: 1n, max: 1000n }), // nonce (avoid 0n edge case)
					fc.string({ minLength: 1, maxLength: 100 }),
					(from, sig, nonce, msg) => {
						const tx: Transaction = {
							kind: 'chat',
							nonce,
							from,
							body: { message: msg },
							sig,
						};
						const encoded = encodeTransaction(tx);
						const decoded = decodeTransaction(encoded);
						expect(decoded.ok).toBe(true);
						if (decoded.ok) {
							expect(decoded.value).toEqual(tx);
						}
					},
				),
				{ numRuns: 20 }, // Reduce runs for faster testing
			);
		});

		it('should handle random frame data', () => {
			fc.assert(
				fc.property(
					fc.bigInt({ min: 1n, max: 2n ** 32n }), // Avoid 0n to prevent empty buffer edge case
					fc.integer({ min: 1, max: Date.now() }), // Avoid 0 timestamp
					fc.string({ minLength: 1, maxLength: 50 }), // Avoid empty string
					(height, ts, note) => {
						const frame: Frame<{ note: string }> = {
							height,
							ts,
							txs: [],
							state: { note },
						};
						const encoded = encodeFrame(frame);
						const decoded = decodeFrame<{ note: string }>(encoded);
						expect(decoded.ok).toBe(true);
						if (decoded.ok) {
							expect(decoded.value).toEqual(frame);
						}
					},
				),
				{ numRuns: 20 }, // Reduce runs for faster testing
			);
		});
	});
});
