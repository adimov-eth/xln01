import { Runtime } from './core/runtime';
import { Input, Transaction } from './types';
import { sign } from './crypto/bls';

// Demo script showing the full consensus flow for a chat message

// Initialize the runtime (which sets up the 5 signers and genesis state)
const runtime = new Runtime();

// Use the addresses and keys from the runtime
const DEMO_ADDRS = runtime.ADDRS;
const DEMO_PRIVS = runtime.PRIVS;

// Prepare a chat transaction from the first signer
const fromAddr = DEMO_ADDRS[0];
const privKey = DEMO_PRIVS[0];
const chatTx: Transaction = {
  kind: 'chat',
  nonce: 0n,
  from: fromAddr,
  body: { message: 'Hello, XLN!' },
  sig: '0x00'  // placeholder for now
} as any;

(async () => {
  console.log('=== XLN Chat Consensus Demo ===\n');
  console.log('Signers:');
  DEMO_ADDRS.forEach((addr, i) => console.log(`  ${i + 1}. ${addr}`));
  console.log('\nQuorum: 3 of 5 signatures required\n');

  // Sign the transaction
  const msgToSign = Buffer.from(JSON.stringify({ 
    kind: chatTx.kind,
    nonce: chatTx.nonce.toString(),
    from: chatTx.from,
    body: chatTx.body
  }));
  chatTx.sig = await sign(msgToSign, privKey);
  
  const addTxInput: Input = {
    from: fromAddr,
    to: fromAddr,
    cmd: { type: 'ADD_TX', addrKey: 'demo:chat', tx: chatTx }
  };

  // The runtime already initializes replicas in constructor, so we can skip import
  // and go directly to adding a transaction

  console.log('Tick 1: Add transaction to mempool');
  const { outbox: out1 } = await runtime.tick(Date.now() + 100, [addTxInput]);
  console.log(`  → Generated ${out1.length} follow-up commands`);

  console.log('\nTick 2: Process PROPOSE (creates frame)');
  const { outbox: out2 } = await runtime.tick(Date.now() + 200, out1);
  console.log(`  → Proposal created, requesting signatures from ${out2.length} signers`);

  console.log('\nTick 3: Process SIGN commands (collect signatures)');
  const { outbox: out3 } = await runtime.tick(Date.now() + 300, out2);
  console.log(`  → ${out3.length} COMMIT commands generated`);

  console.log('\nTick 4: Process COMMIT (finalize consensus)');
  const { frame: finalFrame } = await runtime.tick(Date.now() + 400, out3);

  // Wait a moment for state to settle
  await new Promise(resolve => setTimeout(resolve, 100));

  // Extract the final state from one of the replicas
  const finalReplica = (runtime as any).state.replicas.get(`demo:chat:${DEMO_ADDRS[0]}`);
  const finalChat = finalReplica.last.state.chat;

  console.log('\n=== CONSENSUS ACHIEVED ===');
  console.log('\nFinal chat log:');
  if (finalChat.length === 0) {
    console.log('  (No messages yet)');
  } else {
    finalChat.forEach((msg: any, i: number) => {
      console.log(`  ${i + 1}. [${new Date(msg.ts).toISOString()}] ${msg.from}: "${msg.msg}"`);
    });
  }
  
  console.log('\nFrame details:');
  console.log(`  Height: ${finalReplica.last.height}`);
  console.log(`  Transactions: ${finalReplica.last.txs.length}`);
  console.log(`  State root: ${finalFrame.root.slice(0, 16)}...`);
  
  
  console.log('\n✅ Demo completed successfully!');
})().catch(console.error);