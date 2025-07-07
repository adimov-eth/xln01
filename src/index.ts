import {
	DEMO_ENTITY_ID,
	DEMO_JURISDICTION,
	HASH_DISPLAY_LENGTH,
	QUORUM_THRESHOLD,
	TICK_INTERVAL_MS,
	TOTAL_SIGNERS,
} from './constants';
import { createRuntime } from './core/runtime';
import { sign } from './crypto/bls';
import type { Input, Transaction } from './types';

// Demo script showing multiple consensus rounds

// Initialize the runtime (which sets up the 5 signers and genesis state)
const runtime = createRuntime();

// Use the addresses and keys from the runtime
const DEMO_ADDRS = runtime.ADDRS;
const DEMO_PRIVS = runtime.PRIVS;

// Helper to create signed transactions
const createSignedTransaction = (fromIndex: number, message: string): Transaction => {
	const fromAddr = DEMO_ADDRS[fromIndex];
	const privKey = DEMO_PRIVS[fromIndex];

	// Get current nonce from the state
	const proposerReplica = runtime.debugReplicas().get(`${DEMO_JURISDICTION}:${DEMO_ENTITY_ID}:${DEMO_ADDRS[0]}`);
	const memberRecord = proposerReplica?.last.state.quorum.members[fromAddr as `0x${string}`];
	const currentNonce = memberRecord?.nonce ?? 0n;

	const baseTx: Omit<Transaction, 'sig'> = {
		kind: 'chat',
		nonce: currentNonce,
		from: fromAddr as `0x${string}`,
		body: { message },
	};

	const msgToSign = Buffer.from(
		JSON.stringify({
			kind: baseTx.kind,
			nonce: baseTx.nonce.toString(),
			from: baseTx.from,
			body: baseTx.body,
		}),
	);

	const signature = sign(msgToSign, Buffer.from(privKey.slice(2), 'hex'));
	return { ...baseTx, sig: signature };
};

