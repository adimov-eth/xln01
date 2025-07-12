import { keccak_256 as keccak } from '@noble/hashes/sha3';
import { encodeServerFrame } from '../codec/rlp';
import { DUMMY_SIGNATURE, EMPTY_HASH } from '../constants';
import type { Address, Hex, Input, Replica, ServerFrame, ServerState, TS, Quorum } from '../types';
import { getAddrKey } from '../types';
import { applyCommand } from './entity';
import { hashQuorum, computeStateRoot } from './codec';
import { proposerFor, hasProposalTimedOut } from './proposer';

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

	// Compute state root for each entity using RLP
	const stateRoots = sorted.map(({ state }) => computeStateRoot(state));

	// Combine all state roots into a single merkle root
	return `0x${Buffer.from(keccak(Buffer.concat(stateRoots.map(h => Buffer.from(h.slice(2), 'hex'))))).toString('hex')}`;
};

export function applyServerBlock({ prev, batch, timestamp }: ApplyServerBlockParams): ApplyServerBlockResult {
	const { finalReplicas, allOutbox } = batch.reduce(
		(acc, input) => {
			const { cmd: command } = input;
			/* Determine routing key.
			   If the command is entity-specific, route to the Replica that should handle it.
			   We use addrKey (jurisdiction:entity) plus signer's address for uniqueness when needed. */
			const signerPart = (() => {
				switch (command.type) {
					case 'ADD_TX':
					case 'SIGN':
					case 'COMMIT':
						return input.to;
					case 'PROPOSE':
						return input.from;
					case 'IMPORT':
						return '';
				}
			})();

			const key = command.type === 'IMPORT' ? '' : command.addrKey + (signerPart ? ':' + signerPart : '');

			/* ─── IMPORT command (bootstrap a new Entity into server state) ─── */
			// TODO: doublecheck case for distributed Network
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
	// Group replicas by entity
	const entitiesByKey = [...finalReplicas.entries()].reduce((acc, [key, replica]) => {
		const entityKey = getAddrKey(replica.address);
		const existing = acc.get(entityKey) ?? {
			replicas: new Map(),
			quorum: replica.last.state.quorum,
		};
		return new Map(acc).set(entityKey, {
			...existing,
			replicas: new Map(existing.replicas).set(key, replica) as Map<string, Replica>,
		});
	}, new Map<string, { replicas: Map<string, Replica>; quorum: Quorum }>());

	// Generate PROPOSE commands for eligible entities
	const proposeCommands = [...entitiesByKey.entries()].reduce<Input[]>(
		(commands, [entityKey, { replicas, quorum }]) => {
			// Get quorum members
			const members = Object.keys(quorum.members) as Address[];
			if (members.length === 0) return commands;

			// Determine current proposer based on height
			const currentProposer = proposerFor(prev.height + 1n, members);

			// Find the replica for current proposer
			const proposerReplica = [...replicas.values()].find(r => r.proposer === currentProposer);
			if (!proposerReplica) return commands;

			// Check if entity should propose
			const shouldPropose = !proposerReplica.isAwaitingSignatures && proposerReplica.mempool.length > 0;

			// Check if there's an existing proposal that has timed out
			const hasTimedOut =
				proposerReplica.proposal && proposerReplica.proposal.proposalTs
					? hasProposalTimedOut(proposerReplica.proposal.proposalTs, timestamp, prev.height + 1n)
					: false;

			if (shouldPropose || hasTimedOut) {
				return [
					...commands,
					{
						from: currentProposer,
						to: currentProposer,
						cmd: {
							type: 'PROPOSE' as const,
							addrKey: entityKey,
							ts: timestamp,
							quorumHash: hashQuorum(quorum),
						},
					},
				];
			}
			return commands;
		},
		[],
	);

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
