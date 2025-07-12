import { Level } from 'level';
import type { ServerState } from '../types';
import { serialize, deserialize } from './serializer';

export interface Snapshot {
	save(state: ServerState): Promise<void>;
	load(): Promise<ServerState | null>;
	getLatestHeight(): Promise<bigint | null>;
}

export interface SnapshotOptions {
	directory: string;
	compactInterval?: number; // Keep snapshots every N blocks
}

const CURRENT_KEY = 'current';
const STATE_PREFIX = 'state:';

const encodeHeightKey = (height: bigint): string => {
	return STATE_PREFIX + height.toString().padStart(20, '0');
};

export const createSnapshot = async (options: SnapshotOptions): Promise<Snapshot> => {
	const db = new Level<string, string>(options.directory);
	await db.open();

	const compactInterval = options.compactInterval ?? 100;

	return {
		async save(state: ServerState): Promise<void> {
			const height = state.height;
			const heightKey = encodeHeightKey(height);

			// Save the state at this height
			await db.put(heightKey, serialize(state));

			// Update the current pointer
			await db.put(CURRENT_KEY, height.toString());

			// Compact old snapshots if needed
			if (compactInterval > 0 && height > BigInt(compactInterval)) {
				const minKeepHeight = height - BigInt(compactInterval);

				// Delete old snapshots except those at compactInterval boundaries
				const keysToDelete: string[] = [];
				// eslint-disable-next-line functional/no-loop-statements, fp/no-loops
				for await (const key of db.keys({ gte: STATE_PREFIX, lt: heightKey })) {
					const heightStr = key.substring(STATE_PREFIX.length);
					const snapshotHeight = BigInt(parseInt(heightStr, 10));

					if (snapshotHeight < minKeepHeight && snapshotHeight % BigInt(compactInterval) !== 0n) {
						// eslint-disable-next-line functional/immutable-data, fp/no-mutating-methods
						keysToDelete.push(key);
					}
				}

				// Delete all at once
				await Promise.all(keysToDelete.map(key => db.del(key)));
			}
		},

		async load(): Promise<ServerState | null> {
			try {
				// Get the current height
				const currentHeight = await db.get(CURRENT_KEY);
				const heightKey = encodeHeightKey(BigInt(currentHeight));

				// Load the state at that height
				const stateJson = await db.get(heightKey);
				const state = deserialize(stateJson) as ServerState;

				// The deserializer already handles BigInt conversion
				return state;
			} catch {
				// No snapshot found
				return null;
			}
		},

		async getLatestHeight(): Promise<bigint | null> {
			try {
				const currentHeight = await db.get(CURRENT_KEY);
				return BigInt(currentHeight);
			} catch {
				return null;
			}
		},
	};
};
