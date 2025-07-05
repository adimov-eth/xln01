import * as rlp from 'rlp';
import type { Frame, Transaction, TxKind, Input, Command, Hex, UInt64 } from '../types';
import { keccak_256 as keccak } from '@noble/hashes/sha3';
import { HASH_HEX_PREFIX, DUMMY_SIGNATURE } from '../constants';

/* — Type helpers for RLP operations — */
type RLPDecodedValue = Buffer | RLPDecodedValue[];

const isBuffer = (value: RLPDecodedValue): value is Buffer => 
	Buffer.isBuffer(value);

const asBuffer = (value: RLPDecodedValue): Buffer => {
	if (!isBuffer(value)) {
		throw new Error('Expected Buffer but got array');
	}
	return value;
};

const asBufferArray = (value: RLPDecodedValue): Buffer[] => {
	if (isBuffer(value)) {
		throw new Error('Expected array but got Buffer');
	}
	return value.map(asBuffer);
};

/* — internal helpers for bigint <-> Buffer — */
const bnToBuf = (n: UInt64) => (n === 0n ? Buffer.alloc(0) : Buffer.from(n.toString(16).padStart(2, '0'), 'hex'));
const bufToBn = (b: Buffer): UInt64 => (b.length === 0 ? 0n : BigInt('0x' + b.toString('hex')));

/* — Transaction encode/decode — */
export const encodeTx = (t: Transaction): Buffer =>
	Buffer.from(
		rlp.encode([
			t.kind,
			bnToBuf(t.nonce),
			t.from,
			JSON.stringify(t.body), // body is small JSON (e.g. {"message": "hi"})
			t.sig,
		]),
	);
export const decodeTx = (b: Buffer): Transaction => {
	const decoded = rlp.decode(b) as RLPDecodedValue;
	if (isBuffer(decoded)) {
		throw new Error('Expected array for transaction');
	}
	const [k, n, f, body, sig] = decoded.map(asBuffer);
	return {
		kind: k.toString() as TxKind,
		nonce: bufToBn(n),
		from: `${HASH_HEX_PREFIX}${f.toString('hex')}` as Hex,
		body: JSON.parse(body.toString()) as { message: string },
		sig: `${HASH_HEX_PREFIX}${sig.toString('hex')}` as Hex,
	};
};

/* — Entity Frame encode/decode — */
export const encodeFrame = <S>(f: Frame<S>): Buffer =>
	Buffer.from(
		rlp.encode([
			bnToBuf(f.height),
			f.ts,
			f.txs.map(encodeTx),
			rlp.encode(f.state), // state is encoded as RLP of its data structure
		]),
	);
export const decodeFrame = <S>(b: Buffer): Frame<S> => {
	const decoded = rlp.decode(b) as RLPDecodedValue;
	if (isBuffer(decoded)) {
		throw new Error('Expected array for frame');
	}
	if (decoded.length !== 4) {
		throw new Error('Invalid frame structure');
	}
	const h = asBuffer(decoded[0]);
	const ts = asBuffer(decoded[1]);
	const txs = decoded[2];
	const st = asBuffer(decoded[3]);
	
	if (isBuffer(txs)) {
		throw new Error('Expected array for transactions');
	}
	
	return {
		height: bufToBn(h),
		ts: Number(ts.toString()),
		txs: txs.map(tx => decodeTx(asBuffer(tx))),
		state: rlp.decode(st) as S,
	};
};

/* — Command encode/decode (wrapped in Input) — */
const encodeCommand = (c: Command): Buffer[] => {
	// Custom replacer to handle BigInt serialization
	const replacer = (_key: string, value: unknown) => 
		typeof value === 'bigint' ? value.toString() : value;
	return [Buffer.from(c.type), Buffer.from(JSON.stringify(c, replacer))];
};
const decodeCommand = (arr: RLPDecodedValue[]): Command => {
	// Custom reviver to restore BigInt values
	const reviver = (key: string, value: unknown) => {
		// Detect numeric strings that should be BigInt (nonce, height, etc)
		if (
			typeof value === 'string' &&
			/^\d+$/.test(value) &&
			(key === 'nonce' || key === 'height' || (key === 'ts' && value.length > 15))
		) {
			return BigInt(value);
		}
		return value;
	};
	if (arr.length !== 2) {
		throw new Error('Invalid command structure');
	}
	const cmdData = asBuffer(arr[1]);
	return JSON.parse(cmdData.toString(), reviver) as Command;
};

/* — Input (wire packet) encode/decode — */
export const encodeInput = (i: Input): Buffer => Buffer.from(rlp.encode([i.from, i.to, encodeCommand(i.cmd)]));
export const decodeInput = (b: Buffer): Input => {
	const decoded = rlp.decode(b) as RLPDecodedValue;
	if (isBuffer(decoded)) {
		throw new Error('Expected array for input');
	}
	if (decoded.length !== 3) {
		throw new Error('Invalid input structure');
	}
	const from = asBuffer(decoded[0]);
	const to = asBuffer(decoded[1]);
	const cmdArr = decoded[2];
	
	if (isBuffer(cmdArr)) {
		throw new Error('Expected array for command');
	}
	
	return {
		from: from.toString() as Hex,
		to: to.toString() as Hex,
		cmd: decodeCommand(cmdArr),
	};
};

/* — ServerFrame encode/decode — */
export const encodeServerFrame = (f: import('../types').ServerFrame): Buffer =>
	Buffer.from(rlp.encode([bnToBuf(f.height), f.ts, f.inputs.map(encodeInput), f.root]));
export const decodeServerFrame = (b: Buffer): import('../types').ServerFrame => {
	const decoded = rlp.decode(b) as RLPDecodedValue;
	if (isBuffer(decoded)) {
		throw new Error('Expected array for server frame');
	}
	if (decoded.length !== 4) {
		throw new Error('Invalid server frame structure');
	}
	const h = asBuffer(decoded[0]);
	const ts = asBuffer(decoded[1]);
	const ins = decoded[2];
	const root = asBuffer(decoded[3]);
	
	if (isBuffer(ins)) {
		throw new Error('Expected array for inputs');
	}
	
	const frameWithoutHash: import('../types').ServerFrame = {
		height: bufToBn(h),
		ts: Number(ts.toString()),
		inputs: ins.map(input => decodeInput(asBuffer(input))),
		root: `${HASH_HEX_PREFIX}${root.toString('hex')}` as Hex,
		hash: DUMMY_SIGNATURE as Hex,
	};
	return {
		...frameWithoutHash,
		hash: (HASH_HEX_PREFIX + Buffer.from(keccak(encodeServerFrame(frameWithoutHash))).toString('hex')) as Hex,
	};
};
