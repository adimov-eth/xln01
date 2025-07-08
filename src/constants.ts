export const QUORUM_THRESHOLD = 3;
export const TOTAL_SIGNERS = 5;
export const DEFAULT_SHARES_PER_SIGNER = 1;

export const TICK_INTERVAL_MS = 100;
export const INITIAL_HEIGHT = 0n;

export const BLS_SIGNATURE_LENGTH = 96;
export const ADDRESS_LENGTH = 20;
export const DUMMY_SIGNATURE = `0x${'00'.repeat(BLS_SIGNATURE_LENGTH)}` as const;

export const DEMO_JURISDICTION = 'demo';
export const DEMO_ENTITY_ID = 'chat';

export const HASH_DISPLAY_LENGTH = 10;

export const TRANSACTION_FIELD_COUNT = 5;
export const FRAME_FIELD_COUNT = 4;
export const COMMAND_FIELD_COUNT = 2;
export const INPUT_FIELD_COUNT = 3;
export const SERVER_FRAME_FIELD_COUNT = 5;

export const DEMO_WAIT_MS = 100;
export const TIMESTAMP_BIGINT_THRESHOLD = 15;

export const EMPTY_HASH = `0x${'00'.repeat(64)}` as const;
