# XLN v02 Specification Compliance - Execution Plan

## Phase 1: Frame Structure Compliance (Est: 2-3 days)

### Step 1.1: Update Type Definitions

**File**: `src/types.ts`

```typescript
// Add new types per spec
export interface FrameHeader {
	height: UInt64;
	timestamp: UInt64; // Change from TS (number) to bigint
	parentHash: Hex;
	proposer: Address;
}

export interface FrameBody<T = unknown> {
	transactions: Transaction[];
	state?: T; // Optional, for backward compatibility
}

// Update Frame interface
export interface Frame<T = unknown> {
	header: FrameHeader;
	body: FrameBody<T>;
}

// Keep ProposedFrame for now, but align with spec
export interface ProposedFrame<T = unknown> extends Frame<T> {
	sigs: Map<Address, Hex>;
	hash: Hex;
	proposalTs?: UInt64; // Change to bigint
}
```

### Step 1.2: Update Frame Creation Sites

**Files to update**:

1. `src/core/entity.ts` - execFrame, handlePropose
2. `src/core/server.ts` - applyServerBlock
3. `src/test/*.test.ts` - All test files creating frames

**Example update for entity.ts**:

```typescript
export const execFrame = ({
	prev,
	transactions,
	timestamp,
	proposer, // New parameter
}: ExecFrameParams): Result<Frame<EntityState>> => {
	const orderedTxs = [...transactions].sort(sortTransaction);

	const finalStateResult = orderedTxs.reduce<Result<EntityState>>(
		(stateResult, tx) =>
			stateResult.ok ? applyTx({ state: stateResult.value, transaction: tx, timestamp }) : stateResult,
		ok(prev.state),
	);

	return finalStateResult.ok
		? ok({
				header: {
					height: prev.header.height + 1n,
					timestamp: BigInt(timestamp),
					parentHash: hashFrame(prev),
					proposer,
				},
				body: {
					transactions: orderedTxs,
					state: finalStateResult.value,
				},
			})
		: finalStateResult;
};
```

### Step 1.3: Update Frame Hashing

**File**: `src/core/codec.ts`

```typescript
export const hashFrame = <T>(frame: Frame<T>): Hex => {
	// Now uses actual frame header instead of mock
	return computeFrameHash(frame.header, frame.body.transactions);
};
```

**File**: `src/codec/rlp.ts`

```typescript
export const encodeFrame = <T>(frame: Frame<T>): Uint8Array => {
	return encode([
		encodeBigInt(frame.header.height),
		encodeBigInt(frame.header.timestamp),
		encodeHex(frame.header.parentHash),
		encodeAddress(frame.header.proposer),
		frame.body.transactions.map(encodeTransaction),
	]);
};
```

## Phase 2: Transaction Sorting Fix (Est: 1 day)

### Step 2.1: Update Sort Function

**File**: `src/core/entity.ts`

```typescript
// Match spec: nonce → signerId → kind
const sortTransaction = (a: Transaction, b: Transaction): number => {
	// Primary sort: nonce
	if (a.nonce !== b.nonce) {
		return a.nonce < b.nonce ? -1 : 1;
	}

	// Secondary sort: from (signerId)
	const fromCompare = a.from.localeCompare(b.from);
	if (fromCompare !== 0) {
		return fromCompare;
	}

	// Tertiary sort: kind
	return a.kind.localeCompare(b.kind);
};
```

### Step 2.2: Add Sorting Tests

**File**: `src/test/entity-sorting.test.ts` (new)

```typescript
import { describe, expect, it } from 'bun:test';
import { sortTransaction } from '../core/entity';

describe('Transaction Sorting Specification Compliance', () => {
	it('should sort by nonce first', () => {
		const txs = [
			{ nonce: 2n, from: '0xaaa...', kind: 'chat' },
			{ nonce: 1n, from: '0xbbb...', kind: 'chat' },
		];
		const sorted = [...txs].sort(sortTransaction);
		expect(sorted[0].nonce).toBe(1n);
	});

	it('should sort by from (signerId) second', () => {
		const txs = [
			{ nonce: 1n, from: '0xbbb...', kind: 'chat' },
			{ nonce: 1n, from: '0xaaa...', kind: 'chat' },
		];
		const sorted = [...txs].sort(sortTransaction);
		expect(sorted[0].from).toBe('0xaaa...');
	});

	it('should sort by kind third', () => {
		const txs = [
			{ nonce: 1n, from: '0xaaa...', kind: 'transfer' },
			{ nonce: 1n, from: '0xaaa...', kind: 'chat' },
		];
		const sorted = [...txs].sort(sortTransaction);
		expect(sorted[0].kind).toBe('chat');
	});
});
```

## Phase 3: Property-Based Testing (Est: 2 days)

### Step 3.1: Frame Hash Determinism

**File**: `src/test/properties/frame-hash.test.ts` (new)

```typescript
import fc from 'fast-check';
import { hashFrame } from '../../core/codec';

describe('Frame Hash Properties', () => {
	it('should be deterministic', () => {
		fc.assert(
			fc.property(arbFrame(), frame => {
				const hash1 = hashFrame(frame);
				const hash2 = hashFrame(frame);
				return hash1 === hash2;
			}),
		);
	});

	it('should change with any field change', () => {
		fc.assert(
			fc.property(arbFrame(), fc.bigUint(), (frame, newHeight) => {
				const hash1 = hashFrame(frame);
				const modifiedFrame = {
					...frame,
					header: { ...frame.header, height: newHeight },
				};
				const hash2 = hashFrame(modifiedFrame);
				return newHeight !== frame.header.height ? hash1 !== hash2 : hash1 === hash2;
			}),
		);
	});
});
```

### Step 3.2: Consensus Invariants

**File**: `src/test/properties/consensus.test.ts` (new)

```typescript
describe('Consensus Properties', () => {
	it('height should be monotonically increasing', () => {
		fc.assert(
			fc.property(arbEntityState(), arbTransactions(), (initialState, transactions) => {
				let prevHeight = 0n;
				let state = initialState;

				for (const tx of transactions) {
					const result = applyTx({ state, transaction: tx });
					if (result.ok) {
						expect(result.value.height).toBeGreaterThan(prevHeight);
						prevHeight = result.value.height;
						state = result.value;
					}
				}
				return true;
			}),
		);
	});
});
```

## Phase 4: Performance Benchmarks (Est: 1 day)

### Step 4.1: Create Benchmark Suite

**File**: `src/bench/consensus.bench.ts` (new)

```typescript
import { bench, describe } from 'vitest';

describe('Consensus Performance', () => {
	bench('BLS signature verification', () => {
		// Measure single signature verification
	});

	bench('BLS aggregate verification (5 signers)', () => {
		// Measure aggregate verification
	});

	bench('Frame hashing (100 transactions)', () => {
		// Measure frame hash computation
	});

	bench('WAL write throughput', async () => {
		// Measure WAL writes per second
	});
});
```

## Migration Strategy

### Safe Migration Steps

1. **Create feature branch**: `feat/spec-compliance`
2. **Update types first**: Ensures TypeScript catches all usage sites
3. **Update creation sites**: Fix compilation errors one by one
4. **Update tests**: Ensure all tests pass with new structure
5. **Add new tests**: Property-based and compliance tests
6. **Run full test suite**: Including integration tests
7. **Performance benchmarks**: Ensure no regression
8. **Document changes**: Update ARCHITECTURE.md

### Rollback Plan

If issues arise:

1. Keep old types alongside new (deprecated)
2. Add compatibility layer for gradual migration
3. Feature flag new behavior
4. Maintain backward compatibility for one version

## Validation Criteria

### Spec Compliance

- [ ] Frame structure matches spec exactly
- [ ] Transaction sorting follows spec rules
- [ ] All hash computations are deterministic
- [ ] Test against spec-provided test vectors

### No Regressions

- [ ] All existing tests pass
- [ ] Performance benchmarks within 5% of baseline
- [ ] Bundle size under 100KB
- [ ] WAL format compatible or migrated

### Code Quality

- [ ] No new type assertions
- [ ] All functions remain pure
- [ ] Error handling via Result types
- [ ] 95%+ test coverage maintained

## Timeline

- **Day 1-2**: Frame structure updates
- **Day 3**: Transaction sorting and tests
- **Day 4-5**: Property-based testing
- **Day 6**: Performance benchmarks
- **Day 7**: Documentation and review

Total: 1 week for full spec compliance

---

This execution plan provides concrete code changes needed for specification compliance while maintaining backward compatibility and code quality standards.
