import { Input, Replica, getAddrKey, ServerFrame, ServerState, TS, Hex, Address, Frame, EntityState } from '../types';
import { applyCommand } from './entity';
import { keccak_256 as keccak } from '@noble/hashes/sha3';
import { encodeServerFrame } from '../codec/rlp';
import { DUMMY_SIGNATURE, HASH_HEX_PREFIX } from '../constants';

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
	const replacer = (_key: string, value: unknown) => (typeof value === 'bigint' ? value.toString() : value);

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
const calculatePower = (signatures: Map<Address, string>) => signatures.size; // in our genesis, each signer has 1 share

/* ──────────── Pure Server reducer (executed every ${TICK_INTERVAL_MS}ms tick) ──────────── */
/**
 * Apply a batch of Inputs to the server's state for one tick.
 * Uses RORO pattern for cleaner API.
 */
export function applyServerBlock({ prev, batch, timestamp }: ApplyServerBlockParams): ApplyServerBlockResult {
	// Process all inputs and collect results
	const { finalReplicas, allOutbox } = batch.reduce(
		(acc, input) => {
			const { cmd: command } = input;
			/* Determine routing key.
			   If the command is entity-specific, route to the Replica that should handle it.
			   We use addrKey (jurisdiction:entity) plus signer's address for uniqueness when needed. */
			const signerPart =
				command.type === 'ADD_TX'
					? input.to // Route to the intended recipient (proposer)
					: command.type === 'SIGN'
						? input.to // Route to the proposer (recipient)
						: command.type === 'PROPOSE'
							? input.from // Use the sender as the proposer
							: command.type === 'COMMIT'
								? input.to // Route to the recipient
								: '';

			const key = command.type === 'IMPORT' ? '' : command.addrKey + (signerPart ? ':' + signerPart : '');

			/* ─── IMPORT command (bootstrap a new Entity into server state) ─── */
			if (command.type === 'IMPORT') {
				const baseReplica = command.replica;
				const eKey = getAddrKey(baseReplica.address); // e.g. "demo:chat"
				// Clone and insert one Replica per signer in the quorum (each signer gets its own replica state)
				const newReplicas = Object.keys(baseReplica.last.state.quorum.members).reduce((reps, signerAddr) => {
					const replicaCopy: Replica = { ...baseReplica, proposer: signerAddr as Address };
					return new Map(reps).set(`${eKey}:${signerAddr}`, replicaCopy);
				}, acc.finalReplicas);
				return { finalReplicas: newReplicas, allOutbox: acc.allOutbox };
			}

			const replica = acc.finalReplicas.get(key);
			if (!replica) return acc; // no replica found (shouldn't happen if IMPORT was done properly)

			/* ─── Apply the Entity state machine ─── */
			const updatedReplica = applyCommand({ replica, command });
			const updatedReplicas = new Map(acc.finalReplicas).set(key, updatedReplica);

			/* ─── Deterministic post-effects: generate follow-up commands if needed ─── */
			const newOutbox = (() => {
				switch (command.type) {
					case 'PROPOSE': {
						if (!replica.proposal && updatedReplica.proposal) {
							// Proposal just created: ask all signers (including proposer) to SIGN
							// Safety check: ensure proposal actually exists before accessing properties
							if (!updatedReplica.proposal.hash) {
								console.error('FRAME_BUILD_ERR: Proposal created without hash');
								return [];
							}
							return Object.keys(updatedReplica.last.state.quorum.members).map(s => ({
								from: s as Address,
								to: updatedReplica.proposer, // Send to proposer
								cmd: {
									type: 'SIGN' as const,
									addrKey: command.addrKey,
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
							const prevPower = replica.proposal ? calculatePower(replica.proposal.sigs) : 0;
							const newPower = calculatePower(updatedReplica.proposal.sigs);
							if (prevPower < q.threshold && newPower >= q.threshold) {
								// Threshold just reached: proposer will broadcast COMMIT
								// We need to send COMMIT to all replicas of this entity
								// Safety check: ensure proposal exists before accessing properties
								if (!updatedReplica.proposal) {
									console.error('COMMIT_ERR: Proposal disappeared during SIGN processing');
									return [];
								}
								return Object.keys(updatedReplica.last.state.quorum.members).map(signerAddr => ({
									from: updatedReplica.proposer,
									to: signerAddr as Address,
									cmd: {
										type: 'COMMIT' as const,
										addrKey: command.addrKey,
										hanko: DUMMY_SIGNATURE as Hex,
										frame: {
											height: updatedReplica.proposal.height,
											ts: updatedReplica.proposal.ts,
											txs: updatedReplica.proposal.txs,
											state: updatedReplica.proposal.state,
										} as Frame<EntityState>,
										signers: [], // Will be filled by runtime
										_sigs: Object.fromEntries(updatedReplica.proposal.sigs), // Pass sigs separately for runtime
									},
								}));
							}
						}
						return [];
					}
					case 'ADD_TX': {
						// ADD_TX only adds to mempool, doesn't trigger PROPOSE
						// PROPOSE will be triggered once per tick if there are pending transactions
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
				allOutbox: [...acc.allOutbox, ...newOutbox],
			};
		},
		{ finalReplicas: new Map(prev.replicas), allOutbox: [] as Input[] },
	);

	/* ─── Generate PROPOSE commands for entities with pending transactions ─── */
	const proposeEntries = Array.from(finalReplicas.entries()).reduce<Array<[string, Input]>>(
		(entries, [key, replica]) => {
			const entityKey = replica.address.jurisdiction + ':' + replica.address.entityId;

			// Only process each entity once, and only if it's the proposer's replica
			if (key.endsWith(':' + replica.proposer) && !replica.isAwaitingSignatures && replica.mempool.length > 0) {
				return [
					...entries,
					[
						entityKey,
						{
							from: replica.proposer,
							to: replica.proposer,
							cmd: {
								type: 'PROPOSE' as const,
								addrKey: entityKey,
								ts: timestamp,
							},
						},
					],
				];
			}
			return entries;
		},
		[],
	);

	// Filter to unique entities and extract commands
	const proposeCommands = proposeEntries.reduce<{ seen: string[]; commands: Input[] }>(
		(acc, [entityKey, input]) => {
			if (acc.seen.includes(entityKey)) {
				return acc;
			}
			return {
				seen: [...acc.seen, entityKey],
				commands: [...acc.commands, input],
			};
		},
		{ seen: [], commands: [] },
	).commands;

	// Add PROPOSE commands to outbox
	const finalOutbox = [...allOutbox, ...proposeCommands];

	/* ─── After processing all inputs, build the ServerFrame for this tick ─── */
	const newHeight = prev.height + 1n;
	const rootHash = computeRoot(finalReplicas); // Merkle root of all Entity states after this tick
	const frame: ServerFrame = {
		height: newHeight,
		ts: timestamp,
		inputs: batch,
		root: rootHash,
		hash: (HASH_HEX_PREFIX +
			Buffer.from(
				keccak(
					encodeServerFrame({
						height: newHeight,
						ts: timestamp,
						inputs: batch,
						root: rootHash,
						hash: DUMMY_SIGNATURE as Hex,
					}),
				),
			).toString('hex')) as Hex,
	};

	return {
		state: { replicas: finalReplicas, height: newHeight },
		frame,
		outbox: finalOutbox,
	};
}
