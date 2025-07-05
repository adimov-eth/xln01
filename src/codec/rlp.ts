import * as rlp from 'rlp';
import type { Frame, Transaction, TxKind, Input, Command, Hex, UInt64 } from '../types';
import { keccak_256 as keccak } from '@noble/hashes/sha3';

/* — internal helpers for bigint <-> Buffer — */
const bnToBuf = (n: UInt64) =>
  n === 0n ? Buffer.alloc(0) : Buffer.from(n.toString(16).padStart(2, '0'), 'hex');
const bufToBn = (b: Buffer): UInt64 =>
  b.length === 0 ? 0n : BigInt('0x' + b.toString('hex'));

/* — Transaction encode/decode — */
export const encTx = (t: Transaction): Buffer => 
  rlp.encode([
    t.kind,
    bnToBuf(t.nonce),
    t.from,
    JSON.stringify(t.body),  // body is small JSON (e.g. {"message": "hi"})
    t.sig,
  ]);
export const decTx = (b: Buffer): Transaction => {
  const [k, n, f, body, sig] = rlp.decode(b) as Buffer[];
  return {
    kind : k.toString() as TxKind,
    nonce: bufToBn(n),
    from : `0x${f.toString('hex')}`,
    body : JSON.parse(body.toString()),
    sig  : `0x${sig.toString('hex')}`,
  } as Transaction;
};

/* — Entity Frame encode/decode — */
export const encFrame = <S>(f: Frame<S>): Buffer =>
  rlp.encode([
    bnToBuf(f.height),
    f.ts,
    f.txs.map(encTx),
    rlp.encode(f.state as any),   // state is encoded as RLP of its data structure
  ]);
export const decFrame = <S>(b: Buffer): Frame<S> => {
  const [h, ts, txs, st] = rlp.decode(b) as any[];
  return {
    height: bufToBn(h),
    ts    : Number(ts.toString()),
    txs   : (txs as Buffer[]).map(decTx),
    state : rlp.decode(st) as S,
  };
};

/* — Command encode/decode (wrapped in Input) — */
const encCmd = (c: Command): unknown => {
  // Custom replacer to handle BigInt serialization
  const replacer = (key: string, value: any) =>
    typeof value === 'bigint' ? value.toString() : value;
  return [c.type, JSON.stringify(c, replacer)];
};
const decCmd = (arr: any[]): Command => {
  // Custom reviver to restore BigInt values
  const reviver = (key: string, value: any) => {
    // Detect numeric strings that should be BigInt (nonce, height, etc)
    if (typeof value === 'string' && /^\d+$/.test(value) && 
        (key === 'nonce' || key === 'height' || key === 'ts' && value.length > 15)) {
      return BigInt(value);
    }
    return value;
  };
  return JSON.parse(arr[1].toString(), reviver);
};

/* — Input (wire packet) encode/decode — */
export const encInput = (i: Input): Buffer =>
  rlp.encode([ i.from, i.to, encCmd(i.cmd) ]);
export const decInput = (b: Buffer): Input => {
  const [from, to, cmdArr] = rlp.decode(b) as any[];
  return {
    from: from.toString(),
    to  : to.toString(),
    cmd : decCmd(cmdArr)
  };
};

/* — ServerFrame encode/decode — */
export const encServerFrame = (f: import('../types').ServerFrame): Buffer =>
  rlp.encode([
    bnToBuf(f.height),
    f.ts,
    f.inputs.map(encInput),
    f.root,
  ]);
export const decServerFrame = (b: Buffer): import('../types').ServerFrame => {
  const [h, ts, ins, root] = rlp.decode(b) as any[];
  const frame = {
    height: bufToBn(h),
    ts: Number(ts.toString()),
    inputs: (ins as Buffer[]).map(decInput),
    root: `0x${root.toString('hex')}`,
    hash: '0x00' as Hex,  // will be filled after decoding if needed
  };
  frame.hash = ('0x' + Buffer.from(keccak(encServerFrame(frame))).toString('hex')) as Hex;
  return frame;
};