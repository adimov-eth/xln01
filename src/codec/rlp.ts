import { keccak_256 as keccak } from '@noble/hashes/sha3';
import * as rlp from 'rlp';
import {
	COMMAND_FIELD_COUNT,
	DUMMY_SIGNATURE,
	FRAME_FIELD_COUNT,
	INPUT_FIELD_COUNT,
	SERVER_FRAME_FIELD_COUNT,
	TIMESTAMP_BIGINT_THRESHOLD,
	TRANSACTION_FIELD_COUNT,
} from '../constants';
import type { Command, Frame, Hex, Input, Result, Transaction, TxKind, UInt64 } from '../types';
import { err, ok } from '../types';

/* — Type helpers for RLP operations — */
type RLPDecodedValue = Buffer | RLPDecodedValue[];

const asBuffer = (value: RLPDecodedValue): Result<Buffer> => {
	if (!Buffer.isBuffer(value)) {
		return err('Expected Buffer but got array');
	}
	return ok(value);
};

// Unused but kept for future use
// const asBufferArray = (value: RLPDecodedValue): Result<Buffer[]> => {
// 	if (Buffer.isBuffer(value)) {
// 		return err('Expected array but got Buffer');
// 	}
// 	const buffers: Buffer[] = [];
// 	for (const item of value) {
// 		const result = asBuffer(item);
// 		if (!result.ok) return err(result.error);
// 		buffers.push(result.value);
// 	}
// 	return ok(buffers);
// };

/* — internal helpers for bigint <-> Buffer — */
const convertBigIntToBuffer = (number: UInt64) =>
	number === 0n ? Buffer.alloc(0) : Buffer.from(number.toString(16).padStart(2, '0'), 'hex');
const convertBufferToBigInt = (buffer: Buffer): UInt64 =>
	buffer.length === 0 ? 0n : BigInt(`0x${buffer.toString('hex')}`);

/* — Transaction encode/decode — */
export const encodeTransaction = (transaction: Transaction): Buffer =>
	Buffer.from(
		rlp.encode([
			transaction.kind,
			convertBigIntToBuffer(transaction.nonce),
			transaction.from,
			JSON.stringify(transaction.body), // body is small JSON (e.g. {"message": "hi"})
			transaction.sig,
		]),
	);
export const decodeTransaction = (buffer: Buffer): Result<Transaction> => {
	const decoded = rlp.decode(buffer) as RLPDecodedValue;
	if (Buffer.isBuffer(decoded)) {
		return err('Expected array for transaction');
	}
	if (decoded.length !== TRANSACTION_FIELD_COUNT) {
		return err(`Transaction must have exactly ${TRANSACTION_FIELD_COUNT} fields`);
	}

	const results = decoded.reduce<Buffer[]>((acc, item) => {
		const result = asBuffer(item);
		if (!result.ok) return acc; // Skip on error
		return acc.concat([result.value]);
	}, []);

	// Check if all items were converted successfully
	if (results.length !== decoded.length) {
		return err('Failed to convert all transaction fields to buffers');
	}
	const [kind, nonce, from, body, sig] = results;
	try {
		return ok({
			kind: kind.toString() as TxKind,
			nonce: convertBufferToBigInt(nonce),
			from: `0x${from.toString('hex')}`,
			body: JSON.parse(body.toString()) as { message: string },
			sig: `0x${sig.toString('hex')}`,
		});
	} catch (e) {
		return err(`Failed to parse transaction: ${String(e)}`);
	}
};

/* — Entity Frame encode/decode — */
export const encodeFrame = <S>(frame: Frame<S>): Buffer =>
	Buffer.from(
		rlp.encode([
			convertBigIntToBuffer(frame.height),
			frame.ts,
			frame.txs.map(encodeTransaction),
			Buffer.from(JSON.stringify(frame.state)), // state is encoded as JSON for simplicity
		]),
	);
export const decodeFrame = <S>(buffer: Buffer): Result<Frame<S>> => {
	const decoded = rlp.decode(buffer) as RLPDecodedValue;
	if (Buffer.isBuffer(decoded)) {
		return err('Expected array for frame');
	}
	if (decoded.length !== FRAME_FIELD_COUNT) {
		return err('Invalid frame structure');
	}

	const heightResult = asBuffer(decoded[0]);
	const timestampResult = asBuffer(decoded[1]);
	const stateResult = asBuffer(decoded[3]);

	if (!heightResult.ok) return err(heightResult.error);
	if (!timestampResult.ok) return err(timestampResult.error);
	if (!stateResult.ok) return err(stateResult.error);

	const transactions = decoded[2];
	if (Buffer.isBuffer(transactions)) {
		return err('Expected array for transactions');
	}

	const txResults = transactions.map(tx => {
		const txBufferResult = asBuffer(tx);
		if (!txBufferResult.ok) return txBufferResult;
		return decodeTransaction(txBufferResult.value);
	});

	// Check for any errors
	const firstError = txResults.find(r => !r.ok);
	if (firstError && !firstError.ok) {
		return err(firstError.error);
	}

	const txs = txResults.filter((r): r is Result<Transaction, never> & { ok: true } => r.ok).map(r => r.value);

	try {
		return ok({
			height: convertBufferToBigInt(heightResult.value),
			ts: Number(timestampResult.value.toString()),
			txs,
			state: rlp.decode(stateResult.value) as S,
		});
	} catch (e) {
		return err(`Failed to decode frame: ${String(e)}`);
	}
};

