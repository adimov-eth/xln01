import { applyServerBlock } from '../core/server';
import { EMPTY_HASH, INITIAL_HEIGHT } from '../constants';
import type { ServerState } from '../types';
import type { Snapshot } from './snapshot';
import type { WAL } from './wal';

export interface ReplayOptions {
	wal: WAL;
	snapshot: Snapshot;
	validateFrames?: boolean;
}

export interface ReplayResult {
	state: ServerState;
	replayedInputs: number;
	replayedFrames: number;
	startHeight: bigint;
	endHeight: bigint;
}

export const replayFromWAL = async (options: ReplayOptions): Promise<ReplayResult> => {
	const { wal, snapshot, validateFrames = true } = options;

	// Try to load from snapshot first
	const loadedState = await snapshot.load();
	const startHeight = loadedState ? loadedState.height : INITIAL_HEIGHT;

	const initialState = loadedState ?? {
		replicas: new Map(),
		height: INITIAL_HEIGHT,
		lastHash: EMPTY_HASH,
	};

	// Get all WAL entries
	const { inputs, frames } = await wal.replay();

	const stats = {
		replayedInputs: 0,
		replayedFrames: 0,
	};

	// If we have a snapshot, skip frames that are already included
	const skipUntilHeight = initialState.height + 1n;

	// Replay input batches and generate frames
	const finalState = await inputs.reduce(async (prevStatePromise, inputBatch, i) => {
		const prevState = await prevStatePromise;
		const expectedFrame = frames[i];

		// Skip if this frame is before our snapshot
		if (expectedFrame && expectedFrame.height < skipUntilHeight) {
			return prevState;
		}

		// Apply the input batch
		const result = applyServerBlock({
			prev: prevState,
			batch: inputBatch,
			timestamp: expectedFrame ? expectedFrame.ts : Date.now(),
		});

		// Validate the frame if requested
		if (validateFrames && expectedFrame) {
			if (result.frame.hash !== expectedFrame.hash) {
				// eslint-disable-next-line functional/no-throw-statements, fp/no-throw
				throw new Error(
					`Frame hash mismatch at height ${result.frame.height}: ` +
						`computed ${result.frame.hash} != expected ${expectedFrame.hash}`,
				);
			}
			if (result.frame.root !== expectedFrame.root) {
				// eslint-disable-next-line functional/no-throw-statements, fp/no-throw
				throw new Error(
					`Frame root mismatch at height ${result.frame.height}: ` +
						`computed ${result.frame.root} != expected ${expectedFrame.root}`,
				);
			}
		}

		// eslint-disable-next-line fp/no-mutation, functional/immutable-data
		stats.replayedInputs += inputBatch.length;
		// eslint-disable-next-line fp/no-mutation, functional/immutable-data
		stats.replayedFrames++;

		// Periodically save snapshots during replay
		if (result.state.height % 100n === 0n) {
			await snapshot.save(result.state);
		}

		return result.state;
	}, Promise.resolve(initialState));

	// Save final snapshot
	await snapshot.save(finalState);

	return {
		state: finalState,
		replayedInputs: stats.replayedInputs,
		replayedFrames: stats.replayedFrames,
		startHeight,
		endHeight: finalState.height,
	};
};

export const validateWALConsistency = async (wal: WAL): Promise<{ valid: boolean; error?: string }> => {
	const { inputs, frames } = await wal.replay();

	if (inputs.length !== frames.length) {
		return {
			valid: false,
			error: `Input batch count (${inputs.length}) does not match frame count (${frames.length})`,
		};
	}

	// Check that frame heights are sequential
	const heightErrors = frames.reduce<{ expectedHeight: bigint; error?: string }>(
		(acc, frame) => {
			if (acc.error) return acc;
			if (frame.height !== acc.expectedHeight) {
				return {
					expectedHeight: acc.expectedHeight,
					error: `Frame height mismatch: expected ${acc.expectedHeight}, got ${frame.height}`,
				};
			}
			return { expectedHeight: acc.expectedHeight + 1n };
		},
		{ expectedHeight: 1n },
	);

	if (heightErrors.error) {
		return { valid: false, error: heightErrors.error };
	}

	// Check that each frame's parent hash matches the previous frame's hash
	const parentErrors = frames.slice(1).reduce<{ prevHash: string; error?: string }>(
		(acc, frame, index) => {
			if (acc.error) return acc;
			if (frame.parent !== acc.prevHash) {
				return {
					prevHash: acc.prevHash,
					error: `Frame ${frame.height} parent hash does not match previous frame hash`,
				};
			}
			return { prevHash: frames[index + 1].hash };
		},
		{ prevHash: frames[0].hash },
	);

	if (parentErrors.error) {
		return { valid: false, error: parentErrors.error };
	}

	return { valid: true };
};
