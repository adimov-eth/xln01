import { keccak_256 as keccak } from '@noble/hashes/sha3';
import { DUMMY_SIGNATURE } from '../constants';
import { type PubKey, verifyAggregate } from '../crypto/bls';
import type {
	Address,
	Command,
	EntityState,
	Frame,
	Hex,
	ProposedFrame,
	Quorum,
	Replica,
	Result,
	TS,
	Transaction,
} from '../types';
import { err, ok } from '../types';
import { ADDR_TO_PUB } from './runtime';

export interface ValidateCommitParams {
	frame: Frame<EntityState>;
	hanko: Hex;
	prev: Frame<EntityState>;
	signers: Address[];
}

export interface ApplyTxParams {
	state: EntityState;
	transaction: Transaction;
	timestamp: TS;
}

export interface ExecFrameParams {
	prev: Frame<EntityState>;
	transactions: Transaction[];
	timestamp: TS;
}

export interface ApplyCommandParams {
	replica: Replica;
	command: Command;
}

/** Compute canonical hash of a frame's content using keccak256. */
export const hashFrame = <T>(frame: Frame<T>): Hex => {
	const replacer = (_key: string, value: unknown) => (typeof value === 'bigint' ? value.toString() : value);
	return `0x${Buffer.from(keccak(JSON.stringify(frame, replacer))).toString('hex')}`;
};

const sortTransaction = (a: Transaction, b: Transaction): number =>
	a.nonce !== b.nonce ? Number(a.nonce - b.nonce) : a.from !== b.from ? a.from.localeCompare(b.from) : 0;

const getSharesOf = (address: Address, quorum: Quorum): bigint => quorum.members[address]?.shares ?? 0n;

type Validator<T> = (params: T) => Result<T>;

const checkHeight: Validator<ValidateCommitParams> = params =>
	params.frame.height === params.prev.height + 1n ? ok(params) : err('Height mismatch');

const checkStateReplay: Validator<ValidateCommitParams> = params => {
	const replayResult = execFrame({
		prev: params.prev,
		transactions: params.frame.txs,
		timestamp: params.frame.ts,
	});
	if (!replayResult.ok) return err('Failed to replay frame');

	const replayHash = hashFrame(replayResult.value);
	const frameHash = hashFrame(params.frame);
	return replayHash === frameHash ? ok(params) : err('State hash mismatch');
};

const checkSigningPower: Validator<ValidateCommitParams> = params => {
	const quorum = params.prev.state.quorum;
	const totalPower = params.signers.reduce<bigint>((sum, signer) => sum + getSharesOf(signer, quorum), 0n);
	return totalPower >= quorum.threshold ? ok(params) : err(`Insufficient power: ${totalPower} < ${quorum.threshold}`);
};

const checkSignatures: Validator<ValidateCommitParams> = params => {
	const pubKeys = params.signers.map(addr => ADDR_TO_PUB.get(addr)).filter((key): key is PubKey => key !== undefined);

	if (pubKeys.length !== params.signers.length) {
		return err('Missing public keys for some signers');
	}

	try {
		const isValid = verifyAggregate({
			hanko: params.hanko,
			messageHash: hashFrame(params.frame),
			publicKeys: pubKeys,
		});
		return isValid ? ok(params) : err('Invalid aggregate signature');
	} catch (e) {
		return err(`BLS verification error: ${String(e)}`);
	}
};

const compose =
	<T>(...validators: Validator<T>[]): Validator<T> =>
	params =>
		validators.reduce<Result<T>>((result, validator) => (result.ok ? validator(result.value) : result), ok(params));

/** Validate an incoming COMMIT frame against our current state */
const validateCommit = (params: ValidateCommitParams): boolean => {
	const validator = compose(checkHeight, checkStateReplay, checkSigningPower, checkSignatures);

	const result = validator(params);
	if (!result.ok) console.error(`Commit validation failed: ${result.error}`);
	return result.ok;
};

