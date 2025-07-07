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
export const HEX_PREFIX_LENGTH = 2; // Length of '0x' prefix
export const DUMMY_SIGNATURE = '0x00' as const; // Placeholder signature before runtime fills it

/* ──────────── Demo Configuration ──────────── */
export const DEMO_JURISDICTION = 'demo';
export const DEMO_ENTITY_ID = 'chat';

/* ──────────── Display Configuration ──────────── */
export const HASH_DISPLAY_LENGTH = 10; // Number of characters to show when displaying truncated hashes

/* ──────────── RLP Encoding Configuration ──────────── */
export const TRANSACTION_FIELD_COUNT = 5; // kind, nonce, from, body, sig
export const FRAME_FIELD_COUNT = 4; // height, ts, txs, state
export const COMMAND_FIELD_COUNT = 2; // type, data
export const INPUT_FIELD_COUNT = 3; // from, to, cmd
export const SERVER_FRAME_FIELD_COUNT = 4; // height, ts, inputs, root

/* ──────────── Demo Configuration ──────────── */
export const DEMO_WAIT_MS = 100; // Wait time in demo for state to settle
export const TIMESTAMP_BIGINT_THRESHOLD = 15; // Timestamps with >15 digits are likely BigInt
