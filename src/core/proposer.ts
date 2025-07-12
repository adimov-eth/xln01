import type { Address } from '../types';

/**
 * Deterministically select a proposer for a given height from quorum members
 * Uses round-robin rotation based on height
 *
 * @param height - The block height
 * @param members - Array of quorum member addresses
 * @returns The selected proposer address
 */
export const proposerFor = (height: bigint, members: Address[]): Address => {
	if (members.length === 0) {
		// Return a default address for empty members (should not happen in practice)
		return '0x0000000000000000000000000000000000000000' as Address;
	}

	// Sort members for deterministic ordering across all nodes
	// eslint-disable-next-line fp/no-mutating-methods
	const sortedMembers = [...members].sort();

	// Use modulo to rotate through members
	const index = Number(height % BigInt(sortedMembers.length));

	return sortedMembers[index];
};

/**
 * Calculate the timeout duration for a proposal at given height
 * Increases timeout with each rotation to handle network delays
 *
 * @param height - The block height
 * @param baseTimeout - Base timeout in milliseconds (default 5000ms)
 * @param rotationMultiplier - How much to increase timeout per rotation (default 1.5x)
 * @returns Timeout duration in milliseconds
 */
export const proposalTimeout = (
	height: bigint,
	baseTimeout: number = 5000,
	rotationMultiplier: number = 1.5,
): number => {
	// Calculate how many full rotations have occurred
	// This helps determine if we're in a re-proposal scenario
	const rotation = Number(height / 1000n); // Assume rotation every 1000 blocks

	// Exponentially increase timeout with rotations, capped at 60 seconds
	const timeout = Math.min(baseTimeout * Math.pow(rotationMultiplier, rotation), 60000);

	return Math.floor(timeout);
};

/**
 * Check if a proposer should timeout and allow re-proposal
 *
 * @param proposalTimestamp - When the proposal was created
 * @param currentTimestamp - Current time
 * @param height - The block height
 * @returns True if proposal has timed out
 */
export const hasProposalTimedOut = (proposalTimestamp: number, currentTimestamp: number, height: bigint): boolean => {
	const timeout = proposalTimeout(height);
	return currentTimestamp - proposalTimestamp > timeout;
};
