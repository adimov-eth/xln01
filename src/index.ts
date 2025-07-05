import { createRuntime } from './core/runtime';
import { sign } from './crypto/bls';
import { Input, Transaction } from './types';
import {
	QUORUM_THRESHOLD,
	TOTAL_SIGNERS,
	INITIAL_HEIGHT,
	DUMMY_SIGNATURE,
	DEMO_JURISDICTION,
	DEMO_ENTITY_ID,
	TICK_INTERVAL_MS,
} from './constants';

// Demo script showing the full consensus flow for a chat message

// Skip signature verification for demo
// process.env.DEV_SKIP_SIGS = '1';

// Initialize the runtime (which sets up the 5 signers and genesis state)
const runtime = createRuntime();

// Use the addresses and keys from the runtime
const DEMO_ADDRS = runtime.ADDRS;
const DEMO_PRIVS = runtime.PRIVS;

// Prepare a chat transaction from the first signer
const fromAddr = DEMO_ADDRS[0];
const privKey = DEMO_PRIVS[0];
const chatTx: Transaction = {
	kind: 'chat',
	nonce: INITIAL_HEIGHT,
	from: fromAddr,
	body: { message: 'Hello, XLN!' },
	sig: DUMMY_SIGNATURE, // placeholder for now
} as any;

(async () => {
	console.log('=== XLN Chat Consensus Demo ===\n');
	console.log('Signers:');
	DEMO_ADDRS.forEach((addr, i) => console.log(`  ${i + 1}. ${addr}`));
	console.log(`\nQuorum: ${QUORUM_THRESHOLD} of ${TOTAL_SIGNERS} signatures required\n`);

	// Sign the transaction
	const msgToSign = Buffer.from(
		JSON.stringify({
			kind: chatTx.kind,
			nonce: chatTx.nonce.toString(),
			from: chatTx.from,
			body: chatTx.body,
		}),
	);
	chatTx.sig = await sign(msgToSign, privKey);

	const addTxInput: Input = {
		from: fromAddr,
		to: fromAddr,
		cmd: { type: 'ADD_TX', addrKey: `${DEMO_JURISDICTION}:${DEMO_ENTITY_ID}`, tx: chatTx },
	};

	// The runtime already initializes replicas in constructor, so we can skip import
	// and go directly to adding a transaction

	console.log('Tick 1: Add transaction to mempool');
	const { outbox: out1 } = await runtime.tick(Date.now() + TICK_INTERVAL_MS, [addTxInput]);
	console.log(`  → Generated ${out1.length} follow-up commands`);

	console.log('\nTick 2: Process PROPOSE (creates frame)');
	const { outbox: out2 } = await runtime.tick(Date.now() + TICK_INTERVAL_MS * 2, out1);
	console.log(`  → Proposal created, requesting signatures from ${out2.length} signers`);

	console.log('\nTick 3: Process SIGN commands (collect signatures)');
	const { outbox: out3 } = await runtime.tick(Date.now() + TICK_INTERVAL_MS * 3, out2);
	console.log(`  → ${out3.length} COMMIT commands generated`);

	console.log('\nTick 4: Process COMMIT (finalize consensus)');
	const { frame: finalFrame } = await runtime.tick(Date.now() + TICK_INTERVAL_MS * 4, out3);

	// Wait a moment for state to settle
	await new Promise(resolve => setTimeout(resolve, 100));

	console.log('\n=== CONSENSUS ACHIEVED ===');

	// Verify all replicas have converged to the same state
	console.log('\nVerifying state convergence across all replicas:');
	const allReplicas = runtime.debugReplicas();
	let allStatesMatch = true;
	let firstStateHash: string | null = null;

	for (const [key, replica] of allReplicas) {
		const chat = replica.last.state.chat;
		// Custom replacer to handle BigInt serialization
		const replacer = (key: string, value: any) => (typeof value === 'bigint' ? value.toString() : value);
		const stateHash = JSON.stringify(replica.last.state, replacer);

		if (firstStateHash === null) {
			firstStateHash = stateHash;
		} else if (stateHash !== firstStateHash) {
			allStatesMatch = false;
		}

		console.log(`\n  Replica ${key}:`);
		console.log(`    Height: ${replica.last.height}`);
		console.log(`    Chat messages: ${chat.length}`);
		if (chat.length > 0) {
			chat.forEach((message: any, i: number) => {
				console.log(`      ${i + 1}. "${message.msg}" (from ${message.from.slice(0, 10)}...)`);
			});
		}
	}

	console.log(
		'\n  State convergence:',
		allStatesMatch ? '✅ SUCCESS - All replicas have identical state' : '❌ FAILED - Replicas have diverged',
	);

	console.log('\nServerFrame details:');
	console.log(`  Final height: ${finalFrame.height}`);
	console.log(`  State root: ${finalFrame.root.slice(0, 16)}...`);

	console.log('\n✅ Demo completed successfully!');
})().catch(console.error);
