import {
  Replica, Command, EntityState, Frame, Transaction, Quorum,
  ProposedFrame, Address, Hex, TS
} from '../types';
import { keccak_256 as keccak } from '@noble/hashes/sha3';
import { verifyAggregate } from '../crypto/bls';

/* ──────────── frame hashing ──────────── */
/** Compute canonical hash of a frame's content using keccak256. */
export const hashFrame = (f: Frame<any>): Hex =>
  ('0x' + Buffer.from(keccak(JSON.stringify(f))).toString('hex')) as Hex;
  // TODO: switch to keccak(encFrame(f)) for canonical hashing once codec is stable

/* ──────────── internal helpers ──────────── */
const sortTx = (a: Transaction, b: Transaction) =>
  a.nonce !== b.nonce ? (a.nonce < b.nonce ? -1 : 1)
  : a.from !== b.from ? (a.from < b.from ? -1 : 1)
  : 0;

const sharesOf = (addr: Address, q: Quorum) =>
  q.members[addr]?.shares ?? 0;

const power = (sigs: Map<Address, Hex>, q: Quorum) =>
  [...sigs.keys()].reduce((sum, addr) => sum + sharesOf(addr, q), 0);

const thresholdReached = (sigs: Map<Address, Hex>, q: Quorum) =>
  power(sigs, q) >= q.threshold;

/* ──────────── domain-specific state transition (chat) ──────────── */
/** Apply a single chat transaction to the entity state (assuming nonce and membership are valid). */
export const applyTx = (st: EntityState, tx: Transaction, ts: TS): EntityState => {
  if (tx.kind !== 'chat') throw new Error('Unknown tx kind');
  const rec = st.quorum.members[tx.from];
  if (!rec) throw new Error('Signer not in quorum');
  if (tx.nonce !== rec.nonce) throw new Error('Bad nonce');  // stale or duplicate tx

  // Update the signer's nonce (consume one nonce) and append chat message
  const updatedMembers = {
    ...st.quorum.members,
    [tx.from]: { nonce: rec.nonce + 1n, shares: rec.shares }
  };
  return {
    quorum: { ...st.quorum, members: updatedMembers },
    chat:   [ ...st.chat, { from: tx.from, msg: tx.body.message, ts } ]
  };
};

/** Execute a batch of transactions on the previous frame's state to produce a new Frame. */
export const execFrame = (
  prev: Frame<EntityState>, txs: Transaction[], ts: TS
): Frame<EntityState> => {
  const orderedTxs = txs.slice().sort(sortTx);
  let newState = prev.state;
  for (const tx of orderedTxs) {
    newState = applyTx(newState, tx, ts);
  }
  return {
    height: prev.height + 1n,
    ts,
    txs: orderedTxs,
    state: newState
  };
};

/* ──────────── Entity consensus state machine (pure function) ──────────── */
/** Apply a high-level command to a replica's state. Returns a new Replica state (no mutation). */
export const applyCommand = (rep: Replica, cmd: Command): Replica => {
  switch (cmd.type) {
    case 'ADD_TX': {
      // Add a new transaction to the mempool (no immediate state change)
      return { ...rep, mempool: [ ...rep.mempool, cmd.tx ] };
    }

    case 'PROPOSE': {
      if (rep.isAwaitingSignatures || rep.mempool.length === 0) {
        return rep;  // nothing to do (either already proposing or no tx to propose)
      }
      // Build a new frame from current mempool transactions
      const frame = execFrame(rep.last, rep.mempool, cmd.ts);
      const proposal: ProposedFrame<EntityState> = {
        ...frame,
        hash: hashFrame(frame),
        sigs: new Map([[ rep.proposer, '0x00' ]])  // proposer's own signature placeholder
      };
      return {
        ...rep,
        mempool: [],
        isAwaitingSignatures: true,
        proposal
      };
    }

    case 'SIGN': {
      if (!rep.isAwaitingSignatures || !rep.proposal) return rep;
      if (cmd.frameHash !== rep.proposal.hash) return rep;              // frame mismatch
      if (!rep.last.state.quorum.members[cmd.signer]) return rep;      // signer not in quorum
      if (rep.proposal.sigs.has(cmd.signer)) return rep;               // signer already signed
      // Accept this signer's signature for the proposal
      const newSigs = new Map(rep.proposal.sigs).set(cmd.signer, cmd.sig);
      return { ...rep, proposal: { ...rep.proposal, sigs: newSigs } };
    }

    case 'COMMIT': {
      if (!rep.isAwaitingSignatures || !rep.proposal) return rep;
      if (hashFrame(cmd.frame) !== rep.proposal.hash) return rep;       // frame integrity check
      if (!thresholdReached(rep.proposal.sigs, rep.last.state.quorum)) return rep;  // not enough signatures
      // If threshold reached, optionally verify the aggregate (unless bypassed for testing)
      if (!process.env.DEV_SKIP_SIGS) {
        const pubKeys = Object.keys(rep.last.state.quorum.members);
        if (!verifyAggregate(cmd.hanko, hashFrame(cmd.frame), pubKeys as any)) {
          throw new Error('Invalid Hanko aggregate signature');
        }
      }
      // Commit: apply the frame as the new last state, reset proposal
      return {
        ...rep,
        isAwaitingSignatures: false,
        proposal: undefined,
        last: cmd.frame
      };
    }

    default:
      return rep;
  }
};