import { applyServerBlock } from './server';
import { randomPriv, pub, addr, sign, aggregate } from '../crypto/bls';
import { Input, Replica, ServerState, Transaction, Hex } from '../types';

export const PRIVS = Array.from({ length: 5 }, () => randomPriv());
export const PUBS = PRIVS.map(pub);
export const ADDRS = PUBS.map(addr);

const genesisEntity = (): Replica => {
  const quorum = {
    threshold: 3,
    members: Object.fromEntries(ADDRS.map(a => [a, { nonce: 0n, shares: 1 }])),
  };
  const initFrame = { height: 0n, ts: 0, txs: [], state: { quorum, chat: [] } };
  return {
    address: { jurisdiction: 'demo', entityId: 'chat' },
    proposer: ADDRS[0],
    isAwaitingSignatures: false,
    mempool: [],
    last: initFrame,
  };
};

export class Runtime {
  private state: ServerState = { replicas: new Map(), height: 0n };

  constructor() {
    const base = genesisEntity();
    ADDRS.forEach(addr => {
      const rep: Replica = { ...base, proposer: addr };
      this.state.replicas.set(`demo:chat:${addr}`, rep);
    });
  }

  async tick(now: number, incoming: Input[]) {
    const { state: next, frame, outbox } = applyServerBlock(this.state, incoming, now);
    const fulfilled = await Promise.all(outbox.map(async msg => {
      if (msg.cmd.type === 'SIGN' && msg.cmd.sig === '0x00') {
        const idx = ADDRS.indexOf(msg.cmd.signer);
        msg.cmd.sig = await sign(Buffer.from(msg.cmd.frameHash.slice(2), 'hex'), PRIVS[idx]);
      }
      if (msg.cmd.type === 'COMMIT' && msg.cmd.hanko === '0x00') {
        const sigs = (msg.cmd.frame as any).sigs as Map<string, Hex>;
        msg.cmd.hanko = aggregate([...sigs.values()] as Hex[]);
        delete (msg.cmd.frame as any).sigs;
        delete (msg.cmd.frame as any).hash;
      }
      return msg;
    }));

    console.log(`Committed ServerFrame #${frame.height.toString()} – hash: ${frame.hash.slice(0,10)}... root: ${frame.root.slice(0,10)}...`);
    this.state = next;
    return { outbox: fulfilled, frame };
  }
}
