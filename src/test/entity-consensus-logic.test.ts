import { describe, expect, it } from 'bun:test';
import { DUMMY_SIGNATURE } from '../constants';
import { applyCommand } from '../core/entity';
import type { Address, EntityState, Frame, Hex, Replica } from '../types';

const createEntityState = (): EntityState => ({
	quorum: {
		members: {
			'0x1111111111111111111111111111111111111111': { nonce: 0n, shares: 1n },
			'0x2222222222222222222222222222222222222222': { nonce: 0n, shares: 1n },
			'0x3333333333333333333333333333333333333333': { nonce: 0n, shares: 1n },
		},
		threshold: 2n,
	},
	chat: [],
});

const createFrame = (state: EntityState, height = 0n): Frame<EntityState> => ({
	height,
	ts: Date.now(),
	txs: [],
	state,
});

const createReplica = (state: EntityState): Replica => ({
	address: { jurisdiction: 'test', entityId: 'entity' },
	proposer: '0x1111111111111111111111111111111111111111' as Address,
	isAwaitingSignatures: false,
	mempool: [],
	last: createFrame(state),
	proposal: undefined,
});

describe('Entity Layer Consensus Logic', () => {
	it('should generate SIGN commands when PROPOSE creates a proposal', () => {
		const replica = createReplica(createEntityState());
		const replicaWithMempool = {
			...replica,
			mempool: [
				{
					kind: 'chat' as const,
					nonce: 0n,
					from: '0x1111111111111111111111111111111111111111' as Address,
					body: { message: 'test' },
					sig: DUMMY_SIGNATURE,
				},
			],
		};

		const result = applyCommand({
			replica: replicaWithMempool,
			command: {
				type: 'PROPOSE',
				addrKey: 'test:entity',
				ts: Date.now(),
			},
		});

		// Should create proposal
		expect(result.replica.isAwaitingSignatures).toBe(true);
		expect(result.replica.proposal).toBeDefined();

		// Should generate SIGN commands for all quorum members
		expect(result.outbox.length).toBe(3);
		expect(result.outbox.every(input => input.cmd.type === 'SIGN')).toBe(true);
		// eslint-disable-next-line
		expect(result.outbox.map(input => input.from).sort()).toEqual([
			'0x1111111111111111111111111111111111111111',
			'0x2222222222222222222222222222222222222222',
			'0x3333333333333333333333333333333333333333',
		]);
	});

	it('should generate COMMIT commands when threshold is reached', () => {
		const baseReplica = createReplica(createEntityState());
		const proposalHash = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890' as Hex;

		const replica = {
			...baseReplica,
			isAwaitingSignatures: true,
			proposal: {
				...createFrame(createEntityState(), 1n),
				hash: proposalHash,
				sigs: new Map<Address, Hex>([['0x1111111111111111111111111111111111111111' as Address, DUMMY_SIGNATURE]]),
			},
		};

		// Add the second signature (reaching threshold of 2)
		const result = applyCommand({
			replica,
			command: {
				type: 'SIGN',
				addrKey: 'test:entity',
				signer: '0x2222222222222222222222222222222222222222' as Address,
				frameHash: proposalHash,
				sig: DUMMY_SIGNATURE,
			},
		});

		// Should update the proposal with new signature
		expect(result.replica.proposal?.sigs.size).toBe(2);

		// Should generate COMMIT commands for all quorum members
		expect(result.outbox.length).toBe(3);
		expect(result.outbox.every(input => input.cmd.type === 'COMMIT')).toBe(true);
		// eslint-disable-next-line
		expect(result.outbox.map(input => input.to).sort()).toEqual([
			'0x1111111111111111111111111111111111111111',
			'0x2222222222222222222222222222222222222222',
			'0x3333333333333333333333333333333333333333',
		]);
	});

	it('should not generate COMMIT commands when threshold is not reached', () => {
		const baseReplica = createReplica(createEntityState());
		const proposalHash = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890' as Hex;

		const replica = {
			...baseReplica,
			isAwaitingSignatures: true,
			proposal: {
				...createFrame(createEntityState(), 1n),
				hash: proposalHash,
				sigs: new Map<Address, Hex>(), // No signatures yet
			},
		};

		// Add the first signature (not reaching threshold of 2)
		const result = applyCommand({
			replica,
			command: {
				type: 'SIGN',
				addrKey: 'test:entity',
				signer: '0x1111111111111111111111111111111111111111' as Address,
				frameHash: proposalHash,
				sig: DUMMY_SIGNATURE,
			},
		});

		// Should update the proposal with new signature
		expect(result.replica.proposal?.sigs.size).toBe(1);

		// Should NOT generate any commands
		expect(result.outbox.length).toBe(0);
	});
});
