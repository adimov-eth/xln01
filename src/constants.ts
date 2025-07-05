/* ──────────── Consensus Configuration ──────────── */
export const QUORUM_THRESHOLD = 3; // Require 3 out of 5 signatures to commit (simple majority)
export const TOTAL_SIGNERS = 5; // Total number of signers in the demo quorum
export const DEFAULT_SHARES_PER_SIGNER = 1; // Each signer has 1 voting share in MVP

/* ──────────── Timing Configuration ──────────── */
export const TICK_INTERVAL_MS = 100; // Server tick interval in milliseconds
export const INITIAL_HEIGHT = 0n; // Starting height for frames

/* ──────────── Cryptography Configuration ──────────── */
export const BLS_SIGNATURE_LENGTH = 96; // BLS12-381 signature is 96 bytes
export const ADDRESS_LENGTH = 20; // Ethereum-style addresses are 20 bytes (rightmost of keccak256)
export const HASH_HEX_PREFIX = '0x'; // Standard hex prefix
export const DUMMY_SIGNATURE = '0x00' as const; // Placeholder signature before runtime fills it

/* ──────────── Demo Configuration ──────────── */
export const DEMO_JURISDICTION = 'demo';
export const DEMO_ENTITY_ID = 'chat';
