import { createRuntime } from './core/runtime';
import { sign } from './crypto/bls';
import { Input, Transaction } from './types';
import {
	QUORUM_THRESHOLD,
	TOTAL_SIGNERS,
	DEMO_JURISDICTION,
	DEMO_ENTITY_ID,
	TICK_INTERVAL_MS,
	HASH_DISPLAY_LENGTH,
} from './constants';

// Extended demo script showing multiple consensus rounds with different signers

// Skip signature verification for demo
// process.env.DEV_SKIP_SIGS = '1';

// Initialize the runtime (which sets up the 5 signers and genesis state)
const runtime = createRuntime();

// Use the addresses and keys from the runtime
const DEMO_ADDRS = runtime.ADDRS;
const DEMO_PRIVS = runtime.PRIVS;

// Helper to create signed transactions
const createSignedTransaction = (
	fromIndex: number, 
	message: string
): Transaction => {
	const fromAddr = DEMO_ADDRS[fromIndex];
	const privKey = DEMO_PRIVS[fromIndex];
	
	// Get current nonce from the state
	const proposerReplica = runtime.debugReplicas().get(`${DEMO_JURISDICTION}:${DEMO_ENTITY_ID}:${DEMO_ADDRS[0]}`);
	const memberRecord = proposerReplica?.last.state.quorum.members[fromAddr];
	const currentNonce = memberRecord?.nonce ?? 0n;
	
	const baseTx: Omit<Transaction, 'sig'> = {
		kind: 'chat',
		nonce: currentNonce,
		from: fromAddr,
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
	
	const signature = sign({ message: msgToSign, privateKey: privKey });
	return { ...baseTx, sig: signature };
};

(() => {
	console.log('=== XLN Extended Consensus Demo ===\n');
	console.log('Signers:');
	DEMO_ADDRS.forEach((addr, i) => console.log(`  ${i + 1}. ${addr}`));
	console.log(`\nQuorum: ${QUORUM_THRESHOLD} of ${TOTAL_SIGNERS} signatures required\n`);

	const state = { tickCount: 0 };
	const baseTime = Date.now();

	// Helper to run a consensus round
	const runConsensusRound = (transactions: Transaction[]): void => {
		console.log(`\n━━━ CONSENSUS ROUND ${Math.floor(state.tickCount / 4) + 1} ━━━`);
		
		// Create ADD_TX inputs for all transactions
		// Route all transactions to the fixed proposer (first signer)
		const addTxInputs: Input[] = transactions.map(tx => ({
			from: tx.from,
			to: DEMO_ADDRS[0], // Always send to proposer
			cmd: { type: 'ADD_TX' as const, addrKey: `${DEMO_JURISDICTION}:${DEMO_ENTITY_ID}`, tx },
		}));

		// Tick 1: Add transactions to mempool
		state.tickCount = state.tickCount + 1;
		console.log(`\nTick ${state.tickCount}: Add ${transactions.length} transaction(s) to mempool`);
		const { outbox: out1 } = runtime.tick({ 
			now: baseTime + TICK_INTERVAL_MS * state.tickCount, 
			incoming: addTxInputs 
		});
		console.log(`  → Generated ${out1.length} follow-up command(s)`);
		const proposeCmds = out1.filter(o => o.cmd.type === 'PROPOSE');
		if (proposeCmds.length > 0) {
			console.log(`  → ${proposeCmds.length} PROPOSE commands generated`);
		}
		
		// Debug: Check if proposer received transactions
		const proposerReplica = runtime.debugReplicas().get(`${DEMO_JURISDICTION}:${DEMO_ENTITY_ID}:${DEMO_ADDRS[0]}`);
		if (proposerReplica) {
			console.log(`  → Proposer mempool size: ${proposerReplica.mempool.length}, awaiting sigs: ${proposerReplica.isAwaitingSignatures}`);
		}

		// Tick 2: Process PROPOSE
		state.tickCount = state.tickCount + 1;
		console.log(`\nTick ${state.tickCount}: Process PROPOSE (creates frame)`);
		const { outbox: out2 } = runtime.tick({ 
			now: baseTime + TICK_INTERVAL_MS * state.tickCount, 
			incoming: out1 
		});
		console.log(`  → Proposal created, requesting signatures from ${out2.length} signers`);
		
		// Debug: Check proposer's proposal state
		const proposerReplicaAfterPropose = runtime.debugReplicas().get(`${DEMO_JURISDICTION}:${DEMO_ENTITY_ID}:${DEMO_ADDRS[0]}`);
		if (proposerReplicaAfterPropose) {
			console.log(`  → After PROPOSE: has proposal=${!!proposerReplicaAfterPropose.proposal}, awaiting=${proposerReplicaAfterPropose.isAwaitingSignatures}`);
			if (proposerReplicaAfterPropose.proposal) {
				console.log(`  → Proposal details: height=${proposerReplicaAfterPropose.proposal.height}, sigs=${proposerReplicaAfterPropose.proposal.sigs.size}`);
			}
			console.log(`  → Quorum: threshold=${proposerReplicaAfterPropose.last.state.quorum.threshold}, members=${Object.keys(proposerReplicaAfterPropose.last.state.quorum.members).length}`);
		}

		// Tick 3: Process SIGN commands
		state.tickCount = state.tickCount + 1;
		console.log(`\nTick ${state.tickCount}: Process SIGN commands (collect signatures)`);
		const { outbox: out3 } = runtime.tick({ 
			now: baseTime + TICK_INTERVAL_MS * state.tickCount, 
			incoming: out2 
		});
		console.log(`  → Threshold reached! ${out3.length} COMMIT commands generated`);

		// Tick 4: Process COMMIT
		state.tickCount = state.tickCount + 1;
		console.log(`\nTick ${state.tickCount}: Process COMMIT (finalize consensus)`);
		const { frame } = runtime.tick({ 
			now: baseTime + TICK_INTERVAL_MS * state.tickCount, 
			incoming: out3 
		});
		console.log(`  → Frame #${frame.height} committed with hash ${frame.hash.slice(0, HASH_DISPLAY_LENGTH)}...`);
		
		// Debug: Check proposer state after commit
		const proposerReplicaAfter = runtime.debugReplicas().get(`${DEMO_JURISDICTION}:${DEMO_ENTITY_ID}:${DEMO_ADDRS[0]}`);
		if (proposerReplicaAfter) {
			console.log(`  → Post-commit: height=${proposerReplicaAfter.last.height}, awaiting=${proposerReplicaAfter.isAwaitingSignatures}`);
		}
	};

	// Round 1: Single message from first signer
	const tx1 = createSignedTransaction(0, "Hello, XLN! This is the genesis message.");
	runConsensusRound([tx1]);

	// Round 2: Multiple messages from different signers
	const tx2 = createSignedTransaction(1, "Greetings from signer 2!");
	const tx3 = createSignedTransaction(2, "Signer 3 joining the conversation.");
	runConsensusRound([tx2, tx3]);

	// Round 3: Messages from all signers
	const round3Txs = [
		createSignedTransaction(0, "Alice here: Let's test the consensus!"),
		createSignedTransaction(1, "Bob agrees: Byzantine fault tolerance FTW!"),
		createSignedTransaction(2, "Carol says: Threshold signatures are amazing."),
		createSignedTransaction(3, "Dave checking in: Quorum at work!"),
		createSignedTransaction(4, "Eve confirms: All systems operational."),
	];
	runConsensusRound(round3Txs);

	// Round 4: High-volume test
	const round4Txs = [
		createSignedTransaction(0, "Testing high throughput scenario..."),
		createSignedTransaction(1, "Multiple transactions in single frame."),
		createSignedTransaction(2, "Deterministic ordering is key!"),
		createSignedTransaction(3, "BLS signatures aggregate nicely."),
	];
	runConsensusRound(round4Txs);

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
		const replacer = (_: string, value: unknown) => 
			typeof value === 'bigint' ? value.toString() : value;
		return JSON.stringify(replica.last.state, replacer);
	});
	
	const allStatesMatch = stateHashes.every(hash => hash === stateHashes[0]);
	
	console.log('\n─────────────────────────────────');
	console.log('State Convergence Check:');
	[...allReplicas].forEach(([key, replica]) => {
		const signerPart = key.split(':').pop();
		const shortKey = signerPart ? signerPart.slice(0, 8) + '...' : key;
		console.log(`  Replica ${shortKey}: Height ${replica.last.height}, Messages ${replica.last.state.chat.length}`);
	});
	
	console.log(
		'\nConsensus Status:',
		allStatesMatch ? '✅ SUCCESS - All replicas converged!' : '❌ FAILED - Replicas diverged!'
	);
	
	// Show performance metrics
	console.log('\n─────────────────────────────────');
	console.log('Performance Metrics:');
	console.log(`  Total ticks: ${state.tickCount}`);
	console.log(`  Consensus rounds: ${Math.floor(state.tickCount / 4)}`);
	console.log(`  Messages per round: ${(chat.length / Math.floor(state.tickCount / 4)).toFixed(2)} avg`);
	console.log(`  Total simulation time: ${state.tickCount * TICK_INTERVAL_MS}ms`);
	
	console.log('\n✨ Extended demo completed successfully!');
})();
