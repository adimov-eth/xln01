import { keccak_256 as keccak } from '@noble/hashes/sha3';
import { canonical } from '../codec/canonical';
import { encodeServerFrame } from '../codec/rlp';
import { DUMMY_SIGNATURE, EMPTY_HASH } from '../constants';
import type { Address, Hex, Input, Quorum, Replica, ServerFrame, ServerState, TS } from '../types';
import { getAddrKey } from '../types';
import { applyCommand } from './entity';

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

const computeRoot = (replicas: Map<string, Replica>): Hex => {
	// sorted array for determinism
	const mapped = [...replicas.values()].map(r => ({ addr: r.address, state: r.last.state }));
	// eslint-disable-next-line fp/no-mutating-methods
	const sorted = [...mapped].sort((a, b) =>
		(a.addr.jurisdiction + a.addr.entityId).localeCompare(b.addr.jurisdiction + b.addr.entityId),
	);
	return `0x${Buffer.from(keccak(canonical(sorted))).toString('hex')}`;
};

// replace calculatePower(): real shares
const quorumPower = (q: Quorum, sigs: Map<Address, Hex>): bigint =>
	[...sigs.keys()].reduce((sum, addr) => sum + (q.members[addr]?.shares ?? 0n), 0n);

export function applyServerBlock({ prev, batch, timestamp }: ApplyServerBlockParams): ApplyServerBlockResult {
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
				const eKey = getAddrKey(baseReplica.address);
				const newReplicas = Object.keys(baseReplica.last.state.quorum.members).reduce((reps, signerAddr) => {
					const replicaCopy: Replica = {
						...structuredClone(baseReplica),
						proposer: signerAddr as Address,
					};
					return new Map(reps).set(`${eKey}:${signerAddr}`, replicaCopy);
				}, acc.finalReplicas);
				return { finalReplicas: newReplicas, allOutbox: acc.allOutbox };
			}

			const replica = acc.finalReplicas.get(key);
			if (!replica) return acc;

			/* ─── Apply the Entity state machine ─── */
			const updatedReplica = applyCommand({ replica, command });
			const updatedReplicas = new Map(acc.finalReplicas).set(key, updatedReplica);

			/* ─── Deterministic post-effects: generate follow-up commands if needed ─── */
			const newOutbox = (() => {
				switch (command.type) {
					case 'PROPOSE': {
						if (!replica.proposal && updatedReplica.proposal) {
							// Proposal just created: ask all signers (including proposer) to SIGN
							const proposal = updatedReplica.proposal;
							// Safety check: ensure proposal actually exists before accessing properties
							if (!proposal.hash) {
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
									frameHash: proposal.hash,
									sig: DUMMY_SIGNATURE,
								},
							}));
						}
						return [];
					}
					case 'SIGN': {
						if (updatedReplica.isAwaitingSignatures && updatedReplica.proposal) {
							const proposal = updatedReplica.proposal;
							const q = updatedReplica.last.state.quorum;
							const prevPower = replica.proposal ? quorumPower(q, replica.proposal.sigs) : 0n;
							const newPower = quorumPower(q, proposal.sigs);
							if (prevPower < q.threshold && newPower >= q.threshold) {
								// Threshold just reached: proposer will broadcast COMMIT
								// We need to send COMMIT to all replicas of this entity
								return Object.keys(updatedReplica.last.state.quorum.members).map(signerAddr => ({
									from: updatedReplica.proposer,
									to: signerAddr as Address,
									cmd: {
										type: 'COMMIT' as const,
										addrKey: command.addrKey,
										hanko: DUMMY_SIGNATURE,
										frame: {
											height: proposal.height,
											ts: proposal.ts,
											txs: proposal.txs,
											state: proposal.state,
										},
										signers: [], // Will be filled by runtime
										_sigs: Object.fromEntries(proposal.sigs), // Pass sigs separately for runtime
									},
								}));
							}
						}
						return [];
					}
					case 'ADD_TX': {
						return [];
					}
					case 'COMMIT':
						return [];
					default:
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

	const finalOutbox = [...allOutbox, ...proposeCommands];

	/* ─── After processing all inputs, build the ServerFrame for this tick ─── */
	const newHeight = prev.height + 1n;
	const rootHash = computeRoot(finalReplicas); // Merkle root of all Entity states after this tick
	const frame: ServerFrame = {
		height: newHeight,
		ts: timestamp,
		inputs: batch,
		root: rootHash,
		parent: prev.lastHash ?? EMPTY_HASH,
		hash: `0x${Buffer.from(
			keccak(
				encodeServerFrame({
					height: newHeight,
					ts: timestamp,
					inputs: batch,
					root: rootHash,
					parent: prev.lastHash ?? EMPTY_HASH,
					hash: DUMMY_SIGNATURE,
				}),
			),
		).toString('hex')}`,
	};

	return {
		state: { replicas: finalReplicas, height: newHeight, lastHash: frame.hash },
		frame,
		outbox: finalOutbox,
	};
}
