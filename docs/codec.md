Below is a **concise implementation brief** for wiring **`msgpackr`** into the XLN persistence layer while preserving XLN’s functional/TypeScript‑first style and deterministic hashes.

---

## 1 · Install & Import

```bash
bun add msgpackr           # or: npm i msgpackr
```

```ts
import { pack, unpack } from "msgpackr"; // simple API
// or use the configurable encoder/decoder class:
import { Packr } from "msgpackr";
```

`pack(value)` returns a `Uint8Array`; `unpack(buf)` restores the object. Basic usage is one‑line and works equally in Node, Bun and modern browsers. ([GitHub][1])

---

## 2 · Create a Re‑usable Encoder Instance

```ts
// codecs/msgpack.ts
import { Packr } from "msgpackr";

export const codec = new Packr({
  // 1️⃣ Enable record extension for >2× speed + 15‑50 % smaller payloads
  useRecords: true, // default is already true
  // 2️⃣ Guarantee stable key order for hashing by encoding records, not maps
  //    (maps are fine for storage, but array/record tuples are safest for Merkle roots)
  // 3️⃣ Make output Bun/Browser compatible – Packr is pure ESM
});

/** Serialize any XLN domain object */
export const encode = <T>(value: T) => codec.pack(value);

/** Deserialize and cast */
export const decode = <T = unknown>(buf: Uint8Array) => codec.unpack(buf) as T;
```

_Why `Packr`?_ It lets you keep and share a **structure table** across frames so repeated objects compress even further; and you can persist that table alongside data to decode later. ([GitHub][1], [GitHub][1])

---

## 3 · Persisting Frames & State

```ts
// persistence/level.ts
import { encode, decode } from "../codecs/msgpack";
import level from "abstract-level";

const db = level<string, Uint8Array>("./data/xln", {
  keyEncoding: "utf8",
  valueEncoding: "view",
});

export const saveState = async (
  entityId: string,
  height: number,
  state: EntityState
) => db.put(`${entityId}:${height}`, encode(state));

export const loadState = async (entityId: string, height: number) => {
  const buf = await db.get(`${entityId}:${height}`).catch(() => undefined);
  return buf ? decode<EntityState>(buf) : undefined;
};
```

_Binary blobs_ are now **deterministic** (see §4) and safe to hash or store as LevelDB values.

---

## 4 · Determinism Checklist

MessagePack maps do **not** define key order, which can break hash‑equality across platforms. `msgpackr` resolves this by:

1. **Record extension** – Encodes objects as **field‑numbered tuples** rather than maps, guaranteeing byte‑exact output across runtimes. ([GitHub][1])
2. **Shared structure table** – When persisting to disk, also persist `packr.structures` so every process decodes with identical field indexes. ([GitHub][1])
3. **Avoid plain JS maps for hashing** – If you must hash arbitrary maps, sort keys first or convert to array entries. (See the long‑standing ordering issue in the MessagePack spec discussion.) ([GitHub][2])

With these three rules, `pack(state)` will always produce the same bytes for the same logical state → stable Merkle roots.

---
