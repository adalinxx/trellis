// Runs the built policy module the way the Lattice host does: allocate with
// `lattice_alloc`, write the canonical context, call the entrypoint. Bodies
// are encoded by the SDK, whose encoding is pinned to Lattice's vectors.
//
//   cargo build --release --target wasm32-unknown-unknown
//   LATTICE_SDK_CORE=<lattice-sdk>/packages/core/dist/index.js node --test test/policy.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

const { encodeTransactionBody } = await import(process.env.LATTICE_SDK_CORE);
const module = new WebAssembly.Module(
  readFileSync(
    new URL("../target/wasm32-unknown-unknown/release/trellis_policy.wasm", import.meta.url),
  ),
);

const ALICE = "alice-address";
const BOB = "bob-address";
const PATH = ["Nexus", "trellis"];

function u32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function context(bodyBytes, { version = 2 } = {}) {
  const text = new TextEncoder();
  const parts = [
    text.encode("LWPCTX"),
    Uint8Array.of(0, version, 0, 1, 0), // encoding version, ABI version, transaction scope
    new Uint8Array(16), // height, timestamp
    u32(3),
    Uint8Array.of(0xa0, 0xa0, 0xa0), // stand-in chain spec bytes; the policy skips them
    u32(PATH.length),
    ...PATH.flatMap((segment) => [u32(text.encode(segment).length), text.encode(segment)]),
  ];
  if (bodyBytes === undefined) parts.push(Uint8Array.of(0));
  else parts.push(Uint8Array.of(1), u32(bodyBytes.length), bodyBytes);
  parts.push(Uint8Array.of(0, 0)); // no action, no action index
  return Uint8Array.from(parts.flatMap((part) => [...part]));
}

// With CONTEXT_DIR set, every context is recorded with its verdict so
// host-check can replay it through Lattice's own evaluator.
const contextDirectory = process.env.CONTEXT_DIR;
if (contextDirectory) mkdirSync(contextDirectory, { recursive: true });
let recorded = 0;

function run(bytes) {
  const { exports } = new WebAssembly.Instance(module);
  const pointer = exports.lattice_alloc(bytes.length);
  new Uint8Array(exports.memory.buffer).set(bytes, pointer);
  const accepted = exports.lattice_validate_transaction(pointer, bytes.length) === 1;
  if (contextDirectory) {
    const name = `${String(recorded++).padStart(3, "0")}-${accepted ? "accept" : "reject"}.bin`;
    writeFileSync(`${contextDirectory}/${name}`, bytes);
  }
  return accepted;
}

function body(actions, signers = [ALICE], extra = {}) {
  return encodeTransactionBody({
    accountActions: [],
    actions,
    depositActions: [],
    receiptActions: [],
    withdrawalActions: [],
    signers,
    nonce: 7n,
    chainPath: PATH,
    ...extra,
  }).bytes;
}

const accepts = (actions, signers, extra) => run(context(body(actions, signers, extra)));

test("an author writes, edits and deletes their own records", () => {
  assert.ok(accepts([{ key: `user/${ALICE}/crm/7f3a`, newValue: "hello" }]));
  assert.ok(accepts([{ key: `user/${ALICE}/crm/7f3a`, oldValue: "hello", newValue: "hello, world" }]));
  assert.ok(accepts([{ key: `user/${ALICE}/crm/7f3a`, oldValue: "hello, world" }]));
  assert.ok(accepts([{ key: `user/${ALICE}/crm/b21c`, newValue: "ciphertext" }]));
  assert.ok(accepts([{ key: `user/${ALICE}`, newValue: "x" }]));
  assert.ok(accepts([{ key: `user/${ALICE}/anything/a/client/invents`, newValue: "x" }]));
});

test("nobody writes or deletes another author's records", () => {
  assert.ok(!accepts([{ key: `user/${BOB}/crm/7f3a`, newValue: "forged" }]));
  assert.ok(!accepts([{ key: `user/${BOB}/crm/7f3a`, oldValue: "hello" }]));
  assert.ok(!accepts([{ key: `user/${BOB}/crm/b21c`, newValue: "ciphertext" }]));
  // Naming yourself later in someone else's namespace does not make it yours.
  assert.ok(!accepts([{ key: `user/${BOB}/${ALICE}`, newValue: "x" }]));
  // One bad action rejects the whole transaction.
  assert.ok(
    !accepts([
      { key: `user/${ALICE}/crm/7f3a`, newValue: "mine" },
      { key: `user/${BOB}/crm/7f3a`, newValue: "not mine" },
    ]),
  );
});

test("an index entry belongs to the writer named in its last segment", () => {
  assert.ok(
    accepts([
      { key: `user/${ALICE}/crm/7f3a`, newValue: "1" },
      { key: `index/topic/${BOB}/${ALICE}`, newValue: "1" },
      { key: `index/other/${BOB}/1/${ALICE}`, newValue: "1" },
      { key: `index/a/deeper/topic/${ALICE}`, newValue: "1" },
    ]),
  );
  assert.ok(!accepts([{ key: `index/topic/${ALICE}/${BOB}`, newValue: "1" }]));
  assert.ok(!accepts([{ key: `index/other/${ALICE}/1/${BOB}`, oldValue: "1" }]));
  // An index key needs a topic as well as an owner.
  assert.ok(!accepts([{ key: `index/${ALICE}`, newValue: "1" }]));
  assert.ok(!accepts([{ key: "index", newValue: "1" }]));
});

test("any one of several signers may own a key", () => {
  assert.ok(accepts([{ key: `user/${BOB}/crm/7f3a`, newValue: "hi" }], [ALICE, BOB]));
});

test("keys outside the two shapes are rejected", () => {
  for (const key of [ALICE, `${ALICE}/crm/7f3a`, `crm/${ALICE}/1`, "user", "user/", `users/${ALICE}`, `/user/${ALICE}`]) {
    assert.ok(!accepts([{ key, newValue: "x" }]), key);
  }
});

test("the policy puts no limit on key or value size", () => {
  assert.ok(accepts([{ key: `user/${ALICE}/${"i".repeat(5000)}`, newValue: "x".repeat(200000) }]));
});

test("coin actions pass untouched", () => {
  assert.ok(accepts([]));
  assert.ok(
    accepts([], [ALICE], {
      accountActions: [
        { owner: ALICE, delta: -1000n },
        { owner: BOB, delta: 998n },
      ],
      depositActions: [{ nonce: 1n, demander: ALICE, amountDemanded: 5n, amountDeposited: 5n }],
    }),
  );
});

test("a malformed or unknown context is rejected", () => {
  const good = body([{ key: `user/${ALICE}/crm/7f3a`, newValue: "hello" }]);
  assert.ok(run(context(good)));
  assert.ok(!run(context(good, { version: 1 })));
  assert.ok(!run(context(undefined)));
  assert.ok(!run(context(good.slice(0, good.length - 3))));
  assert.ok(!run(context(good).slice(0, 40)));
  assert.ok(!run(new Uint8Array(0)));
});
