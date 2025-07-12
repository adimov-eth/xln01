import { describe, expect, it } from 'bun:test';
import { createWAL } from '../infra/wal';
import { createSnapshot } from '../infra/snapshot';
import { replayFromWAL, validateWALConsistency } from '../infra/replay';
import { createRuntime } from '../core/runtime';
import { DEMO_ENTITY_ID, DEMO_JURISDICTION, DUMMY_SIGNATURE, EMPTY_HASH } from '../constants';
import type { Input, EntityState, Replica, Address } from '../types';

describe('WAL Tests', () => {
	const getTestDirs = () => {
		const id = Date.now() + Math.random();
		return {
			walDir: `/tmp/xln-test-wal-${id}`,
			snapshotDir: `/tmp/xln-test-snapshot-${id}`,
		};
	};

	// No global beforeEach/afterEach - each test manages its own directories

	describe('Basic WAL Operations', () => {
		it('should append and replay input batches', async () => {
			const { walDir } = getTestDirs();
			const wal = await createWAL({ directory: walDir });

			const input1: Input = {
				from: '0x1111111111111111111111111111111111111111' as Address,
				to: '0x1111111111111111111111111111111111111111' as Address,
				cmd: {
					type: 'ADD_TX',
					addrKey: `${DEMO_JURISDICTION}:${DEMO_ENTITY_ID}`,
					tx: {
						kind: 'chat',
						nonce: 0n,
						from: '0x1111111111111111111111111111111111111111' as Address,
						body: { message: 'Test 1' },
						sig: DUMMY_SIGNATURE,
					},
				},
			};

			const input2: Input = {
				from: '0x2222222222222222222222222222222222222222' as Address,
				to: '0x2222222222222222222222222222222222222222' as Address,
				cmd: {
					type: 'ADD_TX',
					addrKey: `${DEMO_JURISDICTION}:${DEMO_ENTITY_ID}`,
					tx: {
						kind: 'chat',
						nonce: 0n,
						from: '0x2222222222222222222222222222222222222222' as Address,
						body: { message: 'Test 2' },
						sig: DUMMY_SIGNATURE,
					},
				},
			};

			// Append two batches
			await wal.appendInputBatch([input1]);
			await wal.appendInputBatch([input2]);

			// Replay
			const { inputs } = await wal.replay();

			expect(inputs.length).toBe(2);
			expect(inputs[0]).toEqual([input1]);
			expect(inputs[1]).toEqual([input2]);

			await wal.close();
		});

		it('should append and replay server frames', async () => {
			const { walDir } = getTestDirs();
			const wal = await createWAL({ directory: walDir });

			const frame1 = {
				height: 1n,
				ts: 1000,
				inputs: [],
				root: '0x1111111111111111111111111111111111111111111111111111111111111111' as Address,
				parent: EMPTY_HASH,
				hash: '0x2222222222222222222222222222222222222222222222222222222222222222' as Address,
			};

			const frame2 = {
				height: 2n,
				ts: 2000,
				inputs: [],
				root: '0x3333333333333333333333333333333333333333333333333333333333333333' as Address,
				parent: frame1.hash,
				hash: '0x4444444444444444444444444444444444444444444444444444444444444444' as Address,
			};

			await wal.appendServerFrame(frame1);
			await wal.appendServerFrame(frame2);

			const { frames } = await wal.replay();

			expect(frames.length).toBe(2);
			expect(frames[0]).toEqual(frame1);
			expect(frames[1]).toEqual(frame2);

			await wal.close();
		});

		it('should maintain order of mixed operations', async () => {
			const { walDir } = getTestDirs();
			const wal = await createWAL({ directory: walDir });

			const input: Input = {
				from: '0x1111111111111111111111111111111111111111' as Address,
				to: '0x1111111111111111111111111111111111111111' as Address,
				cmd: {
					type: 'ADD_TX',
					addrKey: `${DEMO_JURISDICTION}:${DEMO_ENTITY_ID}`,
					tx: {
						kind: 'chat',
						nonce: 0n,
						from: '0x1111111111111111111111111111111111111111' as Address,
						body: { message: 'Test' },
						sig: DUMMY_SIGNATURE,
					},
				},
			};

			const frame = {
				height: 1n,
				ts: 1000,
				inputs: [input],
				root: '0x1111111111111111111111111111111111111111111111111111111111111111' as Address,
				parent: EMPTY_HASH,
				hash: '0x2222222222222222222222222222222222222222222222222222222222222222' as Address,
			};

			// Append in order: input batch, then frame
			await wal.appendInputBatch([input]);
			await wal.appendServerFrame(frame);

			const { inputs, frames } = await wal.replay();

			expect(inputs.length).toBe(1);
			expect(frames.length).toBe(1);
			expect(inputs[0]).toEqual([input]);
			expect(frames[0]).toEqual(frame);

			await wal.close();
		});

		it('should handle empty WAL', async () => {
			const { walDir } = getTestDirs();
			const wal = await createWAL({ directory: walDir });

			const { inputs, frames } = await wal.replay();

			expect(inputs.length).toBe(0);
			expect(frames.length).toBe(0);

			await wal.close();
		});
	});

	describe('WAL Consistency Validation', () => {
		it('should validate consistent WAL', async () => {
			const { walDir } = getTestDirs();
			const wal = await createWAL({ directory: walDir });

			// Create consistent entries
			// eslint-disable-next-line functional/no-loop-statements, fp/no-loops, functional/no-let, fp/no-let, fp/no-mutation
			for (let i = 1; i <= 3; i++) {
				const input: Input = {
					from: '0x1111111111111111111111111111111111111111' as Address,
					to: '0x1111111111111111111111111111111111111111' as Address,
					cmd: {
						type: 'ADD_TX',
						addrKey: `${DEMO_JURISDICTION}:${DEMO_ENTITY_ID}`,
						tx: {
							kind: 'chat',
							nonce: BigInt(i - 1),
							from: '0x1111111111111111111111111111111111111111' as Address,
							body: { message: `Message ${i}` },
							sig: DUMMY_SIGNATURE,
						},
					},
				};

				const prevHash = i === 1 ? EMPTY_HASH : `0x${i.toString().repeat(64)}`;
				const frame = {
					height: BigInt(i),
					ts: i * 1000,
					inputs: [input],
					root: `0x${(i + 10).toString().repeat(64).slice(0, 64)}`,
					parent: prevHash,
					hash: `0x${(i + 1).toString().repeat(64).slice(0, 64)}`,
				};

				await wal.appendInputBatch([input]);
				await wal.appendServerFrame(frame);
			}

			const result = await validateWALConsistency(wal);
			expect(result.valid).toBe(true);

			await wal.close();
		});

		it('should detect input/frame count mismatch', async () => {
			const { walDir } = getTestDirs();
			const wal = await createWAL({ directory: walDir });

			const input: Input = {
				from: '0x1111111111111111111111111111111111111111' as Address,
				to: '0x1111111111111111111111111111111111111111' as Address,
				cmd: {
					type: 'ADD_TX',
					addrKey: `${DEMO_JURISDICTION}:${DEMO_ENTITY_ID}`,
					tx: {
						kind: 'chat',
						nonce: 0n,
						from: '0x1111111111111111111111111111111111111111' as Address,
						body: { message: 'Test' },
						sig: DUMMY_SIGNATURE,
					},
				},
			};

			// Add inputs without corresponding frames
			await wal.appendInputBatch([input]);
			await wal.appendInputBatch([input]);

			const result = await validateWALConsistency(wal);
			expect(result.valid).toBe(false);
			expect(result.error).toContain('does not match frame count');

			await wal.close();
		});
	});

	describe('WAL Replay with Runtime', () => {
		it('should replay WAL to restore state', async () => {
			const { walDir, snapshotDir } = getTestDirs();
			// Create initial entity state
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
				address: { jurisdiction: DEMO_JURISDICTION, entityId: DEMO_ENTITY_ID },
				proposer: '0x1111111111111111111111111111111111111111' as Address,
				isAwaitingSignatures: false,
				mempool: [],
				last: { height: 0n, ts: 0, txs: [], state: entityState },
			};

			// Create runtime with WAL
			const wal = await createWAL({ directory: walDir });
			const runtime = createRuntime({
				wal,
				initialState: {
					replicas: new Map([
						[`${DEMO_JURISDICTION}:${DEMO_ENTITY_ID}:0x1111111111111111111111111111111111111111`, replica],
					]),
					height: 0n,
					lastHash: EMPTY_HASH,
				},
			});

			// Process some inputs
			const input1: Input = {
				from: '0x0000000000000000000000000000000000000000' as Address,
				to: '0x1111111111111111111111111111111111111111' as Address,
				cmd: {
					type: 'ADD_TX',
					addrKey: `${DEMO_JURISDICTION}:${DEMO_ENTITY_ID}`,
					tx: {
						kind: 'chat',
						nonce: 0n,
						from: '0x1111111111111111111111111111111111111111' as Address,
						body: { message: 'Hello WAL' },
						sig: DUMMY_SIGNATURE,
					},
				},
			};

			// Tick to process input
			const result1 = await runtime.tickAsync({ now: 1000, incoming: [input1] });
			expect(result1.frame.height).toBe(1n);

			// Close WAL and create new runtime to replay
			await wal.close();

			// Create snapshot utility and replay
			const snapshot = await createSnapshot({ directory: snapshotDir });
			const wal2 = await createWAL({ directory: walDir });

			const replayResult = await replayFromWAL({
				wal: wal2,
				snapshot,
				validateFrames: false, // Skip validation since BLS keys differ between runs
			});

			expect(replayResult.replayedFrames).toBe(1);
			expect(replayResult.endHeight).toBe(1n);
			expect(replayResult.state.height).toBe(1n);

			await wal2.close();
		});

		it('should handle crash recovery mid-tick', async () => {
			const { walDir } = getTestDirs();
			const wal = await createWAL({ directory: walDir });

			// Simulate a partial write - only input batch, no frame
			const input: Input = {
				from: '0x1111111111111111111111111111111111111111' as Address,
				to: '0x1111111111111111111111111111111111111111' as Address,
				cmd: {
					type: 'ADD_TX',
					addrKey: `${DEMO_JURISDICTION}:${DEMO_ENTITY_ID}`,
					tx: {
						kind: 'chat',
						nonce: 0n,
						from: '0x1111111111111111111111111111111111111111' as Address,
						body: { message: 'Crash test' },
						sig: DUMMY_SIGNATURE,
					},
				},
			};

			await wal.appendInputBatch([input]);
			// Simulate crash - no frame written

			const result = await validateWALConsistency(wal);
			expect(result.valid).toBe(false);

			await wal.close();
		});
	});

	describe('Snapshot Operations', () => {
		it('should save and load snapshots', async () => {
			const { snapshotDir } = getTestDirs();
			const snapshot = await createSnapshot({ directory: snapshotDir });

			const entityState: EntityState = {
				quorum: {
					threshold: 2n,
					members: {
						'0x1111111111111111111111111111111111111111': { nonce: 1n, shares: 1n },
						'0x2222222222222222222222222222222222222222': { nonce: 0n, shares: 1n },
					},
				},
				chat: [{ from: '0x1111111111111111111111111111111111111111' as Address, msg: 'Test', ts: 1000 }],
			};

			const replica: Replica = {
				address: { jurisdiction: DEMO_JURISDICTION, entityId: DEMO_ENTITY_ID },
				proposer: '0x1111111111111111111111111111111111111111' as Address,
				isAwaitingSignatures: false,
				mempool: [],
				last: { height: 5n, ts: 5000, txs: [], state: entityState },
			};

			const serverState = {
				replicas: new Map([
					[`${DEMO_JURISDICTION}:${DEMO_ENTITY_ID}:0x1111111111111111111111111111111111111111`, replica],
				]),
				height: 10n,
				lastHash: '0x1234567890123456789012345678901234567890123456789012345678901234' as Address,
			};

			// Save snapshot
			await snapshot.save(serverState);

			// Load snapshot
			const loaded = await snapshot.load();

			expect(loaded).not.toBeNull();
			if (loaded) {
				expect(loaded.height).toBe(10n);
				expect(loaded.lastHash).toBe(serverState.lastHash);
				expect(loaded.replicas.size).toBe(1);

				const loadedReplica = loaded.replicas.get(
					`${DEMO_JURISDICTION}:${DEMO_ENTITY_ID}:0x1111111111111111111111111111111111111111`,
				);
				expect(loadedReplica?.last.height).toBe(5n);
				expect(loadedReplica?.last.state.chat.length).toBe(1);
			}
		});

		it('should compact old snapshots', async () => {
			const { snapshotDir } = getTestDirs();
			const snapshot = await createSnapshot({
				directory: snapshotDir,
				compactInterval: 5, // Keep every 5 blocks
			});

			// Save snapshots for heights 1-12
			// eslint-disable-next-line functional/no-loop-statements, fp/no-loops, functional/no-let, fp/no-let, fp/no-mutation
			for (let i = 1n; i <= 12n; i++) {
				const serverState = {
					replicas: new Map(),
					height: i,
					lastHash: `0x${i.toString().repeat(64).slice(0, 64)}`,
				};
				await snapshot.save(serverState);
			}

			// Should keep: 5, 10, and all >= 8 (within compactInterval of latest)
			const latestHeight = await snapshot.getLatestHeight();
			expect(latestHeight).toBe(12n);

			// Load should get the latest
			const loaded = await snapshot.load();
			expect(loaded?.height).toBe(12n);
		});
	});
});
