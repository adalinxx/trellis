import assert from "node:assert/strict";
import { test } from "node:test";
import { get, list } from "./state.mjs";

// A trie by hand: under "k/", 16 × 16 leaves "k/<x><y>", each node one fetch
// that takes `delay` ms, as reading from a node over the network does.
const hex = [..."0123456789abcdef"];
function trie(delay) {
  const nodes = new Map();
  const put = (cid, node) => (nodes.set(cid, node), { key: node.prefix[0], value: { rawCID: cid } });
  const level1 = hex.map((x) =>
    put(`n-${x}`, { prefix: x, children: [...hex].reverse().map((y) => put(`n-${x}${y}`, { prefix: y, value: `v${x}${y}`, children: [] })) }),
  );
  nodes.set("root", { children: [put("n-k", { prefix: "k/", children: level1 })] });
  let fetches = 0;
  const load = async (cid) => {
    fetches++;
    await new Promise((resolve) => setTimeout(resolve, delay));
    return { node: nodes.get(cid), volume: undefined };
  };
  return { load, fetches: () => fetches };
}

test("a listing is in key order, and takes as many round trips as the trie is deep", async () => {
  const delay = 50;
  const { load, fetches } = trie(delay);
  const started = Date.now();
  const out = [];
  for await (const entry of list(load, "root", "k/")) out.push(entry);
  const elapsed = Date.now() - started;
  assert.deepEqual(out, hex.flatMap((x) => hex.map((y) => [`k/${x}${y}`, `v${x}${y}`])));
  assert.equal(fetches(), 2 + 16 + 256);
  // Root, "k/", then two levels: 4 round trips. Walking them in key order took 19.
  assert.ok(elapsed < 8 * delay, `took ${elapsed} ms`);
  assert.equal(await get(load, "root", "k/3c"), "v3c");
  assert.equal(await get(load, "root", "k/3"), undefined);
});
