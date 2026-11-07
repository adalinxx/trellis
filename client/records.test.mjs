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
    { key: "user/alice/repo/r/ref/refs/heads/main", oldValue: JSON.stringify({ commit: cid, seq: 1 }), newValue: JSON.stringify({ commit: next, seq: 1 }) },
  ]);
  assert.deepEqual(await changes(state, records.ref("alice", "r", "refs/heads/main", cid)), [], "no change, no action");
});

const at = (n) => sdk.cidV1DagCbor(sdk.encodeDagCbor({ n }));
const MAIN = "refs/heads/main";

test("a ref is where the maintainers' latest push says", async () => {
  const state = memory([
    ...records.repo("alice", "r", { delegates: ["bob", "carol"] }),
    ["user/alice/repo/r/ref/refs/heads/main", JSON.stringify({ commit: at(1) })], // written before seq: 0
    ...records.ref("alice", "r", MAIN, at(2), { as: "bob", seq: 1 }),
    ...records.ref("alice", "r", MAIN, at(3), { as: "carol", seq: 2 }),
    ...records.ref("alice", "r", "refs/heads/old", at(1), { seq: 1 }),
    ...records.ref("alice", "r", "refs/heads/old", undefined, { as: "bob", seq: 2 }),
    ...records.ref("alice", "r", "refs/heads/x", at(9), { as: "mallory", seq: 99 }),
  ]);
  assert.deepEqual([...(await records.refs(sdk, state, "alice", "r"))], [[MAIN, at(3)]]);
  const words = await records.words(sdk, state, "alice", "r");
  assert.deepEqual(words.get(MAIN), { commit: at(3), seq: 2, by: "carol" });
  assert.deepEqual(words.get("refs/heads/old"), { commit: null, seq: 2, by: "bob" }, "deleted by a delegate");
  assert.equal(words.has("refs/heads/x"), false, "someone the card doesn't name has no say");
});

test("two pushes with one seq: the owner's stands, else the smaller commit", async () => {
  const [low, high] = [at(1), at(2)].sort();
  const two = (a, b) =>
    memory([...records.repo("alice", "r", { delegates: ["bob", "carol"] }), ...records.ref("alice", "r", MAIN, a[1], { as: a[0], seq: 4 }), ...records.ref("alice", "r", MAIN, b[1], { as: b[0], seq: 4 })]);
  assert.equal((await records.refs(sdk, two(["bob", low], ["alice", high]), "alice", "r")).get(MAIN), high);
  assert.equal((await records.refs(sdk, two(["bob", high], ["carol", low]), "alice", "r")).get(MAIN), low);
  assert.equal((await records.refs(sdk, two(["carol", low], ["bob", high]), "alice", "r")).get(MAIN), low);
});

test("a delegate the card drops no longer counts", async () => {
  const state = memory([...records.repo("alice", "r", {}), ...records.ref("alice", "r", MAIN, at(1)), ...records.ref("alice", "r", MAIN, at(2), { as: "bob", seq: 5 })]);
  assert.equal((await records.refs(sdk, state, "alice", "r")).get(MAIN), at(1));
});

test("a seq past the cap counts as the cap, where the owner's word wins", async () => {
  const state = memory([
    ...records.repo("alice", "r", { delegates: ["bob"] }),
    ...records.ref("alice", "r", MAIN, at(1), { as: "bob", seq: Number.MAX_SAFE_INTEGER }),
    ...records.ref("alice", "r", MAIN, at(2), { seq: records.nextSeq(Number.MAX_SAFE_INTEGER) }),
  ]);
  assert.equal(records.nextSeq(Number.MAX_SAFE_INTEGER), records.MAX_SEQ);
  assert.equal((await records.refs(sdk, state, "alice", "r")).get(MAIN), at(2), "the owner can always take a ref back");
});
