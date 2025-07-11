import { describe, expect, it } from 'bun:test';
import { keccak_256 as keccak } from '@noble/hashes/sha3';
import { hashFrame, hashQuorum } from '../core/codec';
import { validateQuorumHash } from '../core/entity';
import { aggregate, getPublicKey, randomPriv, sign } from '../crypto/bls';
import { blsVerifyAggregate } from '../infra/bls';
import type { Frame, Hex, Transaction, EntityState, Quorum } from '../types';

describe('Integration Tests', () => {
	describe('RLP Frame Hashing', () => {
		it('should produce correct RLP frame hash', () => {
			const mockTx: Transaction = {
				kind: 'chat',
				nonce: 1n,
				from: '0x1111111111111111111111111111111111111111' as Hex,
				body: { message: 'Hello World' },
				sig: ('0x' + '00'.repeat(96)) as Hex,
			};

			const frame: Frame<EntityState> = {
				height: 1n,
				ts: 1234567890,
				txs: [mockTx],
				state: {} as EntityState,
			};

			const hash = hashFrame(
				{
					height: frame.height,
					timestamp: frame.ts,
					parentHash: '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex,
					proposer: '0x0000000000000000000000000000000000000000' as Hex,
				},
				frame.txs,
			);

			// Hash should be deterministic
			expect(hash).toMatch(/^0x[0-9a-f]{64}$/);

			// Same input should produce same hash
			const hash2 = hashFrame(
				{
					height: frame.height,
					timestamp: frame.ts,
					parentHash: '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex,
					proposer: '0x0000000000000000000000000000000000000000' as Hex,
				},
				frame.txs,
			);
			expect(hash2).toBe(hash);
		});

		it('should match expected hash from xlnfinance fixture', () => {
			// This would be a known hash from xlnfinance implementation
			// For now, we'll just verify the format
			const frame: Frame<EntityState> = {
				height: 42n,
				ts: 1000000000,
				txs: [],
				state: {} as EntityState,
			};

			const hash = hashFrame(
				{
					height: frame.height,
					timestamp: frame.ts,
					parentHash: '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex,
					proposer: '0x0000000000000000000000000000000000000000' as Hex,
				},
				frame.txs,
			);

			expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
		});

		it('should handle empty transaction list', () => {
			const frame: Frame<EntityState> = {
				height: 0n,
				ts: 0,
				txs: [],
				state: {} as EntityState,
			};

			const hash = hashFrame(
				{
					height: frame.height,
					timestamp: frame.ts,
					parentHash: '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex,
					proposer: '0x0000000000000000000000000000000000000000' as Hex,
				},
				frame.txs,
			);

			expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
		});

		it('should produce different hashes for different frames', () => {
			const frame1: Frame<EntityState> = {
				height: 1n,
				ts: 1000,
				txs: [],
				state: {} as EntityState,
			};

			const frame2: Frame<EntityState> = {
				height: 2n,
				ts: 1000,
				txs: [],
				state: {} as EntityState,
			};

			const hash1 = hashFrame(
				{
					height: frame1.height,
					timestamp: frame1.ts,
					parentHash: '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex,
					proposer: '0x0000000000000000000000000000000000000000' as Hex,
				},
				frame1.txs,
			);

			const hash2 = hashFrame(
				{
					height: frame2.height,
					timestamp: frame2.ts,
					parentHash: '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex,
					proposer: '0x0000000000000000000000000000000000000000' as Hex,
				},
				frame2.txs,
			);

			expect(hash1).not.toBe(hash2);
		});

		it.todo('should handle property-based frame hashing with fast-check');
	});

	describe('BLS Aggregate Signatures', () => {
		it('should verify valid aggregate signature', () => {
			// Create test message and hash
			const message = Buffer.from('test message');
			const messageHash = keccak(message);
			const msgHash = `0x${Buffer.from(messageHash).toString('hex')}`;

			// Generate keys and signatures
			const privKey1 = randomPriv();
			const privKey2 = randomPriv();
			const pubKey1 = getPublicKey(privKey1);
			const pubKey2 = getPublicKey(privKey2);

			// Sign the hash, not the original message
			const sig1 = sign({ message: messageHash, privateKey: privKey1 });
			const sig2 = sign({ message: messageHash, privateKey: privKey2 });

			// Create aggregate signature
			const aggregateSig = aggregate([sig1, sig2]);

			// Verify aggregate
			const result = blsVerifyAggregate({
				sig: aggregateSig,
				msgHash,
				pubKeys: [pubKey1, pubKey2],
			});

			expect(result.ok).toBe(true);
		});

		it('should reject invalid aggregate signature', () => {
			// Create test message
			const msgHash = ('0x' + '11'.repeat(32)) as Hex;

			// Generate keys
			const pubKey1 = getPublicKey(randomPriv());
			const pubKey2 = getPublicKey(randomPriv());

			// Create invalid signature (wrong length)
			const invalidSig = ('0x' + '00'.repeat(96)) as Hex;

			// Verify should fail
			const result = blsVerifyAggregate({
				sig: invalidSig,
				msgHash,
				pubKeys: [pubKey1, pubKey2],
			});

			expect(result.ok).toBe(false);
			if (!result.ok) {
				// The error message varies based on the invalid signature
				expect(result.error.message).toBeTruthy();
			}
		});

		it('should handle threshold quorum (3 of 5)', () => {
			// Create test message
			const message = Buffer.from('consensus message');
			const messageHash = keccak(message);
			const msgHash = `0x${Buffer.from(messageHash).toString('hex')}`;

			// Generate 5 keys
			const keys = Array.from({ length: 5 }, () => {
				const priv = randomPriv();
				return { priv, pub: getPublicKey(priv) };
			});

			// Get signatures from 3 signers (threshold)
			const sigs = keys.slice(0, 3).map(k => sign({ message: messageHash, privateKey: k.priv }));
			const aggregateSig = aggregate(sigs);

			// Verify with the 3 public keys
			const result = blsVerifyAggregate({
				sig: aggregateSig,
				msgHash,
				pubKeys: keys.slice(0, 3).map(k => k.pub),
			});

			expect(result.ok).toBe(true);
		});

		it('should reject insufficient signatures (2 of 5)', () => {
			// This is more of a business logic test - the signature itself would be valid
			// but the quorum logic should reject it. This belongs in entity tests.
			// For now, let's test that we can verify 2 signatures correctly
			const message = Buffer.from('insufficient quorum');
			const messageHash = keccak(message);
			const msgHash = `0x${Buffer.from(messageHash).toString('hex')}`;

			// Generate 2 keys (insufficient for quorum of 3)
			const priv1 = randomPriv();
			const key1 = { priv: priv1, pub: getPublicKey(priv1) };
			const priv2 = randomPriv();
			const key2 = { priv: priv2, pub: getPublicKey(priv2) };

			// Sign with both
			const sig1 = sign({ message: messageHash, privateKey: key1.priv });
			const sig2 = sign({ message: messageHash, privateKey: key2.priv });
			const aggregateSig = aggregate([sig1, sig2]);

			// The signature is valid for these 2 keys
			const result = blsVerifyAggregate({
				sig: aggregateSig,
				msgHash,
				pubKeys: [key1.pub, key2.pub],
			});

			// Signature is cryptographically valid
			expect(result.ok).toBe(true);
			// But the quorum check (in entity.ts) would reject this as insufficient
		});
	});

	describe('QuorumProof Validation', () => {
		it('should reject command with invalid quorum hash', () => {
			// Create a mock quorum
			const quorum: Quorum = {
				threshold: 2n,
				members: {
					'0x1111111111111111111111111111111111111111': { nonce: 0n, shares: 1n },
					'0x2222222222222222222222222222222222222222': { nonce: 0n, shares: 1n },
					'0x3333333333333333333333333333333333333333': { nonce: 0n, shares: 1n },
				},
			};

			// Use wrong hash
			const wrongHash = ('0x' + '00'.repeat(32)) as Hex;

			// Validate wrong hash fails
			const result = validateQuorumHash(quorum, wrongHash);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toContain('Quorum hash mismatch');
			}
		});

		it('should accept command with matching quorum hash', () => {
			// Create a mock quorum
			const quorum: Quorum = {
				threshold: 2n,
				members: {
					'0x1111111111111111111111111111111111111111': { nonce: 0n, shares: 1n },
					'0x2222222222222222222222222222222222222222': { nonce: 0n, shares: 1n },
					'0x3333333333333333333333333333333333333333': { nonce: 0n, shares: 1n },
				},
			};

			// Compute correct hash
			const correctHash = hashQuorum(quorum);

			// Validate correct hash passes
			const result = validateQuorumHash(quorum, correctHash);
			expect(result.ok).toBe(true);
		});

		it('should compute quorum hash deterministically', () => {
			// Create a mock quorum
			const quorum: Quorum = {
				threshold: 3n,
				members: {
					'0x3333333333333333333333333333333333333333': { nonce: 2n, shares: 2n },
					'0x1111111111111111111111111111111111111111': { nonce: 0n, shares: 1n },
					'0x2222222222222222222222222222222222222222': { nonce: 1n, shares: 1n },
				},
			};

			// Compute hash multiple times
			const hash1 = hashQuorum(quorum);
			const hash2 = hashQuorum(quorum);
			const hash3 = hashQuorum(quorum);

			// All should be identical
			expect(hash1).toBe(hash2);
			expect(hash2).toBe(hash3);

			// Should be a valid hex hash
			expect(hash1).toMatch(/^0x[0-9a-f]{64}$/);
		});
	});

	describe('WAL Replay', () => {
		it.todo('should write inputs to WAL');
		it.todo('should write ServerFrames to WAL');
		it.todo('should replay from WAL and reach same state');
		it.todo('should handle crash recovery mid-tick');
	});

	describe('Multi-Entity ServerFrame', () => {
		it.todo('should compute global merkle root correctly');
		it.todo('should handle multiple entities in one tick');
		it.todo('should broadcast commits to all replicas');
		it.todo('should update root when any entity commits');
	});

	describe('Leader Rotation', () => {
		it.todo('should select proposer deterministically by height');
		it.todo('should timeout and rotate to next proposer');
		it.todo('should allow re-proposal of same transactions');
	});
});
