import { Runtime, ADDRS, PRIVS } from './core/runtime';
import { Input, Transaction } from './types';
import { sign } from './crypto/bls';

const runtime = new Runtime();

const fromAddr = ADDRS[0];
const privKey = PRIVS[0];
const chatTx: Transaction = {
  kind: 'chat',
  nonce: 0n,
  from: fromAddr,
  body: { message: 'Hello, XLN!' },
  sig: '0x00' as const,
};

(async () => {
  chatTx.sig = await sign(Buffer.from(JSON.stringify(chatTx.body)), privKey);
  const addTxInput: Input = { from: fromAddr, to: fromAddr, cmd: { type: 'ADD_TX', addrKey: 'demo:chat', tx: chatTx } };

  console.log('Tick 1: initial tick (no input)');
  await runtime.tick(Date.now(), []);

  console.log('Tick 2: process ADD_TX');
  const { outbox: out1 } = await runtime.tick(Date.now() + 100, [addTxInput]);

  console.log('Tick 3: process PROPOSE -> SIGN');
  const { outbox: out2 } = await runtime.tick(Date.now() + 200, out1);

  console.log('Tick 4: process COMMIT');
  const { frame: finalFrame } = await runtime.tick(Date.now() + 300, out2);
  console.log('Final ServerFrame root:', finalFrame.root);
})();
