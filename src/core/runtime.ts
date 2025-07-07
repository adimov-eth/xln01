import {
	BLS_SIGNATURE_LENGTH,
	DEFAULT_SHARES_PER_SIGNER,
	DEMO_ENTITY_ID,
	DEMO_JURISDICTION,
	DUMMY_SIGNATURE,
	HASH_DISPLAY_LENGTH,
	INITIAL_HEIGHT,
	QUORUM_THRESHOLD,
	TOTAL_SIGNERS,
} from '../constants';
import { type PubKey, aggregate, deriveAddress, getPublicKey, randomPriv, sign } from '../crypto/bls';
import type { Address, EntityState, Frame, Hex, Input, Quorum, Replica, ServerFrame } from '../types';
import { applyServerBlock } from './server';

const PRIVS = Array.from({ length: TOTAL_SIGNERS }, () => randomPriv());
const PUBS = PRIVS.map(privateKey => getPublicKey(privateKey));
const ADDRS = PUBS.map(publicKey => deriveAddress(publicKey));
const PRIV_HEXES = PRIVS.map(priv => `0x${Buffer.from(priv).toString('hex')}`) as readonly Hex[];

export const ADDR_TO_PUB = new Map<string, PubKey>(ADDRS.map((addr, i) => [addr, PUBS[i]]));

const genesisEntity = (): Replica => {
	const quorum: Quorum = {
		threshold: BigInt(QUORUM_THRESHOLD),
		members: Object.fromEntries(
			ADDRS.map(address => [address, { nonce: INITIAL_HEIGHT, shares: BigInt(DEFAULT_SHARES_PER_SIGNER) }]),
		),
	};
	const initState: EntityState = { quorum, chat: [] };
	const initFrame: Frame<EntityState> = { height: INITIAL_HEIGHT, ts: 0, txs: [], state: initState };
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
		},
	};

	const debugReplicas = (): Map<string, Replica> => {
		return new Map(stateRef.current.replicas);
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

		const fulfilledOutbox = outbox.map(message => {
			if (message.cmd.type === 'SIGN' && message.cmd.sig === DUMMY_SIGNATURE) {
				const signCmd = message.cmd;
				const signerIndex = ADDRS.findIndex(address => address === signCmd.signer);
				const signature = sign({
					message: Buffer.from(signCmd.frameHash.slice(2), 'hex'),
					privateKey: PRIVS[signerIndex],
				});
				return {
					...message,
					cmd: { ...message.cmd, sig: signature },
				};
			}
			if (message.cmd.type === 'COMMIT' && message.cmd.hanko === DUMMY_SIGNATURE) {
				const commandWithSignatures = message.cmd as typeof message.cmd & {
					_sigs?: Map<Address, Hex> | Record<string, Hex>;
				};
				const signatures = commandWithSignatures._sigs;

				const realSignatures: Hex[] =
					signatures instanceof Map
						? [...signatures.values()].filter(sig => sig !== DUMMY_SIGNATURE)
						: signatures && typeof signatures === 'object'
							? Object.values(signatures).filter(
									(sig): sig is Hex => typeof sig === 'string' && sig !== DUMMY_SIGNATURE,
								)
							: [];

				if (realSignatures.length > 0) {
					const signers: Address[] =
						signatures instanceof Map
							? [...signatures.entries()].filter(([, sig]) => sig !== DUMMY_SIGNATURE).map(([address]) => address)
							: signatures
								? Object.entries(signatures)
										.filter(([, sig]) => sig !== DUMMY_SIGNATURE)
										.map(([address]) => address as Address)
								: [];

					const hanko = aggregate(realSignatures);

					// eslint-disable-next-line @typescript-eslint/no-unused-vars
					const { _sigs, ...commandWithoutSignatures } = commandWithSignatures;
					return {
						...message,
						cmd: { ...commandWithoutSignatures, hanko, signers },
					};
				} else {
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
