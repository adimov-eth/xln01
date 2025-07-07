import { keccak_256 as keccak } from '@noble/hashes/sha3';
import * as rlp from 'rlp';
import { DUMMY_SIGNATURE } from '../constants';
import type { Command, Frame, Hex, Input, Transaction, TxKind, UInt64 } from '../types';

/* — Type helpers for RLP operations — */
type RLPDecodedValue = Buffer | RLPDecodedValue[];

const isBuffer = (value: RLPDecodedValue): value is Buffer => Buffer.isBuffer(value);

const asBuffer = (value: RLPDecodedValue): Buffer | undefined => {
	if (!isBuffer(value)) {
		return undefined;
	}
	return value;
};

// const asBufferArray = (value: RLPDecodedValue): Buffer[] => {
// 	if (isBuffer(value)) {
// 		// Instead of throwing, return an empty array or handle as needed
// 		return [];
// 	}
// 	return value.map(asBuffer).filter((b): b is Buffer => b !== undefined);
// };

/* — internal helpers for bigint <-> Buffer — */
const bnToBuf = (n: UInt64) => (n === 0n ? Buffer.alloc(0) : Buffer.from(`${n.toString(16).padStart(2, '0')}`, 'hex'));
const bufToBn = (b: Buffer): UInt64 => (b.length === 0 ? 0n : BigInt(`0x${b.toString('hex')}`));

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
export const decodeTx = (b: Buffer): Transaction | null => {
	const decoded = rlp.decode(b) as RLPDecodedValue;
	if (isBuffer(decoded)) {
		return null;
	}
	const [k, n, f, body, sig] = decoded.map(asBuffer);
	if (!k || !n || !f || !body || !sig) {
		return null;
	}
	return {
		kind: k.toString() as TxKind,
		nonce: bufToBn(n),
		from: `0x${f.toString('hex')}`,
		body: JSON.parse(body.toString()) as { message: string },
		sig: `0x${sig.toString('hex')}`,
	};
};

/* — Entity Frame encode/decode — */
export const encodeFrame = <S>(f: Frame<S>): Buffer =>
	Buffer.from(
		rlp.encode([
			bnToBuf(f.height),
			f.ts,
			f.txs.map(encodeTx),
			JSON.stringify(f.state), // state is serialized as JSON
		]),
	);
export const decodeFrame = <S>(b: Buffer): Frame<S> | null => {
	const decoded = rlp.decode(b) as RLPDecodedValue;
	if (isBuffer(decoded)) {
		return null;
	}
	if (decoded.length !== 4) {
		return null;
	}
	const h = asBuffer(decoded[0]);
	const ts = asBuffer(decoded[1]);
	const txs = decoded[2];
	const st = asBuffer(decoded[3]);

	if (!h || !ts || !st || isBuffer(txs)) {
		return null;
	}

	const decodedTxs = txs
		.map(tx => {
			const buf = asBuffer(tx);
			return buf ? decodeTx(buf) : null;
		})
		.filter((tx): tx is Transaction => tx !== null);

	return {
		height: bufToBn(h),
		ts: Number(ts.toString()),
		txs: decodedTxs,
		state: JSON.parse(st.toString()) as S,
	};
};

/* — Command encode/decode (wrapped in Input) — */
const encodeCommand = (c: Command): Buffer[] => {
	// Custom replacer to handle BigInt serialization
	const replacer = (_key: string, value: unknown) => (typeof value === 'bigint' ? value.toString() : value);
	return [Buffer.from(c.type), Buffer.from(JSON.stringify(c, replacer))];
};
const decodeCommand = (arr: RLPDecodedValue[]): Command | null => {
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
		return null;
	}
	const cmdData = asBuffer(arr[1]);
	if (!cmdData) {
		return null;
	}
	return JSON.parse(cmdData.toString(), reviver) as Command;
};

/* — Input (wire packet) encode/decode — */
export const encodeInput = (i: Input): Buffer => Buffer.from(rlp.encode([i.from, i.to, encodeCommand(i.cmd)]));
export const decodeInput = (b: Buffer): Input | null => {
	const decoded = rlp.decode(b) as RLPDecodedValue;
	if (isBuffer(decoded)) {
		return null;
	}
	if (decoded.length !== 3) {
		return null;
	}
	const from = asBuffer(decoded[0]);
	const to = asBuffer(decoded[1]);
	const cmdArr = decoded[2];

	if (!from || !to || isBuffer(cmdArr)) {
		return null;
	}

	const cmd = decodeCommand(cmdArr);
	if (!cmd) {
		return null;
	}

	return {
		from: from.toString() as Hex,
		to: to.toString() as Hex,
		cmd,
	};
};

/* — ServerFrame encode/decode — */
export const encodeServerFrame = (f: import('../types').ServerFrame): Buffer =>
	Buffer.from(rlp.encode([bnToBuf(f.height), f.ts, f.inputs.map(encodeInput), f.root]));
export const decodeServerFrame = (b: Buffer): import('../types').ServerFrame | null => {
	const decoded = rlp.decode(b) as RLPDecodedValue;
	if (isBuffer(decoded)) {
		return null;
	}
	if (decoded.length !== 4) {
		return null;
	}
	const h = asBuffer(decoded[0]);
	const ts = asBuffer(decoded[1]);
	const ins = decoded[2];
	const root = asBuffer(decoded[3]);

	if (!h || !ts || !root || isBuffer(ins)) {
		return null;
	}

	const decodedInputs = ins
		.map(input => {
			const buf = asBuffer(input);
			return buf ? decodeInput(buf) : null;
		})
		.filter((input): input is Input => input !== null);

	const frameWithoutHash: import('../types').ServerFrame = {
		height: bufToBn(h),
		ts: Number(ts.toString()),
		inputs: decodedInputs,
		root: `0x${root.toString('hex')}`,
		hash: DUMMY_SIGNATURE,
	};
	return {
		...frameWithoutHash,
		hash: `0x${Buffer.from(keccak(encodeServerFrame(frameWithoutHash))).toString('hex')}`,
	};
};
