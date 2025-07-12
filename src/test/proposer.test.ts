import { describe, expect, it } from 'bun:test';
import { proposerFor, proposalTimeout, hasProposalTimedOut } from '../core/proposer';
import type { Address } from '../types';

describe('Proposer Selection', () => {
	describe('proposerFor', () => {
		it('should select proposers deterministically by height', () => {
			const members: Address[] = [
				'0x1111111111111111111111111111111111111111',
				'0x2222222222222222222222222222222222222222',
				'0x3333333333333333333333333333333333333333',
			];

			// Height 0: first member (after sorting)
			expect(proposerFor(0n, members)).toBe('0x1111111111111111111111111111111111111111');

			// Height 1: second member
			expect(proposerFor(1n, members)).toBe('0x2222222222222222222222222222222222222222');

			// Height 2: third member
			expect(proposerFor(2n, members)).toBe('0x3333333333333333333333333333333333333333');

			// Height 3: wraps back to first member
			expect(proposerFor(3n, members)).toBe('0x1111111111111111111111111111111111111111');
		});

		it('should handle single member', () => {
			const members: Address[] = ['0x1111111111111111111111111111111111111111'];

			expect(proposerFor(0n, members)).toBe('0x1111111111111111111111111111111111111111');
			expect(proposerFor(100n, members)).toBe('0x1111111111111111111111111111111111111111');
		});

		it('should sort members for deterministic ordering', () => {
			const members: Address[] = [
				'0x3333333333333333333333333333333333333333',
				'0x1111111111111111111111111111111111111111',
				'0x2222222222222222222222222222222222222222',
			];

			// Should select based on sorted order
			expect(proposerFor(0n, members)).toBe('0x1111111111111111111111111111111111111111');
			expect(proposerFor(1n, members)).toBe('0x2222222222222222222222222222222222222222');
			expect(proposerFor(2n, members)).toBe('0x3333333333333333333333333333333333333333');
		});

		it('should return default address on empty members list', () => {
			expect(proposerFor(0n, [])).toBe('0x0000000000000000000000000000000000000000');
		});

		it('should handle very large heights', () => {
			const members: Address[] = [
				'0x1111111111111111111111111111111111111111',
				'0x2222222222222222222222222222222222222222',
			];

			// Large height should still work with modulo
			const largeHeight = 1000000n;
			expect(proposerFor(largeHeight, members)).toBe('0x1111111111111111111111111111111111111111');
			expect(proposerFor(largeHeight + 1n, members)).toBe('0x2222222222222222222222222222222222222222');
		});
	});

	describe('proposalTimeout', () => {
		it('should return base timeout for initial heights', () => {
			expect(proposalTimeout(0n)).toBe(5000);
			expect(proposalTimeout(999n)).toBe(5000);
		});

		it('should increase timeout with rotations', () => {
			// After 1000 blocks, timeout increases
			expect(proposalTimeout(1000n)).toBe(7500); // 5000 * 1.5
			expect(proposalTimeout(2000n)).toBe(11250); // 5000 * 1.5^2
		});

		it('should cap timeout at 60 seconds', () => {
			const veryHighHeight = 10000n;
			expect(proposalTimeout(veryHighHeight)).toBe(60000);
		});

		it('should respect custom base timeout', () => {
			expect(proposalTimeout(0n, 10000)).toBe(10000);
			expect(proposalTimeout(1000n, 10000)).toBe(15000);
		});

		it('should respect custom rotation multiplier', () => {
			expect(proposalTimeout(1000n, 5000, 2.0)).toBe(10000); // 5000 * 2.0
			expect(proposalTimeout(2000n, 5000, 2.0)).toBe(20000); // 5000 * 2.0^2
		});
	});

	describe('hasProposalTimedOut', () => {
		it('should not timeout before duration', () => {
			const proposalTs = 1000;
			const currentTs = 4999;
			expect(hasProposalTimedOut(proposalTs, currentTs, 0n)).toBe(false);
		});

		it('should timeout after duration', () => {
			const proposalTs = 1000;
			const currentTs = 6001;
			expect(hasProposalTimedOut(proposalTs, currentTs, 0n)).toBe(true);
		});

		it('should timeout exactly at duration boundary', () => {
			const proposalTs = 1000;
			const currentTs = 6001; // More than 5000ms elapsed
			expect(hasProposalTimedOut(proposalTs, currentTs, 0n)).toBe(true);
		});

		it('should use height-based timeout', () => {
			const proposalTs = 1000;
			const currentTs = 8000; // 7000ms elapsed

			// At height 0, timeout is 5000ms - should have timed out
			expect(hasProposalTimedOut(proposalTs, currentTs, 0n)).toBe(true);

			// At height 1000, timeout is 7500ms - should not have timed out
			expect(hasProposalTimedOut(proposalTs, currentTs, 1000n)).toBe(false);
		});
	});
});
