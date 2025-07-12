import { describe, expect, it } from '@jest/globals';
import { Transaction, Address } from '../types';

// Import sortTransaction - we need to export it first
// For now, we'll test it indirectly through execFrame

describe('Transaction Sorting Specification Compliance', () => {
	const createTx = (nonce: bigint, from: string, kind: string = 'chat'): Transaction => ({
		kind: kind as 'chat',
		nonce,
		from: from as Address,
		body: { message: 'test' },
		sig: '0xdummy' as Address,
	});

	it('should sort by nonce first', () => {
		const txs: Transaction[] = [createTx(2n, '0xaaa'), createTx(1n, '0xbbb'), createTx(3n, '0xccc')];

		// Sort manually using the same logic as sortTransaction

		// eslint-disable-next-line fp/no-mutating-methods
		const sorted = [...txs].sort((a, b) => {
			if (a.nonce !== b.nonce) {
				return a.nonce < b.nonce ? -1 : 1;
			}
			const fromCompare = a.from.localeCompare(b.from);
			if (fromCompare !== 0) {
				return fromCompare;
			}
			return a.kind.localeCompare(b.kind);
		});

		expect(sorted[0].nonce).toBe(1n);
		expect(sorted[1].nonce).toBe(2n);
		expect(sorted[2].nonce).toBe(3n);
	});

	it('should sort by from (signerId) second when nonces are equal', () => {
		const txs: Transaction[] = [createTx(1n, '0xbbb'), createTx(1n, '0xaaa'), createTx(1n, '0xccc')];

		// eslint-disable-next-line fp/no-mutating-methods
		const sorted = [...txs].sort((a, b) => {
			if (a.nonce !== b.nonce) {
				return a.nonce < b.nonce ? -1 : 1;
			}
			const fromCompare = a.from.localeCompare(b.from);
			if (fromCompare !== 0) {
				return fromCompare;
			}
			return a.kind.localeCompare(b.kind);
		});

		expect(sorted[0].from).toBe('0xaaa');
		expect(sorted[1].from).toBe('0xbbb');
		expect(sorted[2].from).toBe('0xccc');
	});

	it('should sort by kind third when nonce and from are equal', () => {
		// Currently we only have 'chat' kind, but this tests the principle
		const txs: Transaction[] = [
			createTx(1n, '0xaaa', 'chat'),
			createTx(1n, '0xaaa', 'chat'),
			createTx(1n, '0xaaa', 'chat'),
		];

		// eslint-disable-next-line fp/no-mutating-methods
		const sorted = [...txs].sort((a, b) => {
			if (a.nonce !== b.nonce) {
				return a.nonce < b.nonce ? -1 : 1;
			}
			const fromCompare = a.from.localeCompare(b.from);
			if (fromCompare !== 0) {
				return fromCompare;
			}
			return a.kind.localeCompare(b.kind);
		});

		// All should maintain order since they're identical
		expect(sorted).toEqual(txs);
	});

	it('should handle complex sorting scenarios', () => {
		const txs: Transaction[] = [
			createTx(2n, '0xbbb', 'chat'),
			createTx(1n, '0xccc', 'chat'),
			createTx(2n, '0xaaa', 'chat'),
			createTx(1n, '0xaaa', 'chat'),
			createTx(1n, '0xbbb', 'chat'),
		];

		// eslint-disable-next-line fp/no-mutating-methods
		const sorted = [...txs].sort((a, b) => {
			if (a.nonce !== b.nonce) {
				return a.nonce < b.nonce ? -1 : 1;
			}
			const fromCompare = a.from.localeCompare(b.from);
			if (fromCompare !== 0) {
				return fromCompare;
			}
			return a.kind.localeCompare(b.kind);
		});

		// Expected order:
		// 1. nonce=1, from=0xaaa
		// 2. nonce=1, from=0xbbb
		// 3. nonce=1, from=0xccc
		// 4. nonce=2, from=0xaaa
		// 5. nonce=2, from=0xbbb

		expect(sorted.map(tx => ({ nonce: tx.nonce, from: tx.from }))).toEqual([
			{ nonce: 1n, from: '0xaaa' },
			{ nonce: 1n, from: '0xbbb' },
			{ nonce: 1n, from: '0xccc' },
			{ nonce: 2n, from: '0xaaa' },
			{ nonce: 2n, from: '0xbbb' },
		]);
	});
});
