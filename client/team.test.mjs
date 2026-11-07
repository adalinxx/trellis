import assert from "node:assert/strict";
import { test } from "node:test";
import * as sdk from "../vendor/lattice-sdk.js";
import * as records from "./records.mjs";
import { delegation } from "./team.mjs";

const at = (n) => sdk.cidV1DagCbor(sdk.encodeDagCbor({ n }));
const memory = (entries) => {
  const map = new Map(entries);
  return {
    get: async (key) => map.get(key),
    async *list(prefix) {
      for (const key of [...map.keys()].sort()) if (key.startsWith(prefix)) yield [key, map.get(key)];
    },
  };
};

test("dropping a delegate leaves every ref where it stood", async () => {
  const card = { description: "d", delegates: ["bob", "carol"] };
  const before = [
    ...records.repo("alice", "r", card),
    ...records.ref("alice", "r", "refs/heads/main", at(1), { seq: 1 }),
    ...records.ref("alice", "r", "refs/heads/main", at(2), { as: "bob", seq: 2 }),
    ...records.ref("alice", "r", "refs/heads/dev", at(3), { as: "carol", seq: 1 }),
    ...records.ref("alice", "r", "refs/heads/gone", undefined, { as: "bob", seq: 3 }),
  ];
  const state = memory(before);
  const was = await records.refs(sdk, state, "alice", "r");
  const writes = delegation("alice", "r", card, await records.words(sdk, state, "alice", "r"), ["carol"]);
  const after = memory([...before, ...writes]);
  assert.deepEqual(await records.card(after, "alice", "r"), { description: "d", delegates: ["carol"] });
  assert.deepEqual([...(await records.refs(sdk, after, "alice", "r"))].sort(), [...was].sort());
  const words = await records.words(sdk, after, "alice", "r");
  assert.equal(words.get("refs/heads/main").by, "alice");
  assert.equal(words.get("refs/heads/dev").by, "carol", "carol's push still stands");
  assert.equal(words.get("refs/heads/gone").commit, null, "a deleted ref stays deleted");
});
