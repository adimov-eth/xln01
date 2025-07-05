import {
  Input, Replica, Command, addrKey, ServerFrame, ServerState,
  TS, Hex, Address, UInt64
} from '../types';
import { applyCommand } from './entity';
import { keccak_256 as keccak } from '@noble/hashes/sha3';
import { encServerFrame } from '../codec/rlp';

/* ──────────── Merkle root computation (simplified for MVP) ──────────── */
/** Compute a Merkle-like root over all replicas' last states.
 *  (Here we just hash the JSON of all state snapshots; in future, use proper Merkle tree.) */
const computeRoot = (reps: Map<string, Replica>): Hex => {
  // Custom replacer to handle BigInt serialization
  const replacer = (key: string, value: any) =>
    typeof value === 'bigint' ? value.toString() : value;
  
  return ('0x' + Buffer.from(
      keccak(JSON.stringify(
        [...reps.values()].map(r => ({ addr: r.address, state: r.last.state })),
        replacer
      ))
    ).toString('hex')) as Hex;
};

/* ──────────── helper: trivial power calc (all shares = 1 in MVP) ──────────── */
const power = (sigs: Map<Address, string>, q: any) =>
  sigs.size;  // in our genesis, each signer has 1 share

/* ──────────── Pure Server reducer (executed every 100ms tick) ──────────── */
/**
 * Apply a batch of Inputs to the server's state for one tick.
 * @param prev - previous ServerState
 * @param batch - list of Inputs received in this tick
 * @param ts - current wall-clock timestamp (ms) for this tick
 * @returns { state: next ServerState, frame: ServerFrame, outbox: Input[] }
 */
export function applyServerBlock(prev: ServerState, batch: Input[], ts: TS) {
  let outbox: Input[] = [];
  const replicas = new Map(prev.replicas);

  const enqueue = (...msgs: Input[]) => { outbox.push(...msgs); };

  for (const input of batch) {
    const { cmd } = input;
    /* Determine routing key.
       If the command is entity-specific, route to the Replica that should handle it.
       We use addrKey (jurisdiction:entity) plus signer's address for uniqueness when needed. */
    let signerPart = '';
    if (cmd.type === 'ADD_TX') signerPart = cmd.tx.from;
    else if (cmd.type === 'SIGN') signerPart = input.to; // Route to the proposer (recipient)
    else if (cmd.type === 'PROPOSE') signerPart = input.from; // Use the sender as the proposer
    else if (cmd.type === 'COMMIT') signerPart = input.to; // Route to the recipient
    
    const key = (cmd.type === 'IMPORT')
      ? ''
      : cmd.addrKey + (signerPart ? ':' + signerPart : '');

    /* ─── IMPORT command (bootstrap a new Entity into server state) ─── */
    if (cmd.type === 'IMPORT') {
      const baseReplica = cmd.replica;
      const eKey = addrKey(baseReplica.address);  // e.g. "demo:chat"
      // Clone and insert one Replica per signer in the quorum (each signer gets its own replica state)
      for (const signerAddr of Object.keys(baseReplica.last.state.quorum.members)) {
        const replicaCopy: Replica = { ...baseReplica, proposer: signerAddr };
        replicas.set(`${eKey}:${signerAddr}`, replicaCopy);
      }
      continue;  // move to next input
    }

    const rep = replicas.get(key);
    if (!rep) continue;  // no replica found (shouldn't happen if IMPORT was done properly)

    /* ─── Apply the Entity state machine ─── */
    const updatedRep = applyCommand(rep, cmd);
    replicas.set(key, updatedRep);

    /* ─── Deterministic post-effects: generate follow-up commands if needed ─── */
    switch (cmd.type) {
      case 'PROPOSE': {
        if (!rep.proposal && updatedRep.proposal) {
          // Proposal just created: ask all other signers to SIGN
          for (const s of Object.keys(updatedRep.last.state.quorum.members)) {
            if (s === updatedRep.proposer) continue;  // skip proposer itself
            enqueue({
              from: s,
              to:   updatedRep.proposer,  // Send to proposer
              cmd:  { type: 'SIGN', addrKey: cmd.addrKey,
                      signer: s, frameHash: updatedRep.proposal.hash, sig: '0x00' }
            });
          }
        }
        break;
      }
      case 'SIGN': {
        if (updatedRep.isAwaitingSignatures && updatedRep.proposal) {
          const q = updatedRep.last.state.quorum;
          const prevPower = rep.proposal ? power(rep.proposal.sigs, q) : 0;
          const newPower  = power(updatedRep.proposal.sigs, q);
          if (prevPower < q.threshold && newPower >= q.threshold) {
            // Threshold just reached: proposer will broadcast COMMIT
            // We need to send COMMIT to all replicas of this entity
            for (const signerAddr of Object.keys(updatedRep.last.state.quorum.members)) {
              enqueue({
                from: updatedRep.proposer, 
                to: signerAddr,
                cmd:  { type: 'COMMIT', addrKey: cmd.addrKey,
                        hanko: '0x00', frame: {
                          height: updatedRep.proposal!.height,
                          ts: updatedRep.proposal!.ts,
                          txs: updatedRep.proposal!.txs,
                          state: updatedRep.proposal!.state,
                          sigs: Object.fromEntries(updatedRep.proposal!.sigs), // Convert Map to object
                          hash: updatedRep.proposal!.hash
                        } }
              });
            }
          }
        }
        break;
      }
      case 'ADD_TX': {
        if (!updatedRep.isAwaitingSignatures && updatedRep.mempool.length) {
          // After adding a tx, if not already proposing, trigger a PROPOSE on next tick
          // The proposer's replica handles the PROPOSE, so we need to route to it
          enqueue({
            from: updatedRep.proposer, to: updatedRep.proposer,
            cmd:  { type: 'PROPOSE', addrKey: cmd.addrKey, ts }
          });
        }
        break;
      }
      // COMMIT and IMPORT do not produce any outbox messages in this loop
    }
  }

  /* ─── After processing all inputs, build the ServerFrame for this tick ─── */
  const newHeight = (prev.height + 1n) as UInt64;
  const rootHash = computeRoot(replicas);  // Merkle root of all Entity states after this tick
  let frame: ServerFrame = {
    height: newHeight,
    ts,
    inputs: batch,
    root: rootHash,
    hash: '0x00' as Hex
  };
  frame.hash = ('0x' + Buffer.from(keccak(encServerFrame(frame))).toString('hex')) as Hex;

  return { state: { replicas, height: newHeight }, frame, outbox };
}