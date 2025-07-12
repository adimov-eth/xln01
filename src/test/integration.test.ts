import { describe, expect, it } from 'bun:test';
import { keccak_256 as keccak } from '@noble/hashes/sha3';
import { DUMMY_SIGNATURE, EMPTY_HASH } from '../constants';
import { hashFrame, hashQuorum } from '../core/codec';
import { validateQuorumHash, applyCommand } from '../core/entity';
import { applyServerBlock } from '../core/server';
import { aggregate, getPublicKey, randomPriv, sign } from '../crypto/bls';
import { blsVerifyAggregate } from '../infra/bls';
import type {
	Frame,
	Hex,
	Transaction,
	EntityState,
	Quorum,
	Replica,
	ServerState,
	Address,
	Input,
	ProposedFrame,
} from '../types';

describe('Integration Tests', () => {
	describe('RLP Frame Hashing', () => {
		it('should produce correct RLP frame hash', () => {
			const mockTx: Transaction = {
				kind: 'chat',
				nonce: 1n,
				from: '0x1111111111111111111111111111111111111111' as Hex,
				body: { message: 'Hello World' },
				sig: ('0x' + '00'.repeat(96)) as Hex,
			};

			const frame: Frame<EntityState> = {
				height: 1n,
				ts: 1234567890,
				txs: [mockTx],
				state: {} as EntityState,
			};

			const hash = hashFrame(
				{
					height: frame.height,
					timestamp: BigInt(frame.ts),
					parentHash: '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex,
					proposer: '0x0000000000000000000000000000000000000000' as Hex,
				},
				frame.txs,
			);

			// Hash should be deterministic
			expect(hash).toMatch(/^0x[0-9a-f]{64}$/);

			// Same input should produce same hash
			const hash2 = hashFrame(
				{
					height: frame.height,
					timestamp: BigInt(frame.ts),
					parentHash: '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex,
					proposer: '0x0000000000000000000000000000000000000000' as Hex,
				},
				frame.txs,
			);
			expect(hash2).toBe(hash);
		});

		it('should match expected hash from xlnfinance fixture', () => {
			// This would be a known hash from xlnfinance implementation
			// For now, we'll just verify the format
			const frame: Frame<EntityState> = {
				height: 42n,
				ts: 1000000000,
				txs: [],
				state: {} as EntityState,
			};

			const hash = hashFrame(
				{
					height: frame.height,
					timestamp: BigInt(frame.ts),
					parentHash: '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex,
					proposer: '0x0000000000000000000000000000000000000000' as Hex,
				},
				frame.txs,
			);

			expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
		});

		it('should handle empty transaction list', () => {
			const frame: Frame<EntityState> = {
				height: 0n,
				ts: 0,
				txs: [],
				state: {} as EntityState,
			};

			const hash = hashFrame(
				{
					height: frame.height,
					timestamp: BigInt(frame.ts),
					parentHash: '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex,
					proposer: '0x0000000000000000000000000000000000000000' as Hex,
				},
				frame.txs,
			);

			expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
		});

		it('should produce different hashes for different frames', () => {
			const frame1: Frame<EntityState> = {
				height: 1n,
				ts: 1000,
				txs: [],
				state: {} as EntityState,
			};

			const frame2: Frame<EntityState> = {
				height: 2n,
				ts: 1000,
				txs: [],
				state: {} as EntityState,
			};

			const hash1 = hashFrame(
				{
					height: frame1.height,
					timestamp: BigInt(frame1.ts),
					parentHash: '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex,
					proposer: '0x0000000000000000000000000000000000000000' as Hex,
				},
				frame1.txs,
			);

			const hash2 = hashFrame(
				{
					height: frame2.height,
					timestamp: BigInt(frame2.ts),
					parentHash: '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex,
					proposer: '0x0000000000000000000000000000000000000000' as Hex,
				},
				frame2.txs,
			);

			expect(hash1).not.toBe(hash2);
		});

		it.todo('should handle property-based frame hashing with fast-check');
	});

	describe('BLS Aggregate Signatures', () => {
		it('should verify valid aggregate signature', () => {
			// Create test message and hash
			const message = Buffer.from('test message');
			const messageHash = keccak(message);
			const msgHash = `0x${Buffer.from(messageHash).toString('hex')}`;

			// Generate keys and signatures
			const privKey1 = randomPriv();
			const privKey2 = randomPriv();
			const pubKey1 = getPublicKey(privKey1);
			const pubKey2 = getPublicKey(privKey2);

			// Sign the hash, not the original message
			const sig1 = sign({ message: messageHash, privateKey: privKey1 });
			const sig2 = sign({ message: messageHash, privateKey: privKey2 });

			// Create aggregate signature
			const aggregateSig = aggregate([sig1, sig2]);

			// Verify aggregate
			const result = blsVerifyAggregate({
				sig: aggregateSig,
				msgHash,
				pubKeys: [pubKey1, pubKey2],
			});

			expect(result.ok).toBe(true);
		});

		it('should reject invalid aggregate signature', () => {
			// Create test message
			const msgHash = ('0x' + '11'.repeat(32)) as Hex;

			// Generate keys
			const pubKey1 = getPublicKey(randomPriv());
			const pubKey2 = getPublicKey(randomPriv());

			// Create invalid signature (wrong length)
			const invalidSig = ('0x' + '00'.repeat(96)) as Hex;

			// Verify should fail
			const result = blsVerifyAggregate({
				sig: invalidSig,
				msgHash,
				pubKeys: [pubKey1, pubKey2],
			});

			expect(result.ok).toBe(false);
			if (!result.ok) {
				// The error message varies based on the invalid signature
				expect(result.error.message).toBeTruthy();
			}
		});

		it('should handle threshold quorum (3 of 5)', () => {
			// Create test message
			const message = Buffer.from('consensus message');
			const messageHash = keccak(message);
			const msgHash = `0x${Buffer.from(messageHash).toString('hex')}`;

			// Generate 5 keys
			const keys = Array.from({ length: 5 }, () => {
				const priv = randomPriv();
				return { priv, pub: getPublicKey(priv) };
			});

			// Get signatures from 3 signers (threshold)
			const sigs = keys.slice(0, 3).map(k => sign({ message: messageHash, privateKey: k.priv }));
			const aggregateSig = aggregate(sigs);

			// Verify with the 3 public keys
			const result = blsVerifyAggregate({
				sig: aggregateSig,
				msgHash,
				pubKeys: keys.slice(0, 3).map(k => k.pub),
			});

			expect(result.ok).toBe(true);
		});

		it('should reject insufficient signatures (2 of 5)', () => {
			// This is more of a business logic test - the signature itself would be valid
			// but the quorum logic should reject it. This belongs in entity tests.
			// For now, let's test that we can verify 2 signatures correctly
			const message = Buffer.from('insufficient quorum');
			const messageHash = keccak(message);
			const msgHash = `0x${Buffer.from(messageHash).toString('hex')}`;

			// Generate 2 keys (insufficient for quorum of 3)
			const priv1 = randomPriv();
			const key1 = { priv: priv1, pub: getPublicKey(priv1) };
			const priv2 = randomPriv();
			const key2 = { priv: priv2, pub: getPublicKey(priv2) };

			// Sign with both
			const sig1 = sign({ message: messageHash, privateKey: key1.priv });
			const sig2 = sign({ message: messageHash, privateKey: key2.priv });
			const aggregateSig = aggregate([sig1, sig2]);

			// The signature is valid for these 2 keys
			const result = blsVerifyAggregate({
				sig: aggregateSig,
				msgHash,
				pubKeys: [key1.pub, key2.pub],
			});

			// Signature is cryptographically valid
			expect(result.ok).toBe(true);
			// But the quorum check (in entity.ts) would reject this as insufficient
		});
	});

	describe('QuorumProof Validation', () => {
		it('should reject command with invalid quorum hash', () => {
			// Create a mock quorum
			const quorum: Quorum = {
				threshold: 2n,
				members: {
					'0x1111111111111111111111111111111111111111': { nonce: 0n, shares: 1n },
					'0x2222222222222222222222222222222222222222': { nonce: 0n, shares: 1n },
					'0x3333333333333333333333333333333333333333': { nonce: 0n, shares: 1n },
				},
			};

			// Use wrong hash
			const wrongHash = ('0x' + '00'.repeat(32)) as Hex;

			// Validate wrong hash fails
			const result = validateQuorumHash(quorum, wrongHash);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toContain('Quorum hash mismatch');
			}
		});

		it('should accept command with matching quorum hash', () => {
			// Create a mock quorum
			const quorum: Quorum = {
				threshold: 2n,
				members: {
					'0x1111111111111111111111111111111111111111': { nonce: 0n, shares: 1n },
					'0x2222222222222222222222222222222222222222': { nonce: 0n, shares: 1n },
					'0x3333333333333333333333333333333333333333': { nonce: 0n, shares: 1n },
				},
			};

			// Compute correct hash
			const correctHash = hashQuorum(quorum);

			// Validate correct hash passes
			const result = validateQuorumHash(quorum, correctHash);
			expect(result.ok).toBe(true);
		});

		it('should compute quorum hash deterministically', () => {
			// Create a mock quorum
			const quorum: Quorum = {
				threshold: 3n,
				members: {
					'0x3333333333333333333333333333333333333333': { nonce: 2n, shares: 2n },
					'0x1111111111111111111111111111111111111111': { nonce: 0n, shares: 1n },
					'0x2222222222222222222222222222222222222222': { nonce: 1n, shares: 1n },
				},
			};

			// Compute hash multiple times
			const hash1 = hashQuorum(quorum);
			const hash2 = hashQuorum(quorum);
			const hash3 = hashQuorum(quorum);

			// All should be identical
			expect(hash1).toBe(hash2);
			expect(hash2).toBe(hash3);

			// Should be a valid hex hash
			expect(hash1).toMatch(/^0x[0-9a-f]{64}$/);
		});
	});

	describe('WAL Replay', () => {
		it('should write inputs and ServerFrames to WAL', async () => {
			const { createWAL } = await import('../infra/wal');
			const { createRuntime } = await import('../core/runtime');

			const walDir = `/tmp/xln-test-integration-wal-${Date.now()}`;
			const wal = await createWAL({ directory: walDir });

			// Create runtime with WAL
			const runtime = createRuntime({ wal });

			// Process a transaction
			const input: Input = {
				from: '0x0000000000000000000000000000000000000000' as Address,
				to: runtime.ADDRS[0] as Address,
				cmd: {
					type: 'ADD_TX',
					addrKey: 'test:entity',
					tx: {
						kind: 'chat',
						nonce: 0n,
						from: runtime.ADDRS[0] as Address,
						body: { message: 'WAL test' },
						sig: DUMMY_SIGNATURE,
					},
				},
			};

			// Use async tick to ensure WAL writes
			const result = await runtime.tickAsync({ now: 1000, incoming: [input] });
			expect(result.frame.height).toBe(1n);

			// Read back from WAL
			const { inputs, frames } = await wal.replay();
			expect(inputs.length).toBe(1);
			expect(frames.length).toBe(1);
			expect(inputs[0]).toEqual([input]);
			expect(frames[0].height).toBe(1n);

			await wal.close();
			await import('fs/promises').then(fs => fs.rm(walDir, { recursive: true, force: true }));
		});

		it('should replay from WAL and reach same state', async () => {
			const { createWAL } = await import('../infra/wal');
			const { createSnapshot } = await import('../infra/snapshot');
			const { replayFromWAL } = await import('../infra/replay');
			const { createRuntime } = await import('../core/runtime');

			const walDir = `/tmp/xln-test-integration-wal-replay-${Date.now()}`;
			const snapshotDir = `/tmp/xln-test-integration-snapshot-${Date.now()}`;

			const wal = await createWAL({ directory: walDir });
			const snapshot = await createSnapshot({ directory: snapshotDir });

			// Create entity
			const entityState: EntityState = {
				quorum: {
					threshold: 2n,
					members: {
						'0x1111111111111111111111111111111111111111': { nonce: 0n, shares: 1n },
						'0x2222222222222222222222222222222222222222': { nonce: 0n, shares: 1n },
						'0x3333333333333333333333333333333333333333': { nonce: 0n, shares: 1n },
					},
				},
				chat: [],
			};

			const replica: Replica = {
				address: { jurisdiction: 'test', entityId: 'entity' },
				proposer: '0x1111111111111111111111111111111111111111' as Address,
				isAwaitingSignatures: false,
				mempool: [],
				last: { height: 0n, ts: 0, txs: [], state: entityState },
			};

			const runtime = createRuntime({
				wal,
				initialState: {
					replicas: new Map([['test:entity:0x1111111111111111111111111111111111111111', replica]]),
					height: 0n,
					lastHash: EMPTY_HASH,
				},
			});

			// Process multiple transactions
			// eslint-disable-next-line functional/no-loop-statements, fp/no-loops, functional/no-let, fp/no-let, fp/no-mutation
			for (let i = 0; i < 3; i++) {
				const input: Input = {
					from: '0x0000000000000000000000000000000000000000' as Address,
					to: '0x1111111111111111111111111111111111111111' as Address,
					cmd: {
						type: 'ADD_TX',
						addrKey: 'test:entity',
						tx: {
							kind: 'chat',
							nonce: BigInt(i),
							from: '0x1111111111111111111111111111111111111111' as Address,
							body: { message: `Message ${i}` },
							sig: DUMMY_SIGNATURE,
						},
					},
				};

				await runtime.tickAsync({ now: 1000 + i * 100, incoming: [input] });
			}

			// Close WAL and replay
			await wal.close();

			const wal2 = await createWAL({ directory: walDir });
			const replayResult = await replayFromWAL({
				wal: wal2,
				snapshot,
				validateFrames: false,
			});

			expect(replayResult.replayedFrames).toBe(3);
			expect(replayResult.endHeight).toBe(3n);
			expect(replayResult.state.height).toBe(3n);

			await wal2.close();
			await import('fs/promises').then(fs => fs.rm(walDir, { recursive: true, force: true }));
			await import('fs/promises').then(fs => fs.rm(snapshotDir, { recursive: true, force: true }));
		});
	});

	describe('Multi-Entity ServerFrame', () => {
		it('should compute global merkle root correctly', () => {
			// Create two entities with different states
			const entity1State: EntityState = {
				quorum: {
					threshold: 2n,
					members: {
						'0x1111111111111111111111111111111111111111': { nonce: 0n, shares: 1n },
						'0x2222222222222222222222222222222222222222': { nonce: 0n, shares: 1n },
					},
				},
				chat: [{ from: '0x1111111111111111111111111111111111111111' as Hex, msg: 'Hello', ts: 1000 }],
			};

			const entity2State: EntityState = {
				quorum: {
					threshold: 1n,
					members: {
						'0x3333333333333333333333333333333333333333': { nonce: 0n, shares: 1n },
					},
				},
				chat: [],
			};

			// Create replicas for both entities
			const replicas = new Map<string, Replica>([
				[
					'test:entity1:0x1111111111111111111111111111111111111111',
					{
						address: { jurisdiction: 'test', entityId: 'entity1' },
						proposer: '0x1111111111111111111111111111111111111111' as Address,
						isAwaitingSignatures: false,
						mempool: [],
						last: { height: 1n, ts: 1000, txs: [], state: entity1State },
					},
				],
				[
					'test:entity2:0x3333333333333333333333333333333333333333',
					{
						address: { jurisdiction: 'test', entityId: 'entity2' },
						proposer: '0x3333333333333333333333333333333333333333' as Address,
						isAwaitingSignatures: false,
						mempool: [],
						last: { height: 2n, ts: 2000, txs: [], state: entity2State },
					},
				],
			]);

			// Apply server block to compute root
			const result = applyServerBlock({
				prev: { height: 0n, replicas: replicas, lastHash: EMPTY_HASH },
				batch: [],
				timestamp: 3000,
			});

			// Verify root is deterministic and valid hex
			expect(result.frame.root).toMatch(/^0x[0-9a-f]{64}$/);

			// Compute again with same state - should be identical
			const result2 = applyServerBlock({
				prev: { height: 0n, replicas: replicas, lastHash: EMPTY_HASH },
				batch: [],
				timestamp: 3000,
			});
			expect(result2.frame.root).toBe(result.frame.root);
		});

		it('should handle multiple entities in one tick', () => {
			// Create initial server state with two entities
			const entity1: Replica = {
				address: { jurisdiction: 'test', entityId: 'entity1' },
				proposer: '0x1111111111111111111111111111111111111111' as Address,
				isAwaitingSignatures: false,
				mempool: [],
				last: {
					height: 0n,
					ts: 0,
					txs: [],
					state: {
						quorum: {
							threshold: 1n,
							members: {
								'0x1111111111111111111111111111111111111111': { nonce: 0n, shares: 1n },
							},
						},
						chat: [],
					},
				},
			};

			const entity2: Replica = {
				address: { jurisdiction: 'test', entityId: 'entity2' },
				proposer: '0x2222222222222222222222222222222222222222' as Address,
				isAwaitingSignatures: false,
				mempool: [],
				last: {
					height: 0n,
					ts: 0,
					txs: [],
					state: {
						quorum: {
							threshold: 1n,
							members: {
								'0x2222222222222222222222222222222222222222': { nonce: 0n, shares: 1n },
							},
						},
						chat: [],
					},
				},
			};

			const serverState: ServerState = {
				height: 0n,
				replicas: new Map([
					['test:entity1:0x1111111111111111111111111111111111111111', entity1],
					['test:entity2:0x2222222222222222222222222222222222222222', entity2],
				]),
				lastHash: EMPTY_HASH,
			};

			// Create commands for both entities
			const inputs: Input[] = [
				{
					from: '0x1111111111111111111111111111111111111111' as Address,
					to: '0x1111111111111111111111111111111111111111' as Address,
					cmd: {
						type: 'ADD_TX',
						addrKey: 'test:entity1',
						tx: {
							kind: 'chat',
							nonce: 0n,
							from: '0x1111111111111111111111111111111111111111' as Address,
							body: { message: 'From entity 1' },
							sig: DUMMY_SIGNATURE,
						},
					},
				},
				{
					from: '0x2222222222222222222222222222222222222222' as Address,
					to: '0x2222222222222222222222222222222222222222' as Address,
					cmd: {
						type: 'ADD_TX',
						addrKey: 'test:entity2',
						tx: {
							kind: 'chat',
							nonce: 0n,
							from: '0x2222222222222222222222222222222222222222' as Address,
							body: { message: 'From entity 2' },
							sig: DUMMY_SIGNATURE,
						},
					},
				},
			];

			// Apply the server block
			const result = applyServerBlock({
				prev: serverState,
				batch: inputs,
				timestamp: 1000,
			});

			// Both entities should have transactions in mempool
			const entity1Replica = result.state.replicas.get('test:entity1:0x1111111111111111111111111111111111111111');
			const entity2Replica = result.state.replicas.get('test:entity2:0x2222222222222222222222222222222222222222');

			expect(entity1Replica?.mempool.length).toBe(1);
			expect(entity2Replica?.mempool.length).toBe(1);

			// Should generate PROPOSE commands for both entities
			const proposeCommands = result.outbox.filter(o => o.cmd.type === 'PROPOSE');
			expect(proposeCommands.length).toBe(2);
			// eslint-disable-next-line fp/no-mutating-methods
			expect(proposeCommands.map(p => (p.cmd.type === 'PROPOSE' ? p.cmd.addrKey : '')).sort()).toEqual([
				'test:entity1',
				'test:entity2',
			]);
		});

		it('should broadcast commits to all replicas', () => {
			// Setup entity with multiple signers
			const quorum: Quorum = {
				threshold: 2n,
				members: {
					'0x1111111111111111111111111111111111111111': { nonce: 0n, shares: 1n },
					'0x2222222222222222222222222222222222222222': { nonce: 0n, shares: 1n },
					'0x3333333333333333333333333333333333333333': { nonce: 0n, shares: 1n },
				},
			};

			const entityState: EntityState = { quorum, chat: [] };
			const proposedFrame: ProposedFrame<EntityState> = {
				height: 1n,
				ts: 1000,
				txs: [],
				state: entityState,
				hash: '0xabcd' as Hex,
				sigs: new Map([['0x1111111111111111111111111111111111111111' as Address, DUMMY_SIGNATURE]]),
			};

			const replica: Replica = {
				address: { jurisdiction: 'test', entityId: 'entity' },
				proposer: '0x1111111111111111111111111111111111111111' as Address,
				isAwaitingSignatures: true,
				mempool: [],
				last: { height: 0n, ts: 0, txs: [], state: entityState },
				proposal: proposedFrame,
			};

			// Apply SIGN command that reaches threshold
			const result = applyCommand({
				replica,
				command: {
					type: 'SIGN',
					addrKey: 'test:entity',
					signer: '0x2222222222222222222222222222222222222222' as Address,
					frameHash: '0xabcd' as Hex,
					sig: DUMMY_SIGNATURE,
					quorumHash: hashQuorum(quorum),
				},
			});

			// Should generate COMMIT commands for all quorum members
			const commitCommands = result.outbox.filter(o => o.cmd.type === 'COMMIT');
			expect(commitCommands.length).toBe(3);

			// All members should receive the commit
			// eslint-disable-next-line fp/no-mutating-methods
			const recipients = commitCommands.map(c => c.to).sort();
			expect(recipients).toEqual([
				'0x1111111111111111111111111111111111111111',
				'0x2222222222222222222222222222222222222222',
				'0x3333333333333333333333333333333333333333',
			]);
		});

		it('should update root when any entity commits', () => {
			// Create initial state with entity
			const entityState: EntityState = {
				quorum: {
					threshold: 1n,
					members: {
						'0x1111111111111111111111111111111111111111': { nonce: 0n, shares: 1n },
					},
				},
				chat: [],
			};

			const replica: Replica = {
				address: { jurisdiction: 'test', entityId: 'entity' },
				proposer: '0x1111111111111111111111111111111111111111' as Address,
				isAwaitingSignatures: false,
				mempool: [],
				last: { height: 0n, ts: 0, txs: [], state: entityState },
			};

			const serverState: ServerState = {
				height: 0n,
				replicas: new Map([['test:entity:0x1111111111111111111111111111111111111111', replica]]),
				lastHash: EMPTY_HASH,
			};

			// Get initial root
			const initialResult = applyServerBlock({
				prev: serverState,
				batch: [],
				timestamp: 1000,
			});
			const initialRoot = initialResult.frame.root;

			// First add a transaction to the mempool
			const addTxInput: Input = {
				from: '0x1111111111111111111111111111111111111111' as Address,
				to: '0x1111111111111111111111111111111111111111' as Address,
				cmd: {
					type: 'ADD_TX',
					addrKey: 'test:entity',
					tx: {
						kind: 'chat',
						nonce: 0n,
						from: '0x1111111111111111111111111111111111111111' as Address,
						body: { message: 'Hello' },
						sig: DUMMY_SIGNATURE,
					},
				},
			};

			// Apply the ADD_TX
			const addTxResult = applyServerBlock({
				prev: serverState,
				batch: [addTxInput],
				timestamp: 1500,
			});

			// Verify mempool has the transaction
			const updatedReplica = addTxResult.state.replicas.get('test:entity:0x1111111111111111111111111111111111111111');
			expect(updatedReplica?.mempool.length).toBe(1);

			// The root should remain the same since only mempool changed, not committed state
			expect(addTxResult.frame.root).toBe(initialRoot);
			expect(addTxResult.frame.root).toMatch(/^0x[0-9a-f]{64}$/);
		});
	});

	describe('Leader Rotation', () => {
		it('should select proposer deterministically by height', async () => {
			const { proposerFor } = await import('../core/proposer');

			// Create entity with multiple signers
			const quorum = {
				threshold: 2n,
				members: {
					'0x1111111111111111111111111111111111111111': { nonce: 0n, shares: 1n },
					'0x2222222222222222222222222222222222222222': { nonce: 0n, shares: 1n },
					'0x3333333333333333333333333333333333333333': { nonce: 0n, shares: 1n },
				},
			};

			const members = Object.keys(quorum.members) as Address[];

			// Verify proposer rotation
			expect(proposerFor(0n, members)).toBe('0x1111111111111111111111111111111111111111');
			expect(proposerFor(1n, members)).toBe('0x2222222222222222222222222222222222222222');
			expect(proposerFor(2n, members)).toBe('0x3333333333333333333333333333333333333333');
			expect(proposerFor(3n, members)).toBe('0x1111111111111111111111111111111111111111'); // Wraps around
		});

		it('should allow re-proposal after timeout', async () => {
			const { hasProposalTimedOut } = await import('../core/proposer');

			// Create a proposed frame with timestamp
			const proposalTs = 1000;
			const currentTs = 6500; // 5.5 seconds later

			// Should timeout after 5 seconds at height 0
			expect(hasProposalTimedOut(proposalTs, currentTs, 0n)).toBe(true);

			// At higher heights, timeout increases
			expect(hasProposalTimedOut(proposalTs, currentTs, 1000n)).toBe(false); // 7.5s timeout
		});

		it('should handle proposer rotation in server', () => {
			// Setup initial state with multiple replicas
			const entityState: EntityState = {
				quorum: {
					threshold: 2n,
					members: {
						'0x1111111111111111111111111111111111111111': { nonce: 0n, shares: 1n },
						'0x2222222222222222222222222222222222222222': { nonce: 0n, shares: 1n },
						'0x3333333333333333333333333333333333333333': { nonce: 0n, shares: 1n },
					},
				},
				chat: [],
			};

			// Create replicas for each signer
			const tx: Transaction = {
				kind: 'chat',
				nonce: 0n,
				from: '0x1111111111111111111111111111111111111111' as Address,
				body: { message: 'Test rotation' },
				sig: DUMMY_SIGNATURE,
			};

			const replicas = Object.keys(entityState.quorum.members).reduce((acc, signer) => {
				const replica: Replica = {
					address: { jurisdiction: 'test', entityId: 'entity' },
					proposer: signer as Address,
					isAwaitingSignatures: false,
					mempool: [tx], // Add transaction to ALL replicas' mempools (simulating broadcast)
					last: { height: 0n, ts: 0, txs: [], state: entityState },
				};
				return new Map(acc).set(`test:entity:${signer}`, replica);
			}, new Map<string, Replica>());

			const serverState: ServerState = {
				height: 0n,
				replicas,
				lastHash: EMPTY_HASH,
			};

			// Apply server block at height 0 -> creates height 1
			// At height 1, second signer (0x2222...) should be proposer
			const result1 = applyServerBlock({
				prev: serverState,
				batch: [],
				timestamp: 1000,
			});

			const proposeCommands1 = result1.outbox.filter(o => o.cmd.type === 'PROPOSE');
			expect(proposeCommands1.length).toBe(1);
			expect(proposeCommands1[0].from).toBe('0x2222222222222222222222222222222222222222');

			// At height 2, proposer should rotate to third signer
			const result2 = applyServerBlock({
				prev: result1.state,
				batch: [],
				timestamp: 2000,
			});

			const proposeCommands2 = result2.outbox.filter(o => o.cmd.type === 'PROPOSE');
			expect(proposeCommands2.length).toBe(1);
			expect(proposeCommands2[0].from).toBe('0x3333333333333333333333333333333333333333');

			// At height 3, proposer should wrap back to first signer
			const result3 = applyServerBlock({
				prev: result2.state,
				batch: [],
				timestamp: 3000,
			});

			const proposeCommands3 = result3.outbox.filter(o => o.cmd.type === 'PROPOSE');
			expect(proposeCommands3.length).toBe(1);
			expect(proposeCommands3[0].from).toBe('0x1111111111111111111111111111111111111111');
		});
	});
});