/* — Command encode/decode (wrapped in Input) — */
const encodeCommand = (command: Command): Buffer[] => {
	// Custom replacer to handle BigInt serialization
	const replacer = (_key: string, value: unknown) => (typeof value === 'bigint' ? value.toString() : value);
	return [Buffer.from(command.type), Buffer.from(JSON.stringify(command, replacer))];
};
const decodeCommand = (arr: RLPDecodedValue[]): Result<Command> => {
	// Custom reviver to restore BigInt values
	const reviver = (key: string, value: unknown) => {
		// Detect numeric strings that should be BigInt (nonce, height, etc)
		if (
			typeof value === 'string' &&
			/^\d+$/.test(value) &&
			(key === 'nonce' || key === 'height' || (key === 'ts' && value.length > TIMESTAMP_BIGINT_THRESHOLD))
		) {
			return BigInt(value);
		}
		return value;
	};
	if (arr.length !== COMMAND_FIELD_COUNT) {
		return err('Invalid command structure');
	}
	const cmdDataResult = asBuffer(arr[1]);
	if (!cmdDataResult.ok) return err(cmdDataResult.error);

	try {
		return ok(JSON.parse(cmdDataResult.value.toString(), reviver) as Command);
	} catch (e) {
		return err(`Failed to parse command: ${String(e)}`);
	}
};

/* — Input (wire packet) encode/decode — */
export const encodeInput = (input: Input): Buffer =>
	Buffer.from(rlp.encode([input.from, input.to, encodeCommand(input.cmd)]));
export const decodeInput = (buffer: Buffer): Result<Input> => {
	const decoded = rlp.decode(buffer) as RLPDecodedValue;
	if (Buffer.isBuffer(decoded)) {
		return err('Expected array for input');
	}
	if (decoded.length !== INPUT_FIELD_COUNT) {
		return err('Invalid input structure');
	}

	const fromResult = asBuffer(decoded[0]);
	const toResult = asBuffer(decoded[1]);
	if (!fromResult.ok) return err(fromResult.error);
	if (!toResult.ok) return err(toResult.error);

	const cmdArr = decoded[2];
	if (Buffer.isBuffer(cmdArr)) {
		return err('Expected array for command');
	}

	const cmdResult = decodeCommand(cmdArr);
	if (!cmdResult.ok) return err(cmdResult.error);

	return ok({
		from: fromResult.value.toString() as Hex,
		to: toResult.value.toString() as Hex,
		cmd: cmdResult.value,
	});
};

/* — ServerFrame encode/decode — */
export const encodeServerFrame = (frame: import('../types').ServerFrame): Buffer =>
	Buffer.from(rlp.encode([convertBigIntToBuffer(frame.height), frame.ts, frame.inputs.map(encodeInput), frame.root]));
export const decodeServerFrame = (buffer: Buffer): Result<import('../types').ServerFrame> => {
	const decoded = rlp.decode(buffer) as RLPDecodedValue;
	if (Buffer.isBuffer(decoded)) {
		return err('Expected array for server frame');
	}
	if (decoded.length !== SERVER_FRAME_FIELD_COUNT) {
		return err('Invalid server frame structure');
	}
	const heightResult = asBuffer(decoded[0]);
	const timestampResult = asBuffer(decoded[1]);
	const inputs = decoded[2];
	const rootResult = asBuffer(decoded[3]);

	if (!heightResult.ok) return err(heightResult.error);
	if (!timestampResult.ok) return err(timestampResult.error);
	if (!rootResult.ok) return err(rootResult.error);

	if (Buffer.isBuffer(inputs)) {
		return err('Expected array for inputs');
	}

	// Decode all inputs functionally
	const inputResults = inputs.map(input => {
		const inputBufferResult = asBuffer(input);
		if (!inputBufferResult.ok) return inputBufferResult;
		return decodeInput(inputBufferResult.value);
	});

	// Check for any errors
	const firstError = inputResults.find(r => !r.ok);
	if (firstError && !firstError.ok) {
		return err(firstError.error);
	}

	const decodedInputs = inputResults.filter((r): r is Result<Input, never> & { ok: true } => r.ok).map(r => r.value);

	const frameWithoutHash: import('../types').ServerFrame = {
		height: convertBufferToBigInt(heightResult.value),
		ts: Number(timestampResult.value.toString()),
		inputs: decodedInputs,
		root: `0x${rootResult.value.toString('hex')}`,
		hash: DUMMY_SIGNATURE as Hex,
	};
	return ok({
		...frameWithoutHash,
		hash: `0x${Buffer.from(keccak(encodeServerFrame(frameWithoutHash))).toString('hex')}`,
	});
};
