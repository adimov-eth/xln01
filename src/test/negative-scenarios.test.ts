import { describe, expect, it } from '@jest/globals';
import { DEMO_ENTITY_ID, DEMO_JURISDICTION, DUMMY_SIGNATURE, INITIAL_HEIGHT } from '../constants';
import { applyCommand, applyTx, execFrame } from '../core/entity';
import { applyServerBlock } from '../core/server';
import { Address, EntityState, Frame, Hex, Input, Replica, ServerState, Transaction } from '../types';

describe('XLN Negative Path Tests', () => {
	// Helper to create a basic entity state
	const createEntityState = (): EntityState => ({
		quorum: {
			threshold: 3n,
			members: {
				'0x1111111111111111111111111111111111111111': { nonce: 0n, shares: 1n },
				'0x2222222222222222222222222222222222222222': { nonce: 0n, shares: 1n },
				'0x3333333333333333333333333333333333333333': { nonce: 0n, shares: 1n },
			},
		},
		chat: [],
	});

	// Helper to create a basic frame
	const createFrame = (state: EntityState, height = 0n): Frame<EntityState> => ({
		height,
		ts: Date.now(),
		txs: [],
		state,
	});

	// Helper to create a basic replica
	const createReplica = (state: EntityState): Replica => ({
		address: { jurisdiction: DEMO_JURISDICTION, entityId: DEMO_ENTITY_ID },
		proposer: '0x1111111111111111111111111111111111111111' as Address,
		isAwaitingSignatures: false,
		mempool: [],
		last: createFrame(state),
	});

	describe('Entity Layer Error Handling', () => {
		it('should reject transaction with invalid nonce', () => {
			const state = createEntityState();
			const tx: Transaction = {
				kind: 'chat',
				nonce: 5n, // Wrong nonce (should be 0)
				from: '0x1111111111111111111111111111111111111111' as Address,
				body: { message: 'test' },
				sig: DUMMY_SIGNATURE as Hex,
			};

			const result = applyTx({ state, transaction: tx, timestamp: Date.now() });
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toBe('Bad nonce');
			}
		});

		it('should reject transaction from non-quorum member', () => {
			const state = createEntityState();
			const tx: Transaction = {
				kind: 'chat',
				nonce: 0n,
				from: '0x9999999999999999999999999999999999999999' as Address,
				body: { message: 'test' },
				sig: DUMMY_SIGNATURE as Hex,
			};

			const result = applyTx({ state, transaction: tx, timestamp: Date.now() });
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toBe('Signer not in quorum');
			}
		});

		it('should reject transaction with unknown kind', () => {
			const state = createEntityState();
			// Create a transaction with an invalid kind by type casting
			const tx = {
				kind: 'unknown' as 'chat',
				nonce: 0n,
				from: '0x1111111111111111111111111111111111111111' as Address,
				body: { message: 'test' },
				sig: DUMMY_SIGNATURE as Hex,
			} as Transaction;

			const result = applyTx({ state, transaction: tx, timestamp: Date.now() });
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toBe('Unknown tx kind');
			}
		});

		it('should not propose when mempool is empty', () => {
			const replica = createReplica(createEntityState());
			const command = {
				type: 'PROPOSE' as const,
				addrKey: `${DEMO_JURISDICTION}:${DEMO_ENTITY_ID}`,
				ts: Date.now(),
			};

			const result = applyCommand({ replica, command });
			expect(result.isAwaitingSignatures).toBe(false);
			expect(result.proposal).toBeUndefined();
		});

		it('should ignore SIGN with mismatched frame hash', () => {
			const baseReplica = createReplica(createEntityState());
			const replica = {
				...baseReplica,
				isAwaitingSignatures: true,
				proposal: {
					...createFrame(createEntityState(), 1n),
					hash: '0x1111111111111111111111111111111111111111111111111111111111111111' as Hex,
					sigs: new Map(),
				},
			};

			const command = {
				type: 'SIGN' as const,
				addrKey: `${DEMO_JURISDICTION}:${DEMO_ENTITY_ID}`,
				signer: '0x1111111111111111111111111111111111111111' as Address,
				frameHash: '0x2222222222222222222222222222222222222222222222222222222222222222' as Hex, // Different hash
				sig: DUMMY_SIGNATURE as Hex,
			};

			const result = applyCommand({ replica, command });
			expect(result.proposal?.sigs.size).toBe(0);
		});

		it('should ignore SIGN from non-quorum member', () => {
			const baseReplica = createReplica(createEntityState());
			const replica = {
				...baseReplica,
				isAwaitingSignatures: true,
				proposal: {
					...createFrame(createEntityState(), 1n),
					hash: '0x1111111111111111111111111111111111111111111111111111111111111111' as Hex,
					sigs: new Map(),
				},
			};

			const command = {
				type: 'SIGN' as const,
				addrKey: `${DEMO_JURISDICTION}:${DEMO_ENTITY_ID}`,
				signer: '0x9999999999999999999999999999999999999999' as Address,
				frameHash: '0x1111111111111111111111111111111111111111111111111111111111111111' as Hex,
				sig: DUMMY_SIGNATURE as Hex,
			};

			const result = applyCommand({ replica, command });
			expect(result.proposal?.sigs.size).toBe(0);
		});

		it('should propagate frame execution errors', () => {
			const prev = createFrame(createEntityState());
			const badTx: Transaction = {
				kind: 'chat',
				nonce: 999n, // Invalid nonce
				from: '0x1111111111111111111111111111111111111111' as Address,
				body: { message: 'test' },
				sig: DUMMY_SIGNATURE as Hex,
			};

			const result = execFrame({ prev, transactions: [badTx], timestamp: Date.now() });
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toBe('Bad nonce');
			}
		});
	});

	describe('Server Layer Error Handling', () => {
		it('should ignore commands for non-existent replicas', () => {
			const serverState: ServerState = {
				replicas: new Map(),
				height: INITIAL_HEIGHT,
			};

			const input: Input = {
				from: '0x1111111111111111111111111111111111111111' as Address,
				to: '0x1111111111111111111111111111111111111111' as Address,
				cmd: {
					type: 'ADD_TX',
					addrKey: 'nonexistent:entity',
					tx: {
						kind: 'chat',
						nonce: 0n,
						from: '0x1111111111111111111111111111111111111111' as Address,
						body: { message: 'test' },
						sig: DUMMY_SIGNATURE as Hex,
					},
				},
			};

			const result = applyServerBlock({
				prev: serverState,
				batch: [input],
				timestamp: Date.now(),
			});

			// Command should be ignored, no state change
			expect(result.state.replicas.size).toBe(0);
			expect(result.outbox.length).toBe(0);
		});

		it('should handle frame build errors gracefully', () => {
			const state = createEntityState();
			const baseReplica = createReplica(state);

			// Create replica with a transaction that will fail
			const replica: Replica = {
				...baseReplica,
				mempool: [
					{
						kind: 'chat' as const,
						nonce: 999n, // Invalid nonce
						from: '0x1111111111111111111111111111111111111111' as Address,
						body: { message: 'test' },
						sig: DUMMY_SIGNATURE as Hex,
					},
				],
			};

			const serverState: ServerState = {
				replicas: new Map([
					[`${DEMO_JURISDICTION}:${DEMO_ENTITY_ID}:0x1111111111111111111111111111111111111111`, replica],
				]),
				height: INITIAL_HEIGHT,
			};

			const input: Input = {
				from: '0x1111111111111111111111111111111111111111' as Address,
				to: '0x1111111111111111111111111111111111111111' as Address,
				cmd: {
					type: 'PROPOSE',
					addrKey: `${DEMO_JURISDICTION}:${DEMO_ENTITY_ID}`,
					ts: Date.now(),
				},
			};

			const result = applyServerBlock({
				prev: serverState,
				batch: [input],
				timestamp: Date.now(),
			});

			// Proposal should not be created due to frame build error
			const updatedReplica = result.state.replicas.get(
				`${DEMO_JURISDICTION}:${DEMO_ENTITY_ID}:0x1111111111111111111111111111111111111111`,
			);
			expect(updatedReplica?.proposal).toBeUndefined();
			expect(updatedReplica?.isAwaitingSignatures).toBe(false);
		});
	});

	describe('Consensus Edge Cases', () => {
		it('should handle single-signer quorum correctly', () => {
			const state: EntityState = {
				quorum: {
					threshold: 1n, // Single signer can commit
					members: {
						'0x1111111111111111111111111111111111111111': { nonce: 0n, shares: 1n },
					},
				},
				chat: [],
			};

			const baseReplica = createReplica(state);
			const replica: Replica = {
				...baseReplica,
				mempool: [
					{
						kind: 'chat' as const,
						nonce: 0n,
						from: '0x1111111111111111111111111111111111111111' as Address,
						body: { message: 'test' },
						sig: DUMMY_SIGNATURE as Hex,
					},
				],
			};

			const command = {
				type: 'PROPOSE' as const,
				addrKey: `${DEMO_JURISDICTION}:${DEMO_ENTITY_ID}`,
				ts: Date.now(),
			};

			const result = applyCommand({ replica, command });

			// Should seed proposer's signature for single-signer quorum
			expect(result.proposal?.sigs.has('0x1111111111111111111111111111111111111111')).toBe(true);
			expect(result.proposal?.sigs.get('0x1111111111111111111111111111111111111111')).toBe(DUMMY_SIGNATURE);
		});

		it('should not double-sign the same proposal', () => {
			const baseReplica = createReplica(createEntityState());
			const replica = {
				...baseReplica,
				isAwaitingSignatures: true,
				proposal: {
					...createFrame(createEntityState(), 1n),
					hash: '0x1111111111111111111111111111111111111111111111111111111111111111' as Hex,
					sigs: new Map([['0x1111111111111111111111111111111111111111' as Address, DUMMY_SIGNATURE as Hex]]),
				},
			};

			const command = {
				type: 'SIGN' as const,
				addrKey: `${DEMO_JURISDICTION}:${DEMO_ENTITY_ID}`,
				signer: '0x1111111111111111111111111111111111111111' as Address, // Already signed
				frameHash: '0x1111111111111111111111111111111111111111111111111111111111111111' as Hex,
				sig: '0x3333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333' as Hex,
			};

			const result = applyCommand({ replica, command });

			// Should still have only one signature
			expect(result.proposal?.sigs.size).toBe(1);
			expect(result.proposal?.sigs.get('0x1111111111111111111111111111111111111111')).toBe(DUMMY_SIGNATURE); // Original sig unchanged
		});

		it('should handle COMMIT validation failures', () => {
			const replica = createReplica(createEntityState());

			const command = {
				type: 'COMMIT' as const,
				addrKey: `${DEMO_JURISDICTION}:${DEMO_ENTITY_ID}`,
				frame: createFrame(createEntityState(), 5n), // Wrong height (should be 1)
				hanko: DUMMY_SIGNATURE as Hex,
				signers: ['0x1111111111111111111111111111111111111111' as Address],
			};

			const result = applyCommand({ replica, command });

			// State should remain unchanged
			expect(result.last.height).toBe(0n);
			expect(result.isAwaitingSignatures).toBe(false);
		});
	});
});
