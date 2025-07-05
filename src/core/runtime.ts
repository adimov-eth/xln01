import { applyServerBlock } from './server';
import { sign, aggregate, randomPriv, getPublicKey, deriveAddress, PubKey } from '../crypto/bls';
import { Input, Replica, Frame, EntityState, Quorum, Hex, Address, ServerFrame } from '../types';
import {
	TOTAL_SIGNERS,
	QUORUM_THRESHOLD,
	DEFAULT_SHARES_PER_SIGNER,
	DEMO_JURISDICTION,
	DEMO_ENTITY_ID,
	INITIAL_HEIGHT,
	DUMMY_SIGNATURE,
	BLS_SIGNATURE_LENGTH,
	HEX_PREFIX_LENGTH,
	HASH_DISPLAY_LENGTH,
} from '../constants';

/* ──────────── Deterministic demo key generation (5 signers) ──────────── */
const PRIVS = Array.from({ length: TOTAL_SIGNERS }, () => randomPriv());
const PUBS = PRIVS.map(privateKey => getPublicKey({ privateKey }));
const ADDRS = PUBS.map(publicKey => deriveAddress({ publicKey }));

// Create a mapping from address to public key for signature verification
export const ADDR_TO_PUB = new Map<string, PubKey>(ADDRS.map((addr, i) => [addr, PUBS[i]]));

/* ──────────── Bootstrap an initial Replica (genesis state) ──────────── */
const genesisEntity = (): Replica => {
	const quorum: Quorum = {
		threshold: QUORUM_THRESHOLD,
		members: Object.fromEntries(
			ADDRS.map(address => [address, { nonce: INITIAL_HEIGHT, shares: DEFAULT_SHARES_PER_SIGNER }]),
		),
	};
	const initState: EntityState = { quorum, chat: [] };
	const initFrame: Frame<EntityState> = { height: INITIAL_HEIGHT, ts: 0, txs: [], state: initState };
	return {
		address: { jurisdiction: DEMO_JURISDICTION, entityId: DEMO_ENTITY_ID },
		proposer: ADDRS[0], // Fixed proposer: always the first signer
		isAwaitingSignatures: false,
		mempool: [],
		last: initFrame,
		// proposal: undefined (implicitly)
	};
};

export interface TickParams {
	now: number;
	incoming: Input[];
}

export interface TickResult {
	outbox: Input[];
	frame: ServerFrame;
}

export interface Runtime {
	readonly ADDRS: readonly string[];
	readonly PRIVS: readonly Hex[];
	debugReplicas(): Map<string, Replica>;
	tick(params: TickParams): TickResult;
}

export const createRuntime = (): Runtime => {
	// Initialize state with replicas for each signer
	const base = genesisEntity();
	// Fixed proposer: always use the first signer as the proposer
	const fixedProposer = ADDRS[0];
	const initialReplicas = new Map(
		ADDRS.map(signerAddr => [`demo:chat:${signerAddr}`, { ...base, proposer: fixedProposer } as Replica]),
	);

	// Use closure to encapsulate state using a functional pattern
	const stateRef = {
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
	const tick = ({ now, incoming }: TickParams): TickResult => {
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
		const fulfilledOutbox = outbox.map(message => {
			if (message.cmd.type === 'SIGN' && message.cmd.sig === DUMMY_SIGNATURE) {
				// Sign the frame hash with the signer's private key
				const signerIndex = ADDRS.findIndex(address => address === message.cmd.signer);
				const signature = sign({
					message: Buffer.from(message.cmd.frameHash.slice(HEX_PREFIX_LENGTH), 'hex'),
					privateKey: PRIVS[signerIndex],
				});
				return {
					...message,
					cmd: { ...message.cmd, sig: signature },
				};
			}
			if (message.cmd.type === 'COMMIT' && message.cmd.hanko === DUMMY_SIGNATURE) {
				// Aggregate all collected signatures into one Hanko
				const commandWithSignatures = message.cmd as typeof message.cmd & {
					_sigs?: Map<Address, Hex> | Record<string, Hex>;
				};
				const signatures = commandWithSignatures._sigs;

				// Handle both Map and object representations
				const realSignatures: Hex[] =
					signatures instanceof Map
						? [...signatures.values()].filter(sig => sig !== DUMMY_SIGNATURE)
						: signatures && typeof signatures === 'object'
							? Object.values(signatures).filter(
									(sig): sig is Hex => typeof sig === 'string' && sig !== DUMMY_SIGNATURE,
								)
							: [];

				if (realSignatures.length > 0) {
					// Get the list of signers who actually signed
					const signers: Address[] =
						signatures instanceof Map
							? [...signatures.entries()].filter(([, sig]) => sig !== DUMMY_SIGNATURE).map(([address]) => address)
							: Object.entries(signatures)
									.filter(([, sig]) => sig !== DUMMY_SIGNATURE)
									.map(([address]) => address as Address);

					const hanko = aggregate({ signatures: realSignatures });

					// Create new command without _sigs field
					// eslint-disable-next-line @typescript-eslint/no-unused-vars
					const { _sigs, ...commandWithoutSignatures } = commandWithSignatures;
					return {
						...message,
						cmd: { ...commandWithoutSignatures, hanko, signers },
					};
				} else {
					// This should not happen in normal operation
					console.error('WARNING: No signatures found for aggregation');
					const hanko = ('0x' + '00'.repeat(BLS_SIGNATURE_LENGTH)) as Hex;
					// eslint-disable-next-line @typescript-eslint/no-unused-vars
					const { _sigs, ...commandWithoutSignatures } = commandWithSignatures;
					return {
						...message,
						cmd: { ...commandWithoutSignatures, hanko, signers: [] },
					};
				}
			}
			return message;
		});

		// Step 3: (Placeholder for actual networking/persistence)
		// For now, just log the ServerFrame and update state.
		console.log(
			`Committed ServerFrame #${frame.height.toString()} – hash: ${frame.hash.slice(0, HASH_DISPLAY_LENGTH)}... root: ${frame.root.slice(0, HASH_DISPLAY_LENGTH)}...`,
		);

		// In a real node, here we would:
		// - Append `frame` to WAL (with fsync)
		// - Possibly take a snapshot of state or prune WAL
		// - Broadcast the outbox messages over network to respective peers

		// Update the in-memory server state for next tick
		// eslint-disable-next-line functional/immutable-data, fp/no-mutation
		stateRef.current = nextState;
		// Return outbox and frame for further processing or inspection
		return { outbox: fulfilledOutbox, frame };
	};

	return {
		ADDRS,
		PRIVS,
		debugReplicas,
		tick,
	};
};
