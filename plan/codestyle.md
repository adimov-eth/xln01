Below is a focused **upgrade playbook** that raises the repository’s craftsmanship to the founder’s “ruthless simplicity / perfect naming / pure‑function” bar — without inflating scope. It is organised by the levers that have the highest “signal‑per‑line‑of‑code” ratio.

## 1 — Code structure & naming

### Sindre Sorhus‑style naming

- Follow the **TypeScript‑Definition Style Guide** for method/property order, use present‑tense verbs (`execFrame`, `validateCommit`) and remove abbreviations. ([github.com][4])
- Apply the _“10 commandments of naming”_ — names reveal intent, no Hungarian notation, pluralise collections (`pendingTxs`). ([albertobasalo.medium.com][5])

### Receive‑Object → Return‑Object (RO‑RO)

Move every function with > 1 parameter to the RO‑RO pattern; it self‑documents and prevents arity drift. ([medium.com][6], [tinyblog.dev][7])

```ts
export const buildFrame = (
  { entity, mempool, height, proposer }: BuildFrameParams
): BuildFrameResult => { ... }
```

---

## 2 — Functional ergonomics

| Current pain                          | Fix                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Manual deep copies**                | Use shallow spread + pure helper `update<T>(obj, patch): T` so intent is explicit.                           |
| **Verbose `if` ladders** in reducers  | Replace with look‑up table `{ADD_TX: add, PROPOSE: propose, …}[cmd.type]`. Improves linear scan readability. |
| **Magic numbers** (`3 /*threshold*/`) | Extract `const QUORUM_THRESHOLD = 3n` at top‑level config; reflect founder’s “configuration knobs” section.  |

### Quick‑win checklist

| Task                                                     | Δ LoC | Effort | Value                 |
| -------------------------------------------------------- | ----- | ------ | --------------------- |
| Prettier + ESLint config                                 | —     | 15 m   | Consistent style      |
| Rename `sigMap` → `signatures`, `rep.last` → `lastFrame` | —     | 10 m   | Intent clarity        |
| RORO refactor of `applyCommand` helpers                  | ±20   | 1 h    | Self‑documenting APIs |
| Add snapshot test for “single tick happy path”           | +30   | 30 m   | Regression guard      |

## Unified TypeScript Code‑Style Guide

\*A synthesis of Sindre Sorhus’s **TypeScript Definition Style Guide**, Alberto Basalo’s “**10 Commandments to Naming and Writing Clean Code with TypeScript**”, and TinyBlog’s article on the **RORO (Receive‑Object / Return‑Object) pattern\***

---

### 0 ‒ Core Principles

| Principle                              | Rationale                                                                                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Clarity first**                      | Names, types and function signatures must reveal intent with minimal cognitive load. ([albertobasalo.medium.com][1])                            |
| **Explicit > implicit**                | Prefer explicit imports, readonly qualifiers and named parameters over “magic”. ([github.com][2], [tinyblog.dev][3])                            |
| **Latest TypeScript, functional bias** | Target the current TS release, leverage `unknown`, `readonly`, and avoid namespaces or ambient globals. ([github.com][2])                       |
| **Self‑documenting code**              | Clean naming + TSDoc eliminate most comments; comments are reserved for API docs and warnings. ([albertobasalo.medium.com][1], [github.com][2]) |

---

### 1 ‒ Formatting & Linting

| Rule                                                                                     | Example              |
| ---------------------------------------------------------------------------------------- | -------------------- |
| **Tab indentation; always semicolons.** ([github.com][2])                                | `const answer = 42;` |
| 120 col soft‑wrap; never hard‑wrap TSDoc. ([github.com][2])                              |                      |
| Array shorthand & `readonly` syntax (`number[]`, `readonly number[]`). ([github.com][2]) |                      |
| `import {foo}` not `{ foo }`; destructuring follows the same rule. ([github.com][2])     |                      |

**Tooling**

- Configure **Prettier** for tabs + semicolons and **ESLint** (`@typescript-eslint`) to flag violations.

---

### 2 ‒ Naming Conventions (The “Ten Commandments”)

1. **Be descriptive** – `imageWidth` over `width`.
2. **Be meaningful / consistent** – one concept, one word.
3. **Spell properly** – readable, searchable names.
4. **Follow TS community casing**
   - `camelCase` variables & functions
   - `PascalCase` types, classes, enums
   - UPPER_SNAKE constants
   - Never prefix interfaces with `I`.

5. **Functions start with verbs** – `createClient`, `isAllowed`.
6. **Prefer positive booleans** – `hasValue`, not `isNotEmpty`.
7. **No magic numbers** – lift to well‑named `const`s.
8. **No tech encodings** – surface intent, hide implementation.
9. **No mental mapping / abbreviations** – `customers`, not `cs`.
10. **No explanatory comments** – code + names should suffice; keep only API/TODO/warning comments. ([albertobasalo.medium.com][1])

---

### 3 ‒ Type Design & Declaration Files

| Guideline                                                                                   | Notes |
| ------------------------------------------------------------------------------------------- | ----- |
| Add `"types"` field after official keys in `package.json`; never `"typings"`.               |       |
| Prefer **`unknown`** to `any`; never `object` or `Function`.                                |       |
| Generic parameters receive meaningful names (`Element`, `NewElement`).                      |       |
| Export default functions as `export default function foo…`; avoid `namespace`.              |       |
| Accept/return **immutable snapshots** – mark option objects and return types as `readonly`. |       |

---

### 4 ‒ Function Signatures (RORO Pattern)

| Receive‑Object                                                                                              | Return‑Object                                                                  |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Functions take a single **options object** and immediately destructure → self‑documenting named parameters. | Return an object when more than one datum is needed; destructure at call‑site. |
| Eliminates positional boolean/number ambiguity.                                                             | Enables multi‑value returns without tuples.                                    |

```ts
export async function getItem(
  {id, collectionName}: {id: number; collectionName: string},
): Promise<{item: Item; wasCached: boolean}> { … }
```

---

### 5 ‒ Documentation (TSDoc)

We skip TSDoc and comments for now in favor of reducing visual noise.

---

### 9 ‒ Adoption Checklist

1. **Tooling**
   - Add Prettier + ESLint configs enforcing tabs & semicolons.

2. **Refactor** existing functions to RORO signature; migrate positional booleans.

3. **Rename** variables/functions violating the Ten Commandments (scriptable via eslint‑fix).

> **Outcome:** a cleaner, self‑describing TypeScript codebase with enforceable, automated guarantees on formatting, naming, typing and documentation.
