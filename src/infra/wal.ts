import { Level } from 'level';
import type { Input, ServerFrame } from '../types';
import { serialize, deserialize } from './serializer';

export interface WAL {
	appendInputBatch(inputs: Input[]): Promise<void>;
	appendServerFrame(frame: ServerFrame): Promise<void>;
	replay(): Promise<{ inputs: Input[][]; frames: ServerFrame[] }>;
	close(): Promise<void>;
}

export interface WALOptions {
	directory: string;
	maxBatchSize?: number;
}

type WALEntry = {
	type: 'INPUT_BATCH' | 'SERVER_FRAME';
	sequence: number;
	timestamp: number;
	data: Input[] | ServerFrame;
};

const encodeKey = (sequence: number): string => {
	return sequence.toString().padStart(20, '0');
};

const decodeEntry = (value: string): WALEntry => {
	return deserialize(value) as WALEntry;
};

const encodeEntry = (entry: WALEntry): string => {
	return serialize(entry);
};

export const createWAL = async (options: WALOptions): Promise<WAL> => {
	const db = new Level<string, string>(options.directory);
	await db.open();

	// Initialize sequence from existing entries
	const getInitialSequence = async (): Promise<number> => {
		try {
			const lastKey = await db.keys({ reverse: true, limit: 1 }).all();
			if (lastKey.length > 0) {
				return parseInt(lastKey[0], 10) + 1;
			}
		} catch {
			// Database is empty, start from 0
		}
		return 0;
	};

	const initialSequence = await getInitialSequence();
	// eslint-disable-next-line functional/no-let, fp/no-let
	let sequence = initialSequence;

	const appendEntry = async (type: 'INPUT_BATCH' | 'SERVER_FRAME', data: Input[] | ServerFrame): Promise<void> => {
		const currentSeq = sequence;
		const entry: WALEntry = {
			type,
			sequence: currentSeq,
			timestamp: Date.now(),
			data,
		};

		await db.put(encodeKey(currentSeq), encodeEntry(entry));
		// eslint-disable-next-line fp/no-mutation
		sequence++;
	};

	return {
		async appendInputBatch(inputs: Input[]): Promise<void> {
			await appendEntry('INPUT_BATCH', inputs);
		},

		async appendServerFrame(frame: ServerFrame): Promise<void> {
			await appendEntry('SERVER_FRAME', frame);
		},

		async replay(): Promise<{ inputs: Input[][]; frames: ServerFrame[] }> {
			const allEntries: WALEntry[] = [];

			// Read all entries in order
			// eslint-disable-next-line functional/no-loop-statements, fp/no-loops
			for await (const [, value] of db.iterator()) {
				// eslint-disable-next-line functional/immutable-data, fp/no-mutating-methods
				allEntries.push(decodeEntry(value));
			}

			const inputs = allEntries.filter(entry => entry.type === 'INPUT_BATCH').map(entry => entry.data as Input[]);

			const frames = allEntries.filter(entry => entry.type === 'SERVER_FRAME').map(entry => entry.data as ServerFrame);

			return { inputs, frames };
		},

		async close(): Promise<void> {
			await db.close();
		},
	};
};