void (async () => {
	console.log('=== XLN Extended Consensus Demo ===\n');
	console.log('Signers:');
	DEMO_ADDRS.forEach((addr, i) => console.log(`  ${i + 1}. ${addr}`));
	console.log(`\nQuorum: ${QUORUM_THRESHOLD} of ${TOTAL_SIGNERS} signatures required\n`);

	const baseTime = Date.now();

	// Helper to run a consensus round
	const runConsensusRound = async (transactions: Transaction[], currentTick: number): Promise<number> => {
		console.log(`\n━━━ CONSENSUS ROUND ${Math.floor(currentTick / 4) + 1} ━━━`);

		// Create ADD_TX inputs for all transactions
		// Route all transactions to the fixed proposer (first signer)
		const addTxInputs: Input[] = transactions.map(tx => ({
			from: tx.from,
			to: DEMO_ADDRS[0] as `0x${string}`, // Always send to proposer
			cmd: { type: 'ADD_TX' as const, addrKey: `${DEMO_JURISDICTION}:${DEMO_ENTITY_ID}`, tx },
		}));

		// Tick 1: Add transactions to mempool
		const tick1 = currentTick + 1;
		console.log(`\nTick ${tick1}: Add ${transactions.length} transaction(s) to mempool`);
		const { outbox: out1 } = await runtime.tick(baseTime + TICK_INTERVAL_MS * tick1, addTxInputs);
		console.log(`  → Generated ${out1.length} follow-up command(s)`);
		const proposeCmds = out1.filter((o: Input) => o.cmd.type === 'PROPOSE');
		if (proposeCmds.length > 0) {
			console.log(`  → ${proposeCmds.length} PROPOSE commands generated`);
		}

		// Tick 2: Process PROPOSE
		const tick2 = tick1 + 1;
		console.log(`\nTick ${tick2}: Process PROPOSE (creates frame)`);
		const { outbox: out2 } = await runtime.tick(baseTime + TICK_INTERVAL_MS * tick2, out1);
		console.log(`  → Proposal created, requesting signatures from ${out2.length} signers`);

		// Tick 3: Process SIGN commands
		const tick3 = tick2 + 1;
		console.log(`\nTick ${tick3}: Process SIGN commands (collect signatures)`);
		const { outbox: out3 } = await runtime.tick(baseTime + TICK_INTERVAL_MS * tick3, out2);
		console.log(`  → Threshold reached! ${out3.length} COMMIT commands generated`);

		// Tick 4: Process COMMIT
		const tick4 = tick3 + 1;
		console.log(`\nTick ${tick4}: Process COMMIT (finalize consensus)`);
		const { frame } = await runtime.tick(baseTime + TICK_INTERVAL_MS * tick4, out3);
		console.log(`  → Frame #${frame.height} committed with hash ${frame.hash.slice(0, HASH_DISPLAY_LENGTH)}...`);

		return tick4;
	};

	// Round 1: Single message from first signer
	const tx1 = createSignedTransaction(0, 'Hello, XLN! This is the genesis message.');
	const tickAfterRound1 = await runConsensusRound([tx1], 0);

	// Round 2: Multiple messages from different signers
	const tx2 = createSignedTransaction(1, 'Greetings from signer 2!');
	const tx3 = createSignedTransaction(2, 'Signer 3 joining the conversation.');
	const tickAfterRound2 = await runConsensusRound([tx2, tx3], tickAfterRound1);

	// Round 3: Messages from all signers
	const round3Txs = [
		createSignedTransaction(0, "Alice here: Let's test the consensus!"),
		createSignedTransaction(1, 'Bob agrees: Byzantine fault tolerance FTW!'),
		createSignedTransaction(2, 'Carol says: Threshold signatures are amazing.'),
		createSignedTransaction(3, 'Dave checking in: Quorum at work!'),
		createSignedTransaction(4, 'Eve confirms: All systems operational.'),
	];
	const tickAfterRound3 = await runConsensusRound(round3Txs, tickAfterRound2);

	// Round 4: High-volume test
	const round4Txs = [
		createSignedTransaction(0, 'Testing high throughput scenario...'),
		createSignedTransaction(1, 'Multiple transactions in single frame.'),
		createSignedTransaction(2, 'Deterministic ordering is key!'),
		createSignedTransaction(3, 'BLS signatures aggregate nicely.'),
	];
	const finalTickCount = await runConsensusRound(round4Txs, tickAfterRound3);

	console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

	console.log('\n=== FINAL STATE VERIFICATION ===');

	// Verify all replicas have converged to the same state
	console.log('\nChecking state convergence across all replicas...');
	const allReplicas = runtime.debugReplicas();

	// Pick first replica to show detailed state
	const [, firstReplica] = [...allReplicas][0];
	const chat = firstReplica.last.state.chat;

	console.log(`\nConsensus achieved at height: ${firstReplica.last.height}`);
	console.log(`Total messages committed: ${chat.length}`);

	// Show message timeline
	console.log('\nMessage Timeline:');
	console.log('─────────────────');
	chat.forEach((message, i) => {
		const signerIndex = DEMO_ADDRS.findIndex(addr => addr === message.from);
		const signerName = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve'][signerIndex] || 'Unknown';
		console.log(`  ${(i + 1).toString().padStart(2)}. [${signerName}] "${message.msg}"`);
	});

	// Verify all replicas match
	const stateHashes = [...allReplicas].map(([, replica]) => {
		const replacer = (_: string, value: unknown) => (typeof value === 'bigint' ? value.toString() : value);
		return JSON.stringify(replica.last.state, replacer);
	});

	const firstHash = stateHashes[0] ?? '';
	const allStatesMatch = stateHashes.every(hash => hash === firstHash);

	console.log('\n─────────────────────────────────');
	console.log('State Convergence Check:');

	// eslint-disable-next-line
	for (const [key, replica] of allReplicas) {
		const parts = key.split(':');
		const signerPart = parts[parts.length - 1];
		const shortKey = signerPart ? `${signerPart.slice(0, 8)}...` : key;
		console.log(`  Replica ${shortKey}: Height ${replica.last.height}, Messages ${replica.last.state.chat.length}`);
	}

	console.log(
		'\nConsensus Status:',
		allStatesMatch ? '✅ SUCCESS - All replicas converged!' : '❌ FAILED - Replicas diverged!',
	);

	// Show performance metrics
	console.log('\n─────────────────────────────────');
	console.log('Performance Metrics:');
	console.log(`  Total ticks: ${finalTickCount}`);
	console.log(`  Consensus rounds: ${Math.floor(finalTickCount / 4)}`);
	console.log(`  Messages per round: ${(chat.length / Math.floor(finalTickCount / 4)).toFixed(2)} avg`);
	console.log(`  Total simulation time: ${finalTickCount * TICK_INTERVAL_MS}ms`);

	console.log('\n✨ Extended demo completed successfully!');
})();
