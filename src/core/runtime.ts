import {
	BLS_SIGNATURE_LENGTH,
	DEFAULT_SHARES_PER_SIGNER,
	DEMO_ENTITY_ID,
	DEMO_JURISDICTION,
	DUMMY_SIGNATURE,
	INITIAL_HEIGHT,
	QUORUM_THRESHOLD,
	TOTAL_SIGNERS,
} from '../constants';
import type { PubKey } from '../crypto/bls';
import { addr, aggregate, pub, randomPriv, sign } from '../crypto/bls';
import type { Address, EntityState, Frame, Hex, Input, Quorum, Replica } from '../types';
import { applyServerBlock } from './server';

/* ──────────── Deterministic demo key generation (5 signers) ──────────── */
const PRIVS = Array.from({ length: TOTAL_SIGNERS }, () => randomPriv());
const PUBS = PRIVS.map(pub);
const ADDRS = PUBS.map(addr);
// Convert private keys to hex format for the Runtime interface
const PRIV_HEXES = PRIVS.map(priv => `0x${Buffer.from(priv).toString('hex')}`) as readonly Hex[];

// Create a mapping from address to public key for signature verification
export const ADDR_TO_PUB = new Map<string, PubKey>(ADDRS.map((addr, i) => [addr, PUBS[i]]));

/* ──────────── Bootstrap an initial Replica (genesis state) ──────────── */
const genesisEntity = (): Replica => {
	const quorum: Quorum = {
		threshold: QUORUM_THRESHOLD,
		members: Object.fromEntries(ADDRS.map(a => [a, { nonce: INITIAL_HEIGHT, shares: DEFAULT_SHARES_PER_SIGNER }])),
	};
	const initState: EntityState = { quorum, chat: [] };
	const initFrame: Frame<EntityState> = { height: INITIAL_HEIGHT, ts: 0, txs: [], state: initState };
	return {
		address: { jurisdiction: DEMO_JURISDICTION, entityId: DEMO_ENTITY_ID },
		proposer: ADDRS[0], // initial proposer (could be rotated later)
		isAwaitingSignatures: false,
		mempool: [],
		last: initFrame,
		// proposal: undefined (implicitly)
	};
};

export interface Runtime {
	readonly ADDRS: readonly string[];
	readonly PRIVS: readonly Hex[];
	debugReplicas(): Map<string, Replica>;
	tick(now: number, incoming: Input[]): Promise<{ outbox: Input[]; frame: import('../types').ServerFrame }>;
}

export const createRuntime = (): Runtime => {
	// Initialize state with replicas for each signer
	const base = genesisEntity();
	const initialReplicas = new Map(
		ADDRS.map(signerAddr => [`demo:chat:${signerAddr}`, { ...base, proposer: signerAddr } as Replica]),
	);

	// Use closure to encapsulate state management
	// eslint-disable-next-line
	let stateRef = {
		current: {
			replicas: initialReplicas,
			height: INITIAL_HEIGHT,
		},
	};

	/** Debug helper: returns all replicas for inspection */
	const debugReplicas = (): Map<string, Replica> => {
		return new Map(stateRef.current.replicas);
	};

	/** Drive one 100ms tick of the server. Provide current time and any incoming Inputs. */
	const tick = async (now: number, incoming: Input[]) => {
		// Step 1: apply the pure server logic to get the next state and ServerFrame
		const {
			state: nextState,
			frame,
			outbox,
		} = applyServerBlock({
			prev: stateRef.current,
			batch: incoming,
			timestamp: now,
		});

		// Step 2: fulfill signature placeholders in outbox (where private keys are used)
		const fulfilledOutbox = await Promise.all(
			outbox.map(msg => {
				if (msg.cmd.type === 'SIGN' && msg.cmd.sig === DUMMY_SIGNATURE) {
					// Type guard to ensure we have a SIGN command
					const signCmd = msg.cmd;
					// Sign the frame hash with the signer's private key
					const signerIndex = ADDRS.findIndex(a => a === signCmd.signer);
					const signature = sign(Buffer.from(msg.cmd.frameHash.slice(2), 'hex'), PRIVS[signerIndex]);
					return {
						...msg,
						cmd: { ...msg.cmd, sig: signature } as typeof msg.cmd,
					};
				}
				if (msg.cmd.type === 'COMMIT' && msg.cmd.hanko === DUMMY_SIGNATURE) {
					// Aggregate all collected signatures into one Hanko
					const cmdWithSigs = msg.cmd as typeof msg.cmd & { _sigs?: Map<Address, Hex> | Record<string, Hex> };
					const sigs = cmdWithSigs._sigs;

					// Handle both Map and object representations
					const realSigs: Hex[] =
						sigs instanceof Map
							? [...sigs.values()].filter(sig => sig !== DUMMY_SIGNATURE)
							: sigs && typeof sigs === 'object'
								? Object.values(sigs).filter((sig): sig is Hex => sig !== DUMMY_SIGNATURE)
								: [];

					if (realSigs.length > 0) {
						// Get the list of signers who actually signed
						const signers: Address[] =
							sigs instanceof Map
								? [...sigs.entries()].filter(([, sig]) => sig !== DUMMY_SIGNATURE).map(([addr]) => addr)
								: sigs
									? Object.entries(sigs)
											.filter(([, sig]) => sig !== DUMMY_SIGNATURE)
											.map(([addr]) => addr as Address)
									: [];

						const hanko = aggregate(realSigs);

						// Create new command without _sigs field
						const { _sigs, ...cmdWithoutSigs } = cmdWithSigs;
						void _sigs; // Mark as intentionally unused
						return {
							...msg,
							cmd: { ...cmdWithoutSigs, hanko, signers },
						} as Input;
					}
					// This should not happen in normal operation
					console.error('WARNING: No signatures found for aggregation');
					const hanko = `0x${'00'.repeat(BLS_SIGNATURE_LENGTH)}`;
					const { _sigs, ...cmdWithoutSigs } = cmdWithSigs;
					void _sigs; // Mark as intentionally unused
					return {
						...msg,
						cmd: { ...cmdWithoutSigs, hanko, signers: [] },
					} as Input;
				}
				return msg;
			}),
		);

		// Step 3: (Placeholder for actual networking/persistence)
		// For now, just log the ServerFrame and update state.
		console.log(
			`Committed ServerFrame #${frame.height.toString()} – hash: ${frame.hash.slice(0, 10)}... root: ${frame.root.slice(0, 10)}...`,
		);

		// In a real node, here we would:
		// - Append `frame` to WAL (with fsync)
		// - Possibly take a snapshot of state or prune WAL
		// - Broadcast the outbox messages over network to respective peers

		// Update the in-memory server state for next tick
		// eslint-disable-next-line fp/no-mutation
		stateRef = { current: nextState };
		// Return outbox and frame for further processing or inspection
		return { outbox: fulfilledOutbox, frame };
	};

	return {
		ADDRS,
		PRIVS: PRIV_HEXES,
		debugReplicas,
		tick,
	};
};
