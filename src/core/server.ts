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
	Frame,
	EntityState,
} from '../types';
import { applyCommand } from './entity';
import { keccak_256 as keccak } from '@noble/hashes/sha3';
import { encodeServerFrame } from '../codec/rlp';
import { DUMMY_SIGNATURE, TICK_INTERVAL_MS, HASH_HEX_PREFIX } from '../constants';

/* ──────────── RORO Pattern Types ──────────── */
export interface ApplyServerBlockParams {
	prev: ServerState;
	batch: Input[];
	timestamp: TS;
}

export interface ApplyServerBlockResult {
	state: ServerState;
	frame: ServerFrame;
	outbox: Input[];
}

/* ──────────── Merkle root computation (simplified for MVP) ──────────── */
/** Compute a Merkle-like root over all replicas' last states.
 *  (Here we just hash the JSON of all state snapshots; in future, use proper Merkle tree.) */
const computeRoot = (replicas: Map<string, Replica>): Hex => {
	// Custom replacer to handle BigInt serialization
	const replacer = (key: string, value: any) => (typeof value === 'bigint' ? value.toString() : value);

	return (HASH_HEX_PREFIX +
		Buffer.from(
			keccak(
				JSON.stringify(
					[...replicas.values()].map(r => ({ addr: r.address, state: r.last.state })),
					replacer,
				),
			),
		).toString('hex')) as Hex;
};

/* ──────────── helper: trivial power calc (all shares = 1 in MVP) ──────────── */
const power = (sigs: Map<Address, string>, q: any) => sigs.size; // in our genesis, each signer has 1 share

/* ──────────── Pure Server reducer (executed every ${TICK_INTERVAL_MS}ms tick) ──────────── */
/**
 * Apply a batch of Inputs to the server's state for one tick.
 * Uses RORO pattern for cleaner API.
 */
export function applyServerBlock({ prev, batch, timestamp }: ApplyServerBlockParams): ApplyServerBlockResult {
	// Process all inputs and collect results
	const { finalReplicas, allOutbox } = batch.reduce(
		(acc, input) => {
			const { cmd } = input;
			/* Determine routing key.
			   If the command is entity-specific, route to the Replica that should handle it.
			   We use addrKey (jurisdiction:entity) plus signer's address for uniqueness when needed. */
			const signerPart = 
				cmd.type === 'ADD_TX' ? cmd.tx.from :
				cmd.type === 'SIGN' ? input.to : // Route to the proposer (recipient)
				cmd.type === 'PROPOSE' ? input.from : // Use the sender as the proposer
				cmd.type === 'COMMIT' ? input.to : // Route to the recipient
				'';

			const key = cmd.type === 'IMPORT' ? '' : cmd.addrKey + (signerPart ? ':' + signerPart : '');

			/* ─── IMPORT command (bootstrap a new Entity into server state) ─── */
			if (cmd.type === 'IMPORT') {
				const baseReplica = cmd.replica;
				const eKey = addrKey(baseReplica.address); // e.g. "demo:chat"
				// Clone and insert one Replica per signer in the quorum (each signer gets its own replica state)
				const newReplicas = Object.keys(baseReplica.last.state.quorum.members).reduce(
					(reps, signerAddr) => {
						const replicaCopy: Replica = { ...baseReplica, proposer: signerAddr as Address };
						return new Map(reps).set(`${eKey}:${signerAddr}`, replicaCopy);
					},
					acc.finalReplicas
				);
				return { finalReplicas: newReplicas, allOutbox: acc.allOutbox };
			}

			const replica = acc.finalReplicas.get(key);
			if (!replica) return acc; // no replica found (shouldn't happen if IMPORT was done properly)

			/* ─── Apply the Entity state machine ─── */
			const updatedReplica = applyCommand({ replica, command: cmd });
			const updatedReplicas = new Map(acc.finalReplicas).set(key, updatedReplica);

			/* ─── Deterministic post-effects: generate follow-up commands if needed ─── */
			const newOutbox = (() => {
				switch (cmd.type) {
					case 'PROPOSE': {
						if (!replica.proposal && updatedReplica.proposal) {
							// Proposal just created: ask all signers (including proposer) to SIGN
							return Object.keys(updatedReplica.last.state.quorum.members).map(s => ({
								from: s as Address,
								to: updatedReplica.proposer, // Send to proposer
								cmd: {
									type: 'SIGN' as const,
									addrKey: cmd.addrKey,
									signer: s as Address,
									frameHash: updatedReplica.proposal.hash,
									sig: DUMMY_SIGNATURE as Hex,
								},
							}));
						}
						return [];
					}
					case 'SIGN': {
						if (updatedReplica.isAwaitingSignatures && updatedReplica.proposal) {
							const q = updatedReplica.last.state.quorum;
							const prevPower = replica.proposal ? power(replica.proposal.sigs, q) : 0;
							const newPower = power(updatedReplica.proposal.sigs, q);
							if (prevPower < q.threshold && newPower >= q.threshold) {
								// Threshold just reached: proposer will broadcast COMMIT
								// We need to send COMMIT to all replicas of this entity
								return Object.keys(updatedReplica.last.state.quorum.members).map(signerAddr => ({
									from: updatedReplica.proposer,
									to: signerAddr as Address,
									cmd: {
										type: 'COMMIT' as const,
										addrKey: cmd.addrKey,
										hanko: DUMMY_SIGNATURE as Hex,
										frame: {
											height: updatedReplica.proposal!.height,
											ts: updatedReplica.proposal!.ts,
											txs: updatedReplica.proposal!.txs,
											state: updatedReplica.proposal!.state,
										} as Frame<EntityState>,
										signers: [], // Will be filled by runtime
										_sigs: Object.fromEntries(updatedReplica.proposal!.sigs), // Pass sigs separately for runtime
									} as any,
								}));
							}
						}
						return [];
					}
					case 'ADD_TX': {
						if (!updatedReplica.isAwaitingSignatures && updatedReplica.mempool.length) {
							// After adding a tx, if not already proposing, trigger a PROPOSE on next tick
							// The proposer's replica handles the PROPOSE, so we need to route to it
							return [{
								from: updatedReplica.proposer,
								to: updatedReplica.proposer,
								cmd: { type: 'PROPOSE' as const, addrKey: cmd.addrKey, ts: timestamp },
							}];
						}
						return [];
					}
					case 'COMMIT':
					case 'IMPORT':
						// COMMIT and IMPORT do not produce any outbox messages
						return [];
				}
			})();

			return {
				finalReplicas: updatedReplicas,
				allOutbox: [...acc.allOutbox, ...newOutbox]
			};
		},
		{ finalReplicas: new Map(prev.replicas), allOutbox: [] as Input[] }
	);

	/* ─── After processing all inputs, build the ServerFrame for this tick ─── */
	const newHeight = (prev.height + 1n) as UInt64;
	const rootHash = computeRoot(finalReplicas); // Merkle root of all Entity states after this tick
	const frame: ServerFrame = {
		height: newHeight,
		ts: timestamp,
		inputs: batch,
		root: rootHash,
		hash: (HASH_HEX_PREFIX + Buffer.from(keccak(encodeServerFrame({
			height: newHeight,
			ts: timestamp,
			inputs: batch,
			root: rootHash,
			hash: DUMMY_SIGNATURE as Hex,
		}))).toString('hex')) as Hex,
	};

	return { 
		state: { replicas: finalReplicas, height: newHeight }, 
		frame, 
		outbox: allOutbox 
	};
}
