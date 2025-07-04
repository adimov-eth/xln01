import {
  Input,
  Replica,
  Command,
  addrKey,
  ServerFrame,
  ServerState,
  TS,
  Hex,
  Address,
  UInt64,
} from '../types';
import { applyCommand } from './entity';
import { keccak_256 as keccak } from '@noble/hashes/sha3';
import { encServerFrame } from '../codec/rlp';

const stringify = (o: unknown) =>
  JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
const computeRoot = (reps: Map<string, Replica>): Hex =>
  ('0x' + Buffer.from(
    keccak(stringify([...reps.values()].map(r => ({ addr: r.address, state: r.last.state }))))
  ).toString('hex')) as Hex;
const power = (sigs: Map<Address, Hex>, q: any) => sigs.size;

export function applyServerBlock(prev: ServerState, batch: Input[], ts: TS) {
  let outbox: Input[] = [];
  const replicas = new Map(prev.replicas);
  const enqueue = (...msgs: Input[]) => outbox.push(...msgs);

  for (const { cmd } of batch) {
    const signerPart = cmd.type === 'ADD_TX' ? cmd.tx.from : cmd.type === 'SIGN' ? cmd.signer : '';
    const key = cmd.type === 'IMPORT' ? '' : cmd.addrKey + (signerPart ? ':' + signerPart : '');

    if (cmd.type === 'IMPORT') {
      const baseReplica = cmd.replica;
      const eKey = addrKey(baseReplica.address);
      for (const signerAddr of Object.keys(baseReplica.last.state.quorum.members)) {
        const replicaCopy: Replica = { ...baseReplica, proposer: signerAddr as Address };
        replicas.set(`${eKey}:${signerAddr}`, replicaCopy);
      }
      continue;
    }

    const rep = replicas.get(key);
    if (!rep) continue;

    const updatedRep = applyCommand(rep, cmd);
    replicas.set(key, updatedRep);

    switch (cmd.type) {
      case 'PROPOSE': {
        if (!rep.proposal && updatedRep.proposal) {
          for (const s of Object.keys(updatedRep.last.state.quorum.members)) {
            if (s === updatedRep.proposer) continue;
            enqueue({ from: s as Address, to: updatedRep.proposer, cmd: { type: 'SIGN', addrKey: cmd.addrKey, signer: s as Address, frameHash: updatedRep.proposal.hash, sig: '0x00' as Hex } });
          }
        }
        break;
      }
      case 'SIGN': {
        if (updatedRep.isAwaitingSignatures && updatedRep.proposal) {
          const q = updatedRep.last.state.quorum;
          const prevPower = rep.proposal ? power(rep.proposal.sigs as any, q) : 0;
          const newPower = power(updatedRep.proposal.sigs as any, q);
          if (prevPower < q.threshold && newPower >= q.threshold) {
            enqueue({ from: updatedRep.proposer, to: updatedRep.proposer, cmd: { type: 'COMMIT', addrKey: cmd.addrKey, hanko: '0x00' as Hex, frame: updatedRep.proposal as any } });
          }
        }
        break;
      }
      case 'ADD_TX': {
        if (!updatedRep.isAwaitingSignatures && updatedRep.mempool.length) {
          enqueue({ from: rep.proposer, to: rep.proposer, cmd: { type: 'PROPOSE', addrKey: cmd.addrKey, ts } });
        }
        break;
      }
    }
  }

  const newHeight = (prev.height + 1n) as UInt64;
  const rootHash = computeRoot(replicas);
  let frame: ServerFrame = { height: newHeight, ts, inputs: batch, root: rootHash, hash: '0x00' as Hex };
  frame.hash = ('0x' + Buffer.from(keccak(encServerFrame(frame))).toString('hex')) as Hex;

  return { state: { replicas, height: newHeight }, frame, outbox };
}
