import assert from "node:assert/strict";
import { test } from "node:test";
import * as sdk from "../vendor/lattice-sdk.js";
import { boxKeys } from "./seal.mjs";
import { members, newPrivate, redeal, repoSealer } from "./private.mjs";

const keyOf = (n) => new Uint8Array(32).fill(n);
const box = (n) => boxKeys(keyOf(n)).publicKey;
const people = { olga: 1, bob: 2, carol: 3 };
const boxes = async (a) => box(people[a]);
const block = sdk.encodeDagCbor({ entries: [] });
const sealedBy = (s) => s.seal(sdk, [{ cid: sdk.cidV1DagCbor(block), entries: { [sdk.cidV1DagCbor(block)]: Buffer.from(block).toString("base64") } }])[0];
const opens = (s, v) => s.open(sdk, v.cid, new Uint8Array(Buffer.from(v.entries[v.cid], "base64")));

test("members get the repo's keys; a dropped one is left out of the next", async () => {
  const card1 = { private: newPrivate("olga", "r", box(1)) };
  const olga1 = repoSealer("olga", "r", card1, "olga", keyOf(1));
  const old = sealedBy(olga1);
  assert.throws(() => repoSealer("olga", "r", card1, "bob", keyOf(2)), /isn't one of its members/);

  const card2 = await redeal("olga", "r", card1, { ...card1, delegates: ["bob"], readers: ["carol"] }, "olga", keyOf(1), boxes);
  assert.deepEqual(members("olga", card2), ["olga", "bob", "carol"]);
  assert.equal(opens(repoSealer("olga", "r", card2, "carol", keyOf(3)), old).cid, sdk.cidV1DagCbor(block), "a reader reads old blocks");

  const card3 = await redeal("olga", "r", card2, { ...card2, readers: [] }, "bob", keyOf(2), boxes);
  assert.equal(card3.private.keys.length, 2, "a new key version");
  assert.throws(() => repoSealer("olga", "r", card3, "carol", keyOf(3)), /one of its members/);
  const bob3 = repoSealer("olga", "r", card3, "bob", keyOf(2));
  const fresh = sealedBy(bob3);
  assert.notEqual(fresh.cid, old.cid, "sealed with the new key");
  assert.equal(opens(repoSealer("olga", "r", card3, "olga", keyOf(1)), fresh).cid, sdk.cidV1DagCbor(block));
  assert.equal(opens(bob3, old).cid, sdk.cidV1DagCbor(block), "history stays readable to members");
});
