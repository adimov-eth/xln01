import { applyServerBlock } from './server';
import { sign, aggregate, randomPriv, pub, addr } from '../crypto/bls';
import { Input, Replica, Frame, EntityState, Quorum } from '../types';

/* ──────────── Deterministic demo key generation (5 signers) ──────────── */
const PRIVS = Array.from({ length: 5 }, () => randomPriv());
const PUBS  = PRIVS.map(pub);
const ADDRS = PUBS.map(addr);

/* ──────────── Bootstrap an initial Replica (genesis state) ──────────── */
const genesisEntity = (): Replica => {
  const quorum: Quorum = {
    threshold: 3,  // require 3 out of 5 signatures to commit (simple majority)
    members: Object.fromEntries(
      ADDRS.map(a => [a, { nonce: 0n, shares: 1 }])
    )
  };
  const initState: EntityState = { quorum, chat: [] };
  const initFrame: Frame<EntityState> = { height: 0n, ts: 0, txs: [], state: initState };
  return {
    address: { jurisdiction: 'demo', entityId: 'chat' },
    proposer: ADDRS[0],               // initial proposer (could be rotated later)
    isAwaitingSignatures: false,
    mempool: [],
    last: initFrame
    // proposal: undefined (implicitly)
  };
};

export class Runtime {
  private state: { replicas: Map<string, Replica>; height: bigint }
    = { replicas: new Map(), height: 0n };
  
  // Export for demo access
  public readonly ADDRS = ADDRS;
  public readonly PRIVS = PRIVS;

  constructor() {
    // Initialize a replica for each signer in the demo entity:
    const base = genesisEntity();
    ADDRS.forEach(signerAddr => {
      const rep: Replica = { ...base, proposer: signerAddr };
      this.state.replicas.set(`demo:chat:${signerAddr}`, rep);
    });
    this.state.height = 0n;
  }

  /** Drive one 100ms tick of the server. Provide current time and any incoming Inputs. */
  async tick(now: number, incoming: Input[]) {
    // Step 1: apply the pure server logic to get the next state and ServerFrame
    const { state: nextState, frame, outbox } = applyServerBlock(this.state, incoming, now);

    // Step 2: fulfill signature placeholders in outbox (where private keys are used)
    const fulfilledOutbox = await Promise.all(outbox.map(async msg => {
      if (msg.cmd.type === 'SIGN' && msg.cmd.sig === '0x00') {
        // Sign the frame hash with the signer's private key
        const signerIndex = ADDRS.findIndex(a => a === msg.cmd.signer);
        msg.cmd.sig = await sign(Buffer.from(msg.cmd.frameHash.slice(2), 'hex'), PRIVS[signerIndex]);
      }
      if (msg.cmd.type === 'COMMIT' && msg.cmd.hanko === '0x00') {
        // Aggregate all collected signatures into one Hanko, and remove individual sigs from frame
        const frame = msg.cmd.frame as any;
        let realSigs: string[] = [];
        
        // Handle both Map and object representations
        if (frame.sigs instanceof Map) {
          realSigs = [...frame.sigs.values()].filter(sig => sig !== '0x00');
        } else if (frame.sigs && typeof frame.sigs === 'object') {
          realSigs = Object.values(frame.sigs).filter((sig: any) => sig !== '0x00');
        }
        
        if (realSigs.length > 0) {
          msg.cmd.hanko = aggregate(realSigs);
        } else {
          msg.cmd.hanko = '0x' + '00'.repeat(96); // Dummy 96-byte signature for testing
        }
        delete frame.sigs;
        delete frame.hash;
      }
      return msg;
    }));

    // Step 3: (Placeholder for actual networking/persistence)
    // For now, just log the ServerFrame and update state.
    console.log(`Committed ServerFrame #${frame.height.toString()} – hash: ${frame.hash.slice(0, 10)}... root: ${frame.root.slice(0, 10)}...`);

    // In a real node, here we would:
    // - Append `frame` to WAL (with fsync)
    // - Possibly take a snapshot of state or prune WAL
    // - Broadcast the outbox messages over network to respective peers

    // Update the in-memory server state for next tick
    this.state = nextState;
    // Return outbox and frame for further processing or inspection
    return { outbox: fulfilledOutbox, frame };
  }
}