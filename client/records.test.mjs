import assert from "node:assert/strict";
import { test } from "node:test";
import * as sdk from "../vendor/lattice-sdk.js";
import * as records from "./records.mjs";
import { changes } from "./write.mjs";

/** An in-memory state view, as client/state.mjs gives one. */
const memory = (entries) => {
  const map = new Map(entries);
  return {
    get: async (key) => map.get(key),
    async *list(prefix) {
      for (const key of [...map.keys()].sort()) if (key.startsWith(prefix)) yield [key, map.get(key)];
    },
  };
};

const cid = sdk.cidV1DagCbor(sdk.encodeDagCbor({ a: 1 }));

test("keys name their owner where the policy looks", () => {
  assert.equal(records.cardKey("alice", "trellis"), "user/alice/repo/trellis");
  assert.equal(records.refKey("alice", "trellis", "refs/heads/main"), "user/alice/repo/trellis/ref/refs/heads/main");
  assert.equal(records.listingKey("trellis", "alice"), "index/repo/trellis/alice");
});

test("names and refs git wouldn't take are refused", () => {
  for (const name of ["", "a/b", ".hidden", "x.lock", "a b", "x".repeat(101)]) assert.throws(() => records.checkName(name));
  for (const ref of ["main", "refs/heads/", "refs/heads/a..b", "refs/heads/.x", "refs/heads/a.lock", "refs/heads/a b", "refs/heads/a@{1}", "refs/heads/a."]) {
    assert.throws(() => records.checkRef(ref), ref);
  }
  assert.equal(records.checkRef("refs/heads/feature/x-1"), "refs/heads/feature/x-1");
});

test("refs read back; values that don't parse are skipped", async () => {
  const state = memory([
    [records.cardKey("alice", "r"), '{"description":"d"}'],
    ...records.ref("alice", "r", "refs/heads/main", cid),
    ["user/alice/repo/r/ref/refs/heads/bad", "not json"],
    ["user/alice/repo/r/ref/refs/heads/nocid", '{"commit":"nope"}'],
    ...records.ref("alice", "r2", "refs/heads/main", cid),
  ]);
  assert.deepEqual(await records.card(state, "alice", "r"), { description: "d" });
  assert.deepEqual([...(await records.refs(sdk, state, "alice", "r"))], [["refs/heads/main", cid]]);
});

test("owners are listed by name", async () => {
  const state = memory([...records.repo("alice", "r"), ...records.repo("bob", "r"), ...records.repo("carol", "other")]);
  assert.deepEqual(await records.owners(state, "r"), ["alice", "bob"]);
});

test("a change is made against what the key holds", async () => {
  const state = memory(records.ref("alice", "r", "refs/heads/main", cid));
  const next = sdk.cidV1DagCbor(sdk.encodeDagCbor({ a: 2 }));
  assert.deepEqual(await changes(state, records.ref("alice", "r", "refs/heads/main", next)), [
    { key: "user/alice/repo/r/ref/refs/heads/main", oldValue: JSON.stringify({ commit: cid }), newValue: JSON.stringify({ commit: next }) },
  ]);
  assert.deepEqual(await changes(state, records.ref("alice", "r", "refs/heads/main", cid)), [], "no change, no action");
  assert.deepEqual(await changes(state, records.ref("alice", "r", "refs/heads/gone", undefined)), []);
});
