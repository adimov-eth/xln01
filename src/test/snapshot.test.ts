import { describe, test, expect } from '@jest/globals';
import { DEMO_ENTITY_ID, DEMO_JURISDICTION, INITIAL_HEIGHT } from '../constants';
import { createRuntime } from '../core/runtime';
import { sign } from '../crypto/bls';
import type { Input, Transaction } from '../types';

describe('XLN Consensus Snapshot Test', () => {
	test('single tick happy path produces expected state', async () => {
		// Initialize runtime
		const runtime = createRuntime();
		const fromAddr = runtime.ADDRS[0];
		const privKey = runtime.PRIVS[0];

		// Create message to sign
		const msgToSign = Buffer.from(
			JSON.stringify({
				kind: 'chat',
				nonce: INITIAL_HEIGHT.toString(),
				from: fromAddr,
				body: { message: 'Test message' },
			}),
		);

		// Sign the message
		const signature = sign(msgToSign, Buffer.from(privKey.slice(2), 'hex'));

		// Create the transaction with the signature
		const chatTx: Transaction = {
			kind: 'chat',
			nonce: INITIAL_HEIGHT,
			from: fromAddr as `0x${string}`,
			body: { message: 'Test message' },
			sig: signature,
		};

		// Create ADD_TX input
		const addTxInput: Input = {
			from: fromAddr as `0x${string}`,
			to: fromAddr as `0x${string}`,
			cmd: { type: 'ADD_TX', addrKey: `${DEMO_JURISDICTION}:${DEMO_ENTITY_ID}`, tx: chatTx },
		};

		// Tick 1: Add transaction
		const tick1Result = await runtime.tick(Date.now(), [addTxInput]);
		expect(tick1Result.outbox.length).toBe(1);
		expect(tick1Result.outbox[0].cmd.type).toBe('PROPOSE');

		// Tick 2: Process PROPOSE
		const tick2Result = await runtime.tick(Date.now() + 100, tick1Result.outbox);
		expect(tick2Result.outbox.length).toBe(5); // One SIGN request per signer
		expect(tick2Result.outbox.every(msg => msg.cmd.type === 'SIGN')).toBe(true);

		// Tick 3: Process SIGN commands
		const tick3Result = await runtime.tick(Date.now() + 200, tick2Result.outbox);
		expect(tick3Result.outbox.length).toBe(5); // One COMMIT per replica
		expect(tick3Result.outbox.every(msg => msg.cmd.type === 'COMMIT')).toBe(true);

		// Tick 4: Process COMMIT
		const tick4Result = await runtime.tick(Date.now() + 300, tick3Result.outbox);
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
		if (!firstReplica) {
			expect(firstReplica).toBeDefined();
			return;
		}
		expect({
			height: firstReplica.last.height.toString(),
			chatMessages: firstReplica.last.state.chat.length,
			firstMessage: firstReplica.last.state.chat[0].msg,
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
