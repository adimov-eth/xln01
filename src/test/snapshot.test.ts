import { createRuntime } from '../core/runtime';
import { sign } from '../crypto/bls';
import { Input, Transaction } from '../types';
import {
	INITIAL_HEIGHT,
	DEMO_JURISDICTION,
	DEMO_ENTITY_ID,
} from '../constants';

describe('XLN Consensus Snapshot Test', () => {
	test('single tick happy path produces expected state', () => {
		// Initialize runtime
		const runtime = createRuntime();
		const fromAddr = runtime.ADDRS[0];
		const privKey = runtime.PRIVS[0];
		
		// Create and sign a chat transaction
		const baseChatTx: Omit<Transaction, 'sig'> = {
			kind: 'chat',
			nonce: INITIAL_HEIGHT,
			from: fromAddr,
			body: { message: 'Test message' },
		};
		
		const msgToSign = Buffer.from(
			JSON.stringify({
				kind: baseChatTx.kind,
				nonce: baseChatTx.nonce.toString(),
				from: baseChatTx.from,
				body: baseChatTx.body,
			}),
		);
		const signature = sign({ message: msgToSign, privateKey: privKey });
		const chatTx: Transaction = { ...baseChatTx, sig: signature };
		
		// Create ADD_TX input
		const addTxInput: Input = {
			from: fromAddr,
			to: fromAddr,
			cmd: { type: 'ADD_TX', addrKey: `${DEMO_JURISDICTION}:${DEMO_ENTITY_ID}`, tx: chatTx },
		};
		
		// Tick 1: Add transaction
		const tick1Result = runtime.tick({ now: Date.now(), incoming: [addTxInput] });
		expect(tick1Result.outbox.length).toBe(1);
		expect(tick1Result.outbox[0].cmd.type).toBe('PROPOSE');
		
		// Tick 2: Process PROPOSE
		const tick2Result = runtime.tick({ now: Date.now() + 100, incoming: tick1Result.outbox });
		expect(tick2Result.outbox.length).toBe(5); // One SIGN request per signer
		expect(tick2Result.outbox.every(msg => msg.cmd.type === 'SIGN')).toBe(true);
		
		// Tick 3: Process SIGN commands
		const tick3Result = runtime.tick({ now: Date.now() + 200, incoming: tick2Result.outbox });
		expect(tick3Result.outbox.length).toBe(5); // One COMMIT per replica
		expect(tick3Result.outbox.every(msg => msg.cmd.type === 'COMMIT')).toBe(true);
		
		// Tick 4: Process COMMIT
		const tick4Result = runtime.tick({ now: Date.now() + 300, incoming: tick3Result.outbox });
		expect(tick4Result.outbox.length).toBe(0); // No more messages
		
		// Verify final state
		const replicas = runtime.debugReplicas();
		const replicaStates = [...replicas.values()];
		
		// All replicas should have the same state
		expect(replicaStates.length).toBe(5);
		expect(replicaStates.every(r => r.last.height === 1n)).toBe(true);
		expect(replicaStates.every(r => r.last.state.chat.length === 1)).toBe(true);
		expect(replicaStates.every(r => r.last.state.chat[0].msg === 'Test message')).toBe(true);
		
		// Snapshot the final state of the first replica
		const firstReplica = replicaStates[0];
		const firstChat = firstReplica.last.state.chat[0];
		expect({
			height: firstReplica.last.height.toString(),
			chatMessages: firstReplica.last.state.chat.length,
			firstMessage: firstChat?.msg,
			isAwaitingSignatures: firstReplica.isAwaitingSignatures,
			mempoolLength: firstReplica.mempool.length,
		}).toMatchInlineSnapshot(`
{
  "chatMessages": 1,
  "firstMessage": "Test message",
  "height": "1",
  "isAwaitingSignatures": false,
  "mempoolLength": 0,
}
`);
	});
});