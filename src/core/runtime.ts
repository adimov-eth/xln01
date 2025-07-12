import {
	BLS_SIGNATURE_LENGTH,
	DUMMY_SIGNATURE,
	EMPTY_HASH,
	HASH_DISPLAY_LENGTH,
	INITIAL_HEIGHT,
	TOTAL_SIGNERS,
} from '../constants';
import { type PubKey, aggregate, deriveAddress, getPublicKey, randomPriv, sign } from '../crypto/bls';
import type { Address, Hex, Input, Replica, ServerFrame, ServerState } from '../types';
import { applyServerBlock } from './server';
import type { WAL } from '../infra/wal';

const generateSigners = (count: number) => {
	const privs = Array.from({ length: count }, randomPriv);
	const pubs = privs.map(getPublicKey);
	const addrs = pubs.map(deriveAddress);
	const privHexes = privs.map(priv => `0x${Buffer.from(priv).toString('hex')}`) as readonly Hex[];

	return { privs, pubs, addrs, privHexes };
};

const { privs: PRIVS, pubs: PUBS, addrs: ADDRS, privHexes: PRIV_HEXES } = generateSigners(TOTAL_SIGNERS);

export const ADDR_TO_PUB = new Map<string, PubKey>(ADDRS.map((addr, i) => [addr, PUBS[i]]));

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
	tickAsync(params: TickParams): Promise<TickResult>;
}

export interface RuntimeOptions {
	wal?: WAL;
	initialState?: ServerState;
}

export const createRuntime = (options: RuntimeOptions = {}): Runtime => {
	const { wal, initialState } = options;

	const initialReplicas = initialState?.replicas ?? new Map<string, Replica>();

	// TODO: there is no need in "current". "lastHash" can be replaced with timestamp
	const stateRef = {
		current: initialState ?? {
			replicas: initialReplicas,
			height: INITIAL_HEIGHT,
			lastHash: EMPTY_HASH,
		},
	};

	const debugReplicas = (): Map<string, Replica> => {
		return new Map(stateRef.current.replicas);
	};

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
		// Append inputs to WAL before processing
		if (wal && incoming.length > 0) {
			// Fire and forget - we don't await to avoid blocking
			void wal.appendInputBatch(incoming);
		}

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

		// Append frame to WAL after processing
		if (wal) {
			// Fire and forget - we don't await to avoid blocking
			void wal.appendServerFrame(frame);
		}

		// eslint-disable-next-line functional/immutable-data, fp/no-mutation
		stateRef.current = nextState;
		return { outbox: fulfilledOutbox, frame };
	};

	const tickAsync = async (params: TickParams): Promise<TickResult> => {
		const { now, incoming } = params;

		// Append inputs to WAL before processing
		if (wal && incoming.length > 0) {
			await wal.appendInputBatch(incoming);
		}

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

		// Append frame to WAL after processing
		if (wal) {
			await wal.appendServerFrame(frame);
		}

		// eslint-disable-next-line functional/immutable-data, fp/no-mutation
		stateRef.current = nextState;
		return { outbox: fulfilledOutbox, frame };
	};

	return {
		ADDRS,
		PRIVS: PRIV_HEXES,
		debugReplicas,
		tick,
		tickAsync,
	};
};
