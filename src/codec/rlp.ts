import rlp from 'rlp';
import type { Frame, Transaction, TxKind, Input, Command, Hex, UInt64 } from '../types';
import { keccak_256 as keccak } from '@noble/hashes/sha3';

const bnToBuf = (n: UInt64) => (n === 0n ? new Uint8Array() : Buffer.from(n.toString(16).padStart(2, '0'), 'hex'));
const bufToBn = (b: Uint8Array): UInt64 => (b.length === 0 ? 0n : BigInt('0x' + Buffer.from(b).toString('hex')));

export const encTx = (t: Transaction): Uint8Array =>
  rlp.encode([t.kind, bnToBuf(t.nonce), t.from, JSON.stringify(t.body), t.sig]);
export const decTx = (b: Uint8Array): Transaction => {
  const [k, n, f, body, sig] = rlp.decode(b) as Uint8Array[];
  return {
    kind: k.toString() as TxKind,
    nonce: bufToBn(n),
    from: ('0x' + Buffer.from(f).toString('hex')) as Hex,
    body: JSON.parse(body.toString()),
    sig: ('0x' + Buffer.from(sig).toString('hex')) as Hex,
  } as Transaction;
};

export const encFrame = <S>(f: Frame<S>): Uint8Array =>
  rlp.encode([bnToBuf(f.height), f.ts, f.txs.map(encTx), rlp.encode(f.state as any)]);
export const decFrame = <S>(b: Uint8Array): Frame<S> => {
  const [h, ts, txs, st] = rlp.decode(b) as any[];
  return {
    height: bufToBn(h),
    ts: Number(ts.toString()),
    txs: (txs as Uint8Array[]).map(decTx),
    state: rlp.decode(st) as S,
  };
};

const stringify = (o: unknown) =>
  JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
const encCmd = (c: Command): unknown => [c.type, stringify(c)];
const decCmd = (arr: any[]): Command => JSON.parse(arr[1].toString());

export const encInput = (i: Input): Uint8Array => rlp.encode([i.from, i.to, encCmd(i.cmd)] as any);
export const decInput = (b: Uint8Array): Input => {
  const [from, to, cmdArr] = rlp.decode(b) as any[];
  return { from: from.toString(), to: to.toString(), cmd: decCmd(cmdArr) };
};

export const encServerFrame = (f: import('../types').ServerFrame): Uint8Array =>
  rlp.encode([bnToBuf(f.height), f.ts, f.inputs.map(encInput), f.root]);
export const decServerFrame = (b: Uint8Array): import('../types').ServerFrame => {
  const [h, ts, ins, root] = rlp.decode(b) as any[];
  let frame: import('../types').ServerFrame = {
    height: bufToBn(h),
    ts: Number(ts.toString()),
    inputs: (ins as Uint8Array[]).map(decInput),
    root: ('0x' + Buffer.from(root).toString('hex')) as Hex,
    hash: '0x00' as Hex,
  };
  frame.hash = ('0x' + Buffer.from(keccak(encServerFrame(frame))).toString('hex')) as Hex;
  return frame;
};
