Below is a **step‑by‑step action plan** to raise the codebase to production‑grade quality while preserving its lean PoC footprint.  Each action is mapped to concrete pay‑offs and anchored to the canonical XLN‑RC2 spec passages so the founder sees a direct line from requirement → improvement.

---

## 1 — Make “pure‑core / effect‑shell” visually obvious

### 1.1 Restructure folders

| New folder | What lives there                                                                | Rationale                                    |
| ---------- | ------------------------------------------------------------------------------- | -------------------------------------------- |
| `core/`    | **100 % pure** reducers & helpers (`entity.ts`, `server.ts`, `inputCascade.ts`) | Mirrors spec’s “pure function” rule §2       |
| `infra/`   | Time, key‑store, random‑bytes, LevelDB stubs                                    | Isolates impurities; simplifies unit‑testing |
| `cli/`     | Thin `bun` entry points (`simulate.ts`, `replay.ts`)                            | Keeps scripts from leaking into library code |

> **Outcome:** newcomers see at a glance where they can refactor without fear of hidden side‑effects.

---

## 2 — Enforce style & safety gates

### 2.1 Opinionated toolchain

* **Prettier** (`--single-quote --print-width 100`) runs on *every* commit.
* **ESLint** with

  * `eslint-plugin-fp` → no mutation / classes,
  * `@typescript-eslint/recommended-requiring-type-checking` → strict async/await,
  * `functional/immutable-data` → compile‑time purity.

### 2.2 Strict `tsconfig`

```jsonc
{
  "compilerOptions": {
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "noPropertyAccessFromIndexSignature": true,
    "useDefineForClassFields": true
  }
}
```

These flags stop silent `undefined` traps and keep the reducer signatures identical on every node—aligning with replay determinism §6.

---

## 3 — Express intent through naming & RO‑RO pattern

* Rename cryptic fields: `rep.last` → `lastFrame`, `sigMap` → `signatures`.
* Convert any function with > 1 param to **Receive‑Object → Return‑Object**; e.g.

```ts
export const proposeFrame = (
  { state, mempool, proposer }: ProposeParams
): ProposeResult => { … }
```

This echoes the spec’s reducer signature `(prevState, batch) → { nextState, outbox }` §2 and makes call‑sites read like prose.

---

## 4 — Strengthen consensus‑critical code paths

### 4.1 Centralise validation helpers

Move the new `validateCommit()` (added in last patch) to `core/validator.ts`; export three pure predicates:

```ts
isSequentialHeight(prev, frame)
isValidPostState(prevStateRoot, frame)
hasQuorumSignature(frame, hanko, quorum)
```

Now each reducer branch composes the checks declaratively, and the founder can audit invariants in one file.

### 4.2 Snapshot tests as executable spec

* **Jest/Vitest** snapshot for “happy path” tick timeline:
  `ADD_TX → PROPOSE → SIGN → COMMIT → identical Merkle root`.
* Another snapshot for “replica lags one tick”; ensure no commit when hash mismatch triggers refusal (spec §5‑SIGN).

Running `bun test` before merge proves safety/liveness haven’t regressed.

---

## 5 — Observability & debuggability

### 5.1 Structured logging

Introduce tiny helper:

```ts
export const log = (label: string, data: unknown) =>
  console.log(JSON.stringify({ ts: Date.now(), label, ...data }));
```

Emit **one** log line per consensus event; use `label` = `"ADD_TX" | "PROPOSE" | "SIGN" | "COMMIT"`.
This aligns with the spec’s “Clock‑tick walk‑through” §13 and gives founders a replayable JSON trace.

### 5.2 Hex‑encoded state root diff

After every tick the server already publishes `ServerFrame.root`.
Print a SHA‑256 of each replica’s mempool length + state height; any divergence pops out visually without dumping megabytes.

---

## 6 — Continuous integration

| Job                | Trigger      | Key steps                                             |
| ------------------ | ------------ | ----------------------------------------------------- |
| **`lint-test`**    | PR open/push | `bun install`, `eslint .`, `bun test`                 |
| **`size-watch`**   | PR open/push | Fail if `core/` bundle > 40 kB (guards against bloat) |
| **`format-check`** | PR open/push | `prettier --check .`                                  |

All three run in \~20 s using GitHub Actions cache; red X stops low‑quality merges.

---

## 7 — Documentation the founder wants to read

### 7.1 ONE svg

Replicate the spec’s Figure 1 flow (Input → ServerInput → EntityInput → Frame) in `docs/flow.svg`.
Keep nodes labelled with exact type names used in `core/`.
Founders scan images first; this answers “what talks to what” instantly.

### 7.2 README quick‑start

```
bun install
bun run cli/simulate.ts        # 4‑tick happy path
bun run cli/replay.ts walk.log # replay WAL, assert roots
```

Shows reproducibility—the spec’s *audit‑grade replay* promise §6.

---

## 8 — Future‑proof, but don’t overbuild

* **Feature flags** (`DEV_SKIP_SIGS`, `DEV_FAST_TICK_MS`) live in `config.ts`; founder can flip to prod defaults in one file.
* **TODO stubs** for Phase‑2 channels: export empty types, but keep `accountInputs` typed so compiler protects us when channels land §12.

---

## 9 — 90‑day milestone grid

| Week  | Deliverable                              | Acceptance test                       |
| ----- | ---------------------------------------- | ------------------------------------- |
| 1     | Folder & naming refactor                 | CI green, no functional diff          |
| 2     | Prettier + ESLint + strict TS            | Commit hook running locally           |
| 3     | Snapshot tests & log formatter           | `bun test` shows 4 passing specs      |
| 4     | Structured logging to JSON               | Founder sees single‑line JSON trace   |
| 5‑6   | Documentation (SVG + README)             | Founder signs off on diagram accuracy |
| 7     | CI in GitHub Actions                     | Red X on lint fail                    |
| 8     | Size‑watch, RO‑RO refactor finalised     | `core` bundle < 40 kB                 |
| 9     | Performance smoke (tick ≤10 ms @ 1 k tx) | Bench script prints OK                |
| 10‑12 | Hardening (full BLS verify, error codes) | Spec regression tests still pass      |

---

### Closing note

None of the above adds new protocol complexity.  They **clarify, guard, and document** what is already there, matching the founder’s philosophy: *“code explains itself through naming and structure.”*  Twelve weeks of disciplined polish converts the PoC into a codebase that feels **production‑ready** while staying just as lean.
