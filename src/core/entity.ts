import {
	Replica,
	Command,
	EntityState,
	Frame,
	Transaction,
	Quorum,
	ProposedFrame,
	Address,
	Hex,
	TS,
	Result,
	ok,
	err,
} from '../types';
import { keccak_256 as keccak } from '@noble/hashes/sha3';
import { verifyAggregate, PubKey } from '../crypto/bls';
import { ADDR_TO_PUB } from './runtime';
import { HASH_HEX_PREFIX, DUMMY_SIGNATURE } from '../constants';

/* ──────────── RORO Pattern Types ──────────── */
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

/* ──────────── frame hashing ──────────── */
/** Compute canonical hash of a frame's content using keccak256. */
export const hashFrame = <T>(frame: Frame<T>): Hex => {
	// Custom replacer to handle BigInt serialization
	const replacer = (_key: string, value: unknown) => (typeof value === 'bigint' ? value.toString() : value);

	return (HASH_HEX_PREFIX + Buffer.from(keccak(JSON.stringify(frame, replacer))).toString('hex')) as Hex;
	// TODO: switch to keccak(encFrame(frame)) for canonical hashing once codec is stable
};

/* ──────────── internal helpers ──────────── */
const sortTransaction = (a: Transaction, b: Transaction) =>
	a.nonce !== b.nonce ? (a.nonce < b.nonce ? -1 : 1) : a.from !== b.from ? (a.from < b.from ? -1 : 1) : 0;

const getSharesOf = (address: Address, quorum: Quorum): bigint => quorum.members[address]?.shares ?? 0n;

// Currently unused but kept for clarity
// const calculatePower = (signatures: Map<Address, Hex>, quorum: Quorum) =>
// 	[...signatures.keys()].reduce((sum, address) => sum + getSharesOf(address, quorum), 0);
// const isThresholdReached = (signatures: Map<Address, Hex>, quorum: Quorum) => calculatePower(signatures, quorum) >= quorum.threshold;

/* ──────────── commit validation ──────────── */
/** Validate an incoming COMMIT frame against our current state */
const validateCommit = ({ frame, hanko, prev, signers }: ValidateCommitParams): boolean => {
	const quorum = prev.state.quorum;

	// Check height continuity
	if (frame.height !== prev.height + 1n) {
		return false;
	}

	// Replay transactions to verify state
	const replayResult = execFrame({ prev, transactions: frame.txs, timestamp: frame.ts });
	if (!replayResult.ok) {
		return false;
	}
	const replay = replayResult.value;

	// Compare the replayed state hash with the frame's state hash
	const replayStateHash = hashFrame(replay);
	const frameStateHash = hashFrame(frame);
	if (replayStateHash !== frameStateHash) {
		return false;
	}

	// Verify BLS aggregate signature
	// Check we have enough signers for threshold
	const totalPower = signers.reduce<bigint>((sum, signer) => sum + getSharesOf(signer, quorum), 0n);
	if (totalPower < quorum.threshold) {
		console.error(`Insufficient signing power: ${totalPower} < ${quorum.threshold}`);
		return false;
	}

	// Get public keys only for signers who signed
	const pubKeys = signers.reduce((keys: PubKey[], addr) => {
		const pubKey = ADDR_TO_PUB.get(addr);
		if (!pubKey) {
			console.error(`No public key found for signer ${addr}`);
			return keys;
		}
		return [...keys, pubKey];
	}, []);

	// Check if we got all required public keys
	if (pubKeys.length !== signers.length) {
		return false;
	}

	const frameHash = hashFrame(frame);

	try {
		const isValid = verifyAggregate({ hanko, messageHash: frameHash, publicKeys: pubKeys });
		if (!isValid) {
			// BLS signature verification failed
			return false;
		}
	} catch (e) {
		console.error('BLS verification error:', e);
		return false;
	}

	return true;
};

/* ──────────── domain-specific state transition (chat) ──────────── */
/** Apply a single chat transaction to the entity state (assuming nonce and membership are valid). */
export const applyTx = ({ state, transaction, timestamp }: ApplyTxParams): Result<EntityState> => {
	const tx = transaction; // Keep using tx for brevity
	if (tx.kind !== 'chat') return err('Unknown tx kind');
	const record = state.quorum.members[tx.from];
	if (!record) return err('Signer not in quorum');
	if (tx.nonce !== record.nonce) return err('Bad nonce'); // stale or duplicate tx

	// Update the signer's nonce (consume one nonce) and append chat message
	const updatedMembers = {
		...state.quorum.members,
		[tx.from]: { nonce: record.nonce + 1n, shares: record.shares },
	};
	return ok({
		quorum: { ...state.quorum, members: updatedMembers },
		chat: [...state.chat, { from: tx.from, msg: tx.body.message, ts: timestamp }],
	});
};