/** Apply a single chat transaction to the entity state (assuming nonce and membership are valid). */
export const applyTx = ({ state, transaction: tx, timestamp }: ApplyTxParams): Result<EntityState> => {
	if (tx.kind !== 'chat') return err('Unknown tx kind');

	const record = state.quorum.members[tx.from];
	if (!record) return err('Signer not in quorum');
	if (tx.nonce !== record.nonce) return err('Bad nonce');

	return ok({
		quorum: {
			...state.quorum,
			members: {
				...state.quorum.members,
				[tx.from]: { nonce: record.nonce + 1n, shares: record.shares },
			},
		},
		chat: [...state.chat, { from: tx.from, msg: tx.body.message, ts: timestamp }],
	});
};

/** Execute a batch of transactions on the previous frame's state to produce a new Frame. */
export const execFrame = ({ prev, transactions, timestamp }: ExecFrameParams): Result<Frame<EntityState>> => {
	// eslint-disable-next-line fp/no-mutating-methods
	const orderedTxs = [...transactions].sort(sortTransaction);

	const finalStateResult = orderedTxs.reduce<Result<EntityState>>(
		(stateResult, tx) =>
			stateResult.ok ? applyTx({ state: stateResult.value, transaction: tx, timestamp }) : stateResult,
		ok(prev.state),
	);

	return finalStateResult.ok
		? ok({
				height: prev.height + 1n,
				ts: timestamp,
				txs: orderedTxs,
				state: finalStateResult.value,
			})
		: finalStateResult;
};

type CommandHandler<T extends Command = Command> = (replica: Replica, command: T) => Replica;

const handleAddTx: CommandHandler = (replica, command) =>
	command.type === 'ADD_TX' ? { ...replica, mempool: [...replica.mempool, command.tx] } : replica;

const handlePropose: CommandHandler = (replica, command) => {
	if (command.type !== 'PROPOSE') return replica;

	if (replica.isAwaitingSignatures || replica.mempool.length === 0) {
		return replica;
	}

	const frameResult = execFrame({
		prev: replica.last,
		transactions: replica.mempool,
		timestamp: command.ts,
	});

	if (!frameResult.ok) {
		console.log(`PROPOSE failed: ${frameResult.error}`);
		return replica;
	}

	const frame = frameResult.value;
	const quorum = replica.last.state.quorum;
	const needsProposerSig = quorum.threshold === 1n && replica.proposer && quorum.members[replica.proposer];

	const proposal: ProposedFrame<EntityState> = {
		...frame,
		hash: hashFrame(frame),
		sigs:
			needsProposerSig && replica.proposer
				? new Map<Address, Hex>([[replica.proposer, DUMMY_SIGNATURE as Hex]])
				: new Map<Address, Hex>(),
	};

	return {
		...replica,
		mempool: [],
		isAwaitingSignatures: true,
		proposal,
	};
};

const handleSign: CommandHandler = (replica, command) => {
	if (command.type !== 'SIGN') return replica;

	const { proposal, isAwaitingSignatures, last } = replica;
	if (!isAwaitingSignatures || !proposal) return replica;

	const { frameHash, signer, sig } = command;
	if (frameHash !== proposal.hash) return replica;
	if (!last.state.quorum.members[signer]) return replica;
	if (proposal.sigs.has(signer)) return replica;

	return {
		...replica,
		proposal: {
			...proposal,
			sigs: new Map(proposal.sigs).set(signer, sig),
		},
	};
};

const handleCommit: CommandHandler = (replica, command) => {
	if (command.type !== 'COMMIT') return replica;

	const isValid = validateCommit({
		frame: command.frame,
		hanko: command.hanko,
		prev: replica.last,
		signers: command.signers,
	});

	if (!isValid) return replica;

	const newMempool = replica.mempool.filter(tx => !command.frame.txs.some(c => c.sig === tx.sig));

	return {
		...replica,
		last: command.frame,
		mempool: newMempool,
		isAwaitingSignatures: false,
		proposal: undefined,
	};
};

const commandHandlers: Record<Command['type'], CommandHandler> = {
	ADD_TX: handleAddTx,
	PROPOSE: handlePropose,
	SIGN: handleSign,
	COMMIT: handleCommit,
	IMPORT: replica => replica, // Handled at server level
};

/** Apply a high-level command to a replica's state. Returns a new Replica state (no mutation). */
export const applyCommand = ({ replica, command }: ApplyCommandParams): Replica => {
	const handler = commandHandlers[command.type];
	return handler ? handler(replica, command) : replica;
};
