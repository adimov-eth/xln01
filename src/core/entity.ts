import { keccak_256 as keccak } from '@noble/hashes/sha3';
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
	TS,
	Transaction,
} from '../types';
import { ADDR_TO_PUB } from './runtime';

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
export const hashFrame = (f: Frame<EntityState>): Hex => {
	// Custom replacer to handle BigInt serialization
	const replacer = (_key: string, value: unknown) => (typeof value === 'bigint' ? value.toString() : value);

	return `0x${Buffer.from(keccak(JSON.stringify(f, replacer))).toString('hex')}`;
	// TODO: switch to keccak(encFrame(f)) for canonical hashing once codec is stable
};

/* ──────────── internal helpers ──────────── */
const sortTx = (a: Transaction, b: Transaction) =>
	a.nonce !== b.nonce ? (a.nonce < b.nonce ? -1 : 1) : a.from !== b.from ? (a.from < b.from ? -1 : 1) : 0;

const sharesOf = (addr: Address, q: Quorum) => q.members[addr]?.shares ?? 0;

// const power = (sigs: Map<Address, Hex>, q: Quorum) =>
// 	[...sigs.keys()].reduce((sum, addr) => sum + sharesOf(addr, q), 0);

// const thresholdReached = (sigs: Map<Address, Hex>, q: Quorum) => power(sigs, q) >= q.threshold;

/* ──────────── commit validation ──────────── */
/** Validate an incoming COMMIT frame against our current state */
const validateCommit = ({ frame, hanko, prev, signers }: ValidateCommitParams): boolean => {
	const quorum = prev.state.quorum;

	// Check height continuity
	if (frame.height !== prev.height + 1n) {
		return false;
	}

	// Replay transactions to verify state
	const replay = execFrame({ prev, transactions: frame.txs, timestamp: frame.ts });

	// Compare the replayed state hash with the frame's state hash
	const replayStateHash = hashFrame(replay);
	const frameStateHash = hashFrame(frame);
	if (replayStateHash !== frameStateHash) {
		return false;
	}

	// Verify BLS aggregate signature (skip if DEV flag set)
	if (!process.env.DEV_SKIP_SIGS) {
		// Check we have enough signers for threshold
		const totalPower = signers.reduce((sum, signer) => sum + sharesOf(signer, quorum), 0);
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
			return keys.concat([pubKey]);
		}, []);

		// Check if we got all required public keys
		if (pubKeys.length !== signers.length) {
			return false;
		}

		const frameHash = hashFrame(frame);

		try {
			const isValid = verifyAggregate(hanko, frameHash, pubKeys);
			if (!isValid) {
				// BLS signature verification failed
				return false;
			}
		} catch (e) {
			console.error('BLS verification error:', e);
			return false;
		}
	}

	return true;
};

/* ──────────── domain-specific state transition (chat) ──────────── */
/** Apply a single chat transaction to the entity state (assuming nonce and membership are valid). */
export const applyTx = ({ state, transaction, timestamp }: ApplyTxParams): EntityState | null => {
	const tx = transaction; // Keep using tx for brevity
	const st = state; // Keep using st for brevity
	if (tx.kind !== 'chat') return null; // Unknown tx kind
	const rec = st.quorum.members[tx.from];
	if (!rec) return null; // Signer not in quorum
	if (tx.nonce !== rec.nonce) return null; // Bad nonce - stale or duplicate tx

	// Update the signer's nonce (consume one nonce) and append chat message
	const updatedMembers = {
		...st.quorum.members,
		[tx.from]: { nonce: rec.nonce + 1n, shares: rec.shares },
	};
	return {
		quorum: { ...st.quorum, members: updatedMembers },
		chat: [...st.chat, { from: tx.from, msg: tx.body.message, ts: timestamp }],
	};
};

/** Execute a batch of transactions on the previous frame's state to produce a new Frame. */
export const execFrame = ({ prev, transactions, timestamp }: ExecFrameParams): Frame<EntityState> => {
	const txs = transactions; // Keep using txs for brevity
	// Create a sorted copy using a functional approach
	// eslint-disable-next-line fp/no-mutating-methods
	const orderedTxs = [...txs].sort((a, b) => sortTx(a, b));
	const newState = orderedTxs.reduce((state, tx) => {
		const result = applyTx({ state, transaction: tx, timestamp });
		return result || state; // If applyTx returns null, keep current state
	}, prev.state);
	return {
		height: prev.height + 1n,
		ts: timestamp,
		txs: orderedTxs,
		state: newState,
	};
};

/* ──────────── Entity consensus state machine (pure function) ──────────── */
/** Apply a high-level command to a replica's state. Returns a new Replica state (no mutation). */
export const applyCommand = ({ replica, command }: ApplyCommandParams): Replica => {
	const cmd = command; // Keep using cmd for brevity
	switch (cmd.type) {
		case 'ADD_TX': {
			// Add a new transaction to the mempool (no immediate state change)
			return { ...replica, mempool: [...replica.mempool, cmd.tx] };
		}

		case 'PROPOSE': {
			if (replica.isAwaitingSignatures || replica.mempool.length === 0) {
				return replica; // nothing to do (either already proposing or no tx to propose)
			}
			// Build a new frame from current mempool transactions
			const frame = execFrame({ prev: replica.last, transactions: replica.mempool, timestamp: cmd.ts });
			const proposal: ProposedFrame<EntityState> = {
				...frame,
				hash: hashFrame(frame),
				sigs: new Map(), // Start with empty signatures, will be filled by runtime
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
			if (cmd.frameHash !== replica.proposal.hash) return replica; // frame mismatch
			if (!replica.last.state.quorum.members[cmd.signer]) return replica; // signer not in quorum
			if (replica.proposal.sigs.has(cmd.signer)) return replica; // signer already signed
			// Accept this signer's signature for the proposal
			const newSigs = new Map(replica.proposal.sigs).set(cmd.signer, cmd.sig);
			return { ...replica, proposal: { ...replica.proposal, sigs: newSigs } };
		}

		case 'COMMIT': {
			// Accept Commit even if this replica never saw the proposal

			// 1. Validate frame & Hanko against our own last state
			try {
				if (!validateCommit({ frame: cmd.frame, hanko: cmd.hanko, prev: replica.last, signers: cmd.signers })) {
					// Validation failed, replica will not apply this commit
					return replica;
				}
			} catch (e) {
				console.error('COMMIT validation error:', e);
				return replica;
			}

			// 2. Drop txs that were just committed
			const newMempool = replica.mempool.filter(tx => !cmd.frame.txs.some(c => c.sig === tx.sig));

			// 3. Adopt the new state
			return {
				...replica,
				last: cmd.frame,
				mempool: newMempool,
				isAwaitingSignatures: false,
				proposal: undefined,
			};
		}

		case 'IMPORT': {
			// IMPORT command is handled at server level, not entity level
			// Return replica unchanged
			return replica;
		}

		default:
			return replica;
	}
};
