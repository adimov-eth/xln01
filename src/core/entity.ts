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
  Nonce,
} from '../types';
import { keccak_256 as keccak } from '@noble/hashes/sha3';
import { verifyAggregate } from '../crypto/bls';

export const hashFrame = (f: Frame<any>): Hex =>
  ('0x' + Buffer.from(keccak(JSON.stringify(f))).toString('hex')) as Hex; // TODO: use RLP encoding

const sortTx = (a: Transaction, b: Transaction) =>
  a.nonce !== b.nonce ? (a.nonce < b.nonce ? -1 : 1) : a.from < b.from ? -1 : a.from > b.from ? 1 : 0;

const sharesOf = (addr: Address, q: Quorum) => q.members[addr]?.shares ?? 0;
const power = (sigs: Map<Address, Hex>, q: Quorum) => [...sigs.keys()].reduce((sum, addr) => sum + sharesOf(addr, q), 0);
const thresholdReached = (sigs: Map<Address, Hex>, q: Quorum) => power(sigs, q) >= q.threshold;

const applyTx = (st: EntityState, tx: Transaction, ts: TS): EntityState => {
  const rec = st.quorum.members[tx.from];
  if (!rec) throw new Error('Signer not in quorum');
  if (tx.nonce !== rec.nonce) throw new Error('Bad nonce');
  switch (tx.kind) {
    case 'chat':
      return {
        ...st,
        quorum: {
          ...st.quorum,
          members: { ...st.quorum.members, [tx.from]: { ...rec, nonce: (rec.nonce + 1n) as Nonce } },
        },
        chat: [...st.chat, { from: tx.from, msg: (tx.body as any).message, ts }],
      };
    default:
      return st;
  }
};

export const execFrame = (last: Frame<EntityState>, txs: Transaction[], ts: TS): Frame<EntityState> => {
  const ordered = [...txs].sort(sortTx);
  let state = { ...last.state, chat: [...last.state.chat] } as EntityState;
  for (const tx of ordered) state = applyTx(state, tx, ts);
  return { height: (last.height + 1n) as any, ts, txs: ordered, state };
};

export const applyCommand = (rep: Replica, cmd: Command): Replica => {
  switch (cmd.type) {
    case 'ADD_TX':
      return { ...rep, mempool: [...rep.mempool, cmd.tx] };

    case 'PROPOSE': {
      if (rep.isAwaitingSignatures || rep.mempool.length === 0) return rep;
      const frame = execFrame(rep.last, rep.mempool, cmd.ts);
      const hash = hashFrame(frame);
      const proposal: ProposedFrame<EntityState> = { ...frame, sigs: new Map([[rep.proposer, '0x00']]), hash };
      return { ...rep, mempool: [], proposal, isAwaitingSignatures: true };
    }

    case 'SIGN': {
      if (!rep.proposal || rep.proposal.hash !== cmd.frameHash) return rep;
      if (rep.proposal.sigs.has(cmd.signer)) return rep;
      if (!rep.last.state.quorum.members[cmd.signer]) return rep;
      const sigs = new Map(rep.proposal.sigs).set(cmd.signer, cmd.sig);
      const proposal = { ...rep.proposal, sigs };
      return { ...rep, proposal };
    }

    case 'COMMIT': {
      if (!rep.proposal || hashFrame(cmd.frame) !== rep.proposal.hash) return rep;
      if (!thresholdReached(rep.proposal.sigs, rep.last.state.quorum)) return rep;
      if (!process.env.DEV_SKIP_SIGS) {
        const pubs = Object.keys(rep.last.state.quorum.members) as any;
        if (!verifyAggregate(cmd.hanko, hashFrame(cmd.frame), pubs)) {
          throw new Error('Invalid hanko');
        }
      }
      return { ...rep, isAwaitingSignatures: false, proposal: undefined, last: cmd.frame };
    }

    default:
      return rep;
  }
};