/** Execute a batch of transactions on the previous frame's state to produce a new Frame. */
export const execFrame = ({ prev, transactions, timestamp }: ExecFrameParams): Result<Frame<EntityState>> => {
	const txs = transactions; // Keep using txs for brevity
	// Create a new sorted array without mutating the original
	// eslint-disable-next-line fp/no-mutating-methods
	const orderedTxs = [...txs].sort(sortTransaction);

	// Apply transactions functionally, propagating errors
	const finalStateResult = orderedTxs.reduce<Result<EntityState>>((stateResult, tx) => {
		if (!stateResult.ok) return stateResult;
		return applyTx({ state: stateResult.value, transaction: tx, timestamp });
	}, ok(prev.state));

	if (!finalStateResult.ok) return err(finalStateResult.error);
	const currentState = finalStateResult.value;
	return ok({
		height: prev.height + 1n,
		ts: timestamp,
		txs: orderedTxs,
		state: currentState,
	});
};

/* ──────────── Entity consensus state machine (pure function) ──────────── */
/** Apply a high-level command to a replica's state. Returns a new Replica state (no mutation). */
export const applyCommand = ({ replica, command }: ApplyCommandParams): Replica => {
	switch (command.type) {
		case 'ADD_TX': {
			// Add a new transaction to the mempool (no immediate state change)
			return { ...replica, mempool: [...replica.mempool, command.tx] };
		}

		case 'PROPOSE': {
			if (replica.isAwaitingSignatures || replica.mempool.length === 0) {
				console.log(`PROPOSE skipped: awaiting=${replica.isAwaitingSignatures}, mempool=${replica.mempool.length}`);
				return replica; // nothing to do (either already proposing or no tx to propose)
			}
			// Build a new frame from current mempool transactions
			const frameResult = execFrame({ prev: replica.last, transactions: replica.mempool, timestamp: command.ts });
			if (!frameResult.ok) {
				console.log(`PROPOSE failed: frame build error - ${frameResult.error}`);
				return replica; // Failed to build frame, keep current state
			}
			const frame = frameResult.value;
			// For single-signer quorum (threshold=1), seed with proposer's signature
			const quorum = replica.last.state.quorum;
			const shouldSeedProposerSig = quorum.threshold === 1n && replica.proposer && quorum.members[replica.proposer];
			const initialSigs =
				shouldSeedProposerSig && replica.proposer
					? new Map<Address, Hex>([[replica.proposer, DUMMY_SIGNATURE as Hex]])
					: new Map<Address, Hex>();

			const proposal: ProposedFrame<EntityState> = {
				...frame,
				hash: hashFrame(frame),
				sigs: initialSigs,
			};

			return {
				...replica,
				mempool: [],
				isAwaitingSignatures: true,
				proposal,
			};
		}

		case 'SIGN': {
			if (!replica.isAwaitingSignatures || !replica.proposal) return replica;
			if (command.frameHash !== replica.proposal.hash) return replica; // frame mismatch
			if (!replica.last.state.quorum.members[command.signer]) return replica; // signer not in quorum
			if (replica.proposal.sigs.has(command.signer)) return replica; // signer already signed
			// Accept this signer's signature for the proposal
			const newSigs = new Map(replica.proposal.sigs).set(command.signer, command.sig);
			return { ...replica, proposal: { ...replica.proposal, sigs: newSigs } };
		}

		case 'COMMIT': {
			// Accept Commit even if this replica never saw the proposal

			// 1. Validate frame & Hanko against our own last state
			try {
				if (
					!validateCommit({ frame: command.frame, hanko: command.hanko, prev: replica.last, signers: command.signers })
				) {
					// Validation failed, replica will not apply this commit
					return replica;
				}
			} catch (e) {
				console.error('COMMIT validation error:', e);
				return replica;
			}

			// 2. Drop txs that were just committed
			const newMempool = replica.mempool.filter(tx => !command.frame.txs.some(c => c.sig === tx.sig));

			// 3. Adopt the new state
			return {
				...replica,
				last: command.frame,
				mempool: newMempool,
				isAwaitingSignatures: false,
				proposal: undefined,
			};
		}

		case 'IMPORT':
			// IMPORT is handled at server level, not entity level
			return replica;

		default: {
			// Exhaustive check
			// @ts-expect-error - exhaustive type check
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			const _: never = command;
			return replica;
		}
	}
};
