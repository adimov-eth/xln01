import {
  Replica, Command, EntityState, Frame, Transaction, Quorum,
  ProposedFrame, Address, Hex, TS
} from '../types';
import { keccak_256 as keccak } from '@noble/hashes/sha3';
import { verifyAggregate, PubKey } from '../crypto/bls';
import { ADDR_TO_PUB } from './runtime';

/* ──────────── frame hashing ──────────── */
/** Compute canonical hash of a frame's content using keccak256. */
export const hashFrame = (f: Frame<any>): Hex => {
  // Custom replacer to handle BigInt serialization
  const replacer = (key: string, value: any) =>
    typeof value === 'bigint' ? value.toString() : value;
  
  return ('0x' + Buffer.from(keccak(JSON.stringify(f, replacer))).toString('hex')) as Hex;
  // TODO: switch to keccak(encFrame(f)) for canonical hashing once codec is stable
};

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

/* ──────────── commit validation ──────────── */
/** Validate an incoming COMMIT frame against our current state */
const validateCommit = (
  frame: Frame<EntityState>,
  hanko: Hex,
  prev: Frame<EntityState>,
  signers: Address[],
): boolean => {
  const quorum = prev.state.quorum;
  
  // Check height continuity
  if (frame.height !== prev.height + 1n) {
    return false;
  }
  
  // Replay transactions to verify state
  const replay = execFrame(prev, frame.txs, frame.ts);
  
  // Compare the replayed state hash with the frame's state hash
  const replayStateHash = hashFrame(replay);
  const frameStateHash = hashFrame(frame);
  if (replayStateHash !== frameStateHash) {
    return false;
  }
  
  // Verify BLS aggregate signature (skip if DEV flag set)
  if (!process.env.DEV_SKIP_SIGS) {
    // Check we have enough signers for threshold
    let totalPower = 0;
    for (const signer of signers) {
      totalPower += sharesOf(signer, quorum);
    }
    if (totalPower < quorum.threshold) {
      console.error(`Insufficient signing power: ${totalPower} < ${quorum.threshold}`);
      return false;
    }
    
    // Get public keys only for signers who signed
    const pubKeys: PubKey[] = [];
    for (const addr of signers) {
      const pubKey = ADDR_TO_PUB.get(addr);
      if (!pubKey) {
        console.error(`No public key found for signer ${addr}`);
        return false;
      }
      pubKeys.push(pubKey);
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
        sigs: new Map()  // Start with empty signatures, will be filled by runtime
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
      // Accept Commit even if this replica never saw the proposal
      
      // 1. Validate frame & Hanko against our own last state
      try {
        if (!validateCommit(cmd.frame, cmd.hanko, rep.last, cmd.signers)) {
          // Validation failed, replica will not apply this commit
          return rep;
        }
      } catch (e) {
        console.error('COMMIT validation error:', e);
        return rep;
      }
      
      // 2. Drop txs that were just committed
      const newMempool = rep.mempool.filter(
        tx => !cmd.frame.txs.some(c => c.sig === tx.sig)
      );
      
      // 3. Adopt the new state
      return {
        ...rep,
        last: cmd.frame,
        mempool: newMempool,
        isAwaitingSignatures: false,
        proposal: undefined,
      };
    }

    default:
      return rep;
  }
};