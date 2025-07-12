# Code Audit Checklist for XLN v02

## Quick Audit Results

### 1. Frame Structure Compliance Issues

**Files to Update**:

- `src/types.ts:37-42` - Frame interface missing parentHash and proposer
- `src/core/entity.ts:63-73` - hashFrame creates mock header
- `src/core/codec.ts` - Frame encoding needs header/body structure
- `src/codec/rlp.ts:225-232` - encodeFrame needs update

**Current Frame Hashing**:

```typescript
// entity.ts:66-71
const header = {
	height: frame.height,
	timestamp: frame.ts,
	parentHash: '0x0000...', // Hardcoded!
	proposer: '0x0000...', // Hardcoded!
};
```

### 2. Transaction Sorting Issues

**Location**: `src/core/entity.ts:75-76`

```typescript
const sortTransaction = (a: Transaction, b: Transaction): number =>
	a.nonce < b.nonce ? -1 : a.nonce > b.nonce ? 1 : a.from.localeCompare(b.from);
```

- Uses `from` instead of `signerId`
- Missing `kind` in sort order

### 3. Timestamp Type Issues

**Files with number timestamps**:

- `src/types.ts:5` - `type TS = number;`
- All Frame interfaces use `ts: TS`
- Should be `timestamp: bigint` per spec

### 4. Missing Spec Features

**ProposedFrame vs Proposal**:

- Spec uses `Proposal` type
- We use `ProposedFrame<T>` with embedded state

**Missing Types from Spec**:

- `FrameHeader` interface
- `FrameBody` interface
- `Proposal` type (we have ProposedFrame)
- Explicit `Jurisdiction` and `Signer` types

### 5. Code Quality Findings

**Pure Function Violations**: None found! ✅

- All core/ functions are pure
- Side effects properly isolated in runtime

**Type Safety Issues**:

- Some `as` type assertions in tests
- No `any` types in production code ✅

**Error Handling**:

- Good use of Result types ✅
- Some console.error calls that could be Result types

### 6. Test Coverage Gaps

**Missing Test Scenarios**:

- Property-based tests for frame hashing
- Byzantine double-signing scenarios
- Proposal timeout edge cases
- Multi-entity Byzantine scenarios

**Good Coverage**:

- RLP encoding/decoding ✅
- BLS signature verification ✅
- WAL operations ✅
- Leader rotation ✅

## Priority Fix List

### 🔴 HIGH Priority (Spec Compliance)

1. **Update Frame Type** (`src/types.ts`)

   ```typescript
   interface FrameHeader {
   	height: bigint;
   	timestamp: bigint;
   	parentHash: Hex;
   	proposer: Address;
   }

   interface Frame<T> {
   	header: FrameHeader;
   	body: {
   		transactions: Transaction[];
   	};
   	state: T; // Keep for now, not in spec but useful
   }
   ```

2. **Fix Transaction Sorting** (`src/core/entity.ts:75`)
   - Add `kind` to sort order
   - Consider `from` vs `signerId` naming

3. **Update Frame Hashing** (`src/core/codec.ts`)
   - Remove hardcoded parentHash/proposer
   - Use actual values from frame

### 🟡 MEDIUM Priority (Robustness)

1. **Add Property-Based Tests**
   - Frame hash determinism
   - Transaction ordering invariants
   - Consensus state machine properties

2. **Enhance Byzantine Tests**
   - Double-spend with same nonce
   - Invalid quorum hash attacks
   - Proposer equivocation

3. **Document Architecture Decisions**
   - Why we merged layers
   - Why we keep state in Frame
   - Timestamp type choices

### 🟢 LOW Priority (Polish)

1. **Code Organization**
   - Consider splitting entity.ts (350+ lines)
   - Group related types in types.ts
   - Organize tests by feature

2. **Documentation**
   - Add JSDoc comments to public APIs
   - Create architecture diagrams
   - Usage examples

3. **Performance Benchmarks**
   - Transaction throughput
   - BLS verification speed
   - WAL write performance

## Verification Commands

```bash
# Check for hardcoded values
grep -r "0x0000000000000000000000000000000000000000" src/

# Find console.error calls
grep -r "console\." src/

# Check for type assertions
grep -r " as " src/ | grep -v test

# Find TODO comments
grep -r "TODO" src/

# Check for any types
grep -r ": any" src/
```

## Next Steps

1. Create feature branch for spec compliance fixes
2. Update Frame structure and all dependent code
3. Add comprehensive tests for changes
4. Run full verification suite
5. Document any intentional deviations from spec

---

This checklist provides specific code locations and concrete fixes needed for full specification compliance and code quality verification.
