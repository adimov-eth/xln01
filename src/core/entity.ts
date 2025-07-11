import { keccak_256 as keccak } from '@noble/hashes/sha3';
import { canonical } from '../codec/rlp';
import { DUMMY_SIGNATURE } from '../constants';
import { type PubKey, verifyAggregate } from '../crypto/bls';
import type {
	Address,
	Command,
	EntityState,
	Frame,
	Hex,
	Input,
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

export interface ApplyCommandResult {
	replica: Replica;
	outbox: Input[];
}

export const calculateQuorumPower = (quorum: Quorum, signers: Address[] | Map<Address, Hex>): bigint => {
	const addresses = Array.isArray(signers) ? signers : [...signers.keys()];
	return addresses.reduce((sum, addr) => sum + (quorum.members[addr]?.shares ?? 0n), 0n);
};

/** Compute canonical hash of a frame's content using keccak256. */
export const hashFrame = <T>(frame: Frame<T>): Hex => {
	return `0x${Buffer.from(keccak(canonical(frame))).toString('hex')}`;
};

const sortTransaction = (a: Transaction, b: Transaction): number =>
	a.nonce < b.nonce ? -1 : a.nonce > b.nonce ? 1 : a.from.localeCompare(b.from);

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
	const uniqueSigners = [...new Set(params.signers)];
	const totalPower = calculateQuorumPower(quorum, uniqueSigners);
	return totalPower >= quorum.threshold ? ok(params) : err(`Insufficient power: ${totalPower} < ${quorum.threshold}`);
};

const checkSignatures: Validator<ValidateCommitParams> = params => {
	const uniqueSigners = [...new Set(params.signers)];
	const pubKeys = uniqueSigners.map(addr => ADDR_TO_PUB.get(addr)).filter((key): key is PubKey => key !== undefined);

	if (pubKeys.length !== uniqueSigners.length) {
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

type CommandHandler<T extends Command = Command> = (replica: Replica, command: T) => ApplyCommandResult;

const handleAddTx: CommandHandler = (replica, command) => {
	if (command.type !== 'ADD_TX') return { replica, outbox: [] };
	if (replica.mempool.some(t => t.sig === command.tx.sig)) return { replica, outbox: [] };
	return { replica: { ...replica, mempool: [...replica.mempool, command.tx] }, outbox: [] };
};

const handlePropose: CommandHandler = (replica, command) => {
	if (command.type !== 'PROPOSE') return { replica, outbox: [] };

	if (replica.isAwaitingSignatures || replica.mempool.length === 0) {
		return { replica, outbox: [] };
	}

	const frameResult = execFrame({
		prev: replica.last,
		transactions: replica.mempool,
		timestamp: command.ts,
	});

	if (!frameResult.ok) {
		console.log(`PROPOSE failed: ${frameResult.error}`);
		return { replica, outbox: [] };
	}

	const frame = frameResult.value;
	const quorum = replica.last.state.quorum;
	const needsProposerSig = quorum.threshold === 1n && replica.proposer && quorum.members[replica.proposer];

	const proposal: ProposedFrame<EntityState> = {
		...frame,
		hash: hashFrame(frame),
		sigs:
			needsProposerSig && replica.proposer
				? new Map<Address, Hex>([[replica.proposer, DUMMY_SIGNATURE]])
				: new Map<Address, Hex>(),
	};

	const updatedReplica = {
		...replica,
		mempool: [],
		isAwaitingSignatures: true,
		proposal,
	};

	// Generate SIGN requests for all quorum members
	const outbox: Input[] = Object.keys(quorum.members).map(s => ({
		from: s as Address,
		to: replica.proposer,
		cmd: {
			type: 'SIGN' as const,
			addrKey: command.addrKey,
			signer: s as Address,
			frameHash: proposal.hash,
			sig: DUMMY_SIGNATURE,
		},
	}));

	return { replica: updatedReplica, outbox };
};

const handleSign: CommandHandler = (replica, command) => {
	if (command.type !== 'SIGN') return { replica, outbox: [] };

	const { proposal, isAwaitingSignatures, last } = replica;
	if (!isAwaitingSignatures || !proposal) return { replica, outbox: [] };

	const { frameHash, signer, sig } = command;
	if (frameHash !== proposal.hash) return { replica, outbox: [] };
	if (!last.state.quorum.members[signer]) return { replica, outbox: [] };
	if (proposal.sigs.has(signer)) return { replica, outbox: [] };

	const updatedProposal = {
		...proposal,
		sigs: new Map(proposal.sigs).set(signer, sig),
	};

	const updatedReplica = {
		...replica,
		proposal: updatedProposal,
	};

	// Check if threshold is reached
	const quorum = last.state.quorum;
	const prevPower = calculateQuorumPower(quorum, proposal.sigs);
	const newPower = calculateQuorumPower(quorum, updatedProposal.sigs);

	if (prevPower < quorum.threshold && newPower >= quorum.threshold) {
		// Threshold reached: generate COMMIT commands for all replicas
		const outbox: Input[] = Object.keys(quorum.members).map(signerAddr => ({
			from: replica.proposer,
			to: signerAddr as Address,
			cmd: {
				type: 'COMMIT' as const,
				addrKey: command.addrKey,
				hanko: DUMMY_SIGNATURE,
				frame: {
					height: updatedProposal.height,
					ts: updatedProposal.ts,
					txs: updatedProposal.txs,
					state: updatedProposal.state,
				},
				signers: [],
				_sigs: Object.fromEntries(updatedProposal.sigs),
			},
		}));
		return { replica: updatedReplica, outbox };
	}

	return { replica: updatedReplica, outbox: [] };
};

const handleCommit: CommandHandler = (replica, command) => {
	if (command.type !== 'COMMIT') return { replica, outbox: [] };

	const isValid = validateCommit({
		frame: command.frame,
		hanko: command.hanko,
		prev: replica.last,
		signers: command.signers,
	});

	if (!isValid) return { replica, outbox: [] };

	const newMempool = replica.mempool.filter(tx => !command.frame.txs.some(c => c.sig === tx.sig));

	return {
		replica: {
			...replica,
			last: command.frame,
			mempool: newMempool,
			isAwaitingSignatures: false,
			proposal: undefined,
		},
		outbox: [],
	};
};

const commandHandlers: Record<Command['type'], CommandHandler> = {
	ADD_TX: handleAddTx,
	PROPOSE: handlePropose,
	SIGN: handleSign,
	COMMIT: handleCommit,
	IMPORT: replica => ({ replica, outbox: [] }), // Handled at server level
};

/** Apply a high-level command to a replica's state. Returns a new Replica state and outbox (no mutation). */
// TODO: rename to applyEntityInput or similar for clarity
export const applyCommand = ({ replica, command }: ApplyCommandParams): ApplyCommandResult => {
	const handler = commandHandlers[command.type];
	return handler ? handler(replica, command) : { replica, outbox: [] };
};
