import { keccak_256 as keccak } from '@noble/hashes/sha3';
import { canonical, encodeServerFrame } from '../codec/rlp';
import { DUMMY_SIGNATURE, EMPTY_HASH } from '../constants';
import type { Address, Hex, Input, Replica, ServerFrame, ServerState, TS } from '../types';
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
	// sorted array for determinism - state root must be invariant across replicas
	const mapped = [...replicas.values()].map(r => ({ addr: r.address, state: r.last.state }));
	// eslint-disable-next-line fp/no-mutating-methods
	const sorted = [...mapped].sort((a, b) =>
		(a.addr.jurisdiction + a.addr.entityId).localeCompare(b.addr.jurisdiction + b.addr.entityId),
	);
	Object.freeze(sorted);
	return `0x${Buffer.from(keccak(canonical(sorted))).toString('hex')}`;
};

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

			const replica =
				acc.finalReplicas.get(key) ??
				// Fallback – derive by addrKey + proposer (don't trust input.to blindly)
				(() => {
					const anyRep = [...acc.finalReplicas.values()].find(r => getAddrKey(r.address) === command.addrKey);
					return anyRep ? acc.finalReplicas.get(`${command.addrKey}:${anyRep.proposer}`) : undefined;
				})();

			if (!replica) return acc;

			/* quick‑fail for obviously bad COMMIT height (saves costly re‑execution) */
			if (command.type === 'COMMIT' && command.frame.height !== replica.last.height + 1n) {
				console.error('COMMIT height mismatch');
				return acc;
			}

			/* ─── Apply the Entity state machine ─── */
			const { replica: updatedReplica, outbox: entityOutbox } = applyCommand({ replica, command });
			const updatedReplicas = new Map(acc.finalReplicas).set(key, updatedReplica);

			/* The entity layer now handles all consensus logic and generates necessary commands */

			return {
				finalReplicas: updatedReplicas,
				allOutbox: [...acc.allOutbox, ...entityOutbox],
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
