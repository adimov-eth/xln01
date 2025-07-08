import {
	BLS_SIGNATURE_LENGTH,
	DEFAULT_SHARES_PER_SIGNER,
	DEMO_ENTITY_ID,
	DEMO_JURISDICTION,
	DUMMY_SIGNATURE,
	EMPTY_HASH,
	HASH_DISPLAY_LENGTH,
	INITIAL_HEIGHT,
	QUORUM_THRESHOLD,
	TOTAL_SIGNERS,
} from '../constants';
import { type PubKey, aggregate, deriveAddress, getPublicKey, randomPriv, sign } from '../crypto/bls';
import type { Address, EntityState, Frame, Hex, Input, Quorum, Replica, ServerFrame } from '../types';
import { applyServerBlock } from './server';

// Generate signers with derived keys and addresses
const generateSigners = (count: number) => {
	const privs = Array.from({ length: count }, randomPriv);
	const pubs = privs.map(getPublicKey);
	const addrs = pubs.map(deriveAddress);
	const privHexes = privs.map(priv => `0x${Buffer.from(priv).toString('hex')}`) as readonly Hex[];

	return { privs, pubs, addrs, privHexes };
};

const { privs: PRIVS, pubs: PUBS, addrs: ADDRS, privHexes: PRIV_HEXES } = generateSigners(TOTAL_SIGNERS);

export const ADDR_TO_PUB = new Map<string, PubKey>(ADDRS.map((addr, i) => [addr, PUBS[i]]));

// Create a member with default values
const genesisEntity = (): Replica => {
	const members = ADDRS.reduce<Record<Address, { nonce: bigint; shares: bigint }>>(
		(acc, addr) => ({
			...acc,
			[addr]: { nonce: INITIAL_HEIGHT, shares: BigInt(DEFAULT_SHARES_PER_SIGNER) },
		}),
		{},
	);

	const quorum: Quorum = {
		threshold: BigInt(QUORUM_THRESHOLD),
		members,
	};

	const initState: EntityState = { quorum, chat: [] };
	const initFrame: Frame<EntityState> = {
		height: INITIAL_HEIGHT,
		ts: 0,
		txs: [],
		state: initState,
	};

	return {
		address: { jurisdiction: DEMO_JURISDICTION, entityId: DEMO_ENTITY_ID },
		proposer: ADDRS[0],
		isAwaitingSignatures: false,
		mempool: [],
		last: initFrame,
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
	const base = genesisEntity();
	const fixedProposer = ADDRS[0];
	const initialReplicas = new Map(
		ADDRS.map(signerAddr => [`demo:chat:${signerAddr}`, { ...base, proposer: fixedProposer } as Replica]),
	);

	const stateRef = {
		current: {
			replicas: initialReplicas,
			height: INITIAL_HEIGHT,
			lastHash: EMPTY_HASH,
		},
	};

	const debugReplicas = (): Map<string, Replica> => {
		return new Map(stateRef.current.replicas);
	};

	// Helper functions for signature processing
	const extractSignatures = (sigs: Map<Address, Hex> | Record<string, Hex> | undefined): [Hex[], Address[]] => {
		if (!sigs) return [[], []];

		const entries =
			sigs instanceof Map ? [...sigs.entries()] : Object.entries(sigs).map(([addr, sig]) => [addr as Address, sig]);

		const valid = entries.filter(([, sig]) => sig !== DUMMY_SIGNATURE);
		return [valid.map(([, sig]) => sig), valid.map(([addr]) => addr)];
	};

	const createEmptyHanko = (): Hex => ('0x' + '00'.repeat(BLS_SIGNATURE_LENGTH)) as Hex;

	const fulfillSignature = (message: Input): Input => {
		const { cmd } = message;

		if (cmd.type === 'SIGN' && cmd.sig === DUMMY_SIGNATURE) {
			const signerIndex = ADDRS.findIndex(addr => addr === cmd.signer);
			const signature = sign({
				message: Buffer.from(cmd.frameHash.slice(2), 'hex'),
				privateKey: PRIVS[signerIndex],
			});
			return { ...message, cmd: { ...cmd, sig: signature } };
		}

		if (cmd.type === 'COMMIT' && cmd.hanko === DUMMY_SIGNATURE) {
			const cmdWithSigs = cmd as typeof cmd & { _sigs?: Map<Address, Hex> | Record<string, Hex> };
			const [signatures, signers] = extractSignatures(cmdWithSigs._sigs);

			if (signatures.length === 0) {
				console.error('WARNING: No signatures found for aggregation');
			}

			const hanko = signatures.length > 0 ? aggregate(signatures) : createEmptyHanko();
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			const { _sigs, ...cleanCmd } = cmdWithSigs;

			return { ...message, cmd: { ...cleanCmd, hanko, signers } };
		}

		return message;
	};

	const tick = ({ now, incoming }: TickParams): TickResult => {
		const {
			state: nextState,
			frame,
			outbox,
		} = applyServerBlock({
			prev: stateRef.current,
			batch: incoming,
			timestamp: now,
		});

		const fulfilledOutbox = outbox.map(fulfillSignature);

		console.log(
			`Committed ServerFrame #${frame.height.toString()} – hash: ${frame.hash.slice(0, HASH_DISPLAY_LENGTH)}... root: ${frame.root.slice(0, HASH_DISPLAY_LENGTH)}...`,
		);

		// eslint-disable-next-line functional/immutable-data, fp/no-mutation
		stateRef.current = nextState;
		return { outbox: fulfilledOutbox, frame };
	};

	return {
		ADDRS,
		PRIVS: PRIV_HEXES,
		debugReplicas,
		tick,
	};
};
