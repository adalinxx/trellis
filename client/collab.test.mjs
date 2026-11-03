import assert from "node:assert/strict";
import { test } from "node:test";
import * as collab from "./collab.mjs";

/** A state view over a Map, as state.mjs gives one. */
function memory(writes = []) {
  const map = new Map();
  const apply = (list) => list.forEach(([k, v]) => (v === undefined ? map.delete(k) : map.set(k, v)));
  apply(writes);
  return {
    apply,
    get: async (key) => map.get(key),
    async *list(prefix) {
      for (const key of [...map.keys()].sort()) if (key.startsWith(prefix)) yield [key, map.get(key)];
    },
  };
}

const id = (n) => n.toString(16).padStart(16, "0");

test("an issue and a pull request, listed under their repo, newest first", async () => {
  const state = memory([
    ...collab.issue("bob", id(1), { repo: "carol/garden", title: "Weeds", body: "Too many.", time: 10 }),
    ...collab.issue("dave", id(2), { repo: "carol/garden", title: "Shade", body: "", time: 20, head: "dave/garden:fix", base: "main" }),
    // Another repo's, and records that aren't issues.
    ...collab.issue("bob", id(3), { repo: "carol/other", title: "Elsewhere", body: "", time: 30 }),
    [`index/issue/carol/garden/${id(4)}/eve`, "1"],
    [`user/eve/issue/${id(4)}`, JSON.stringify({ repo: "carol/garden", title: "", time: 1 })],
    [`index/issue/carol/garden/${id(5)}/mallory`, "1"],
    [`user/mallory/issue/${id(5)}`, JSON.stringify({ repo: "carol/other", title: "Moved", time: 1 })],
  ]);
  const listed = await collab.issues(state, "carol", "garden", {});
  assert.deepEqual(listed.map((i) => i.title), ["Shade", "Weeds"]);
  assert.equal(listed[0].head, "dave/garden:fix");
  assert.deepEqual(collab.headOf(listed[0].head), { owner: "dave", name: "garden", branch: "fix" });
  assert.equal(listed[1].state, "open");
  assert.deepEqual(listed[1].labels, []);
  assert.equal((await collab.oneIssue(state, "carol", "garden", {}, "bob", id(1))).body, "Too many.");
  assert.equal(await collab.oneIssue(state, "carol", "garden", {}, "bob", id(3)), undefined, "on another repo");
});

test("state and labels: the latest word of the author or a maintainer; nobody else's counts", async () => {
  const card = { delegates: ["dana"] };
  const state = memory(collab.issue("bob", id(1), { repo: "carol/garden", title: "Weeds", body: "", time: 10 }));
  const one = () => collab.oneIssue(state, "carol", "garden", card, "bob", id(1));
  // A stranger's triage is ignored.
  state.apply(collab.triage("mallory", "carol", "garden", "bob", id(1), { state: "closed", labels: ["spam"], time: 50 }));
  assert.equal((await one()).state, "open");
  assert.deepEqual((await one()).labels, []);
  // The owner labels and closes it.
  state.apply(collab.triage("carol", "carol", "garden", "bob", id(1), { state: "closed", labels: ["bug", "garden"], time: 20 }));
  assert.equal((await one()).state, "closed");
  assert.equal((await one()).closedBy, "carol");
  assert.deepEqual((await one()).labels, ["bug", "garden"]);
  // The author reopens it later.
  state.apply(collab.issue("bob", id(1), { repo: "carol/garden", title: "Weeds", body: "", time: 10, state: "open", updated: 30 }));
  assert.equal((await one()).state, "open");
  // A delegate's later word counts; the owner's earlier labels stay until relabelled.
  state.apply(collab.triage("dana", "carol", "garden", "bob", id(1), { state: "closed", time: 40 }));
  assert.equal((await one()).state, "closed");
  assert.deepEqual((await one()).labels, ["bug", "garden"]);
  state.apply(collab.triage("dana", "carol", "garden", "bob", id(1), { state: "closed", labels: [], time: 41 }));
  assert.deepEqual((await one()).labels, []);
  // Without dana among the delegates, only the owner's word and the author's.
  assert.equal((await collab.oneIssue(state, "carol", "garden", {}, "bob", id(1))).state, "open");
});

test("comments and line reviews on an issue, oldest first; others' are not theirs", async () => {
  const on = `dave/${id(2)}`;
  const state = memory([
    ...collab.post("carol", id(11), { on, body: "Second", time: 20 }),
    ...collab.post("bob", id(10), { on, body: "First", time: 10, review: { commit: "bafyc", path: "src/a.c", line: 3, side: "new" } }),
    ...collab.post("bob", id(12), { on: `dave/${id(9)}`, body: "Elsewhere", time: 5 }),
    [`index/post/dave/${id(2)}/${id(13)}/eve`, "1"],
    [`user/eve/post/${id(13)}`, JSON.stringify({ on: `dave/${id(9)}`, body: "claims to be here", time: 1 })],
    [`index/post/dave/${id(2)}/${id(14)}/eve`, "1"],
    [`user/eve/post/${id(14)}`, JSON.stringify({ on, body: "bad review", time: 1, review: { commit: "c", path: "a", line: 0, side: "new" } })],
  ]);
  const listed = await collab.posts(state, "dave", id(2));
  assert.deepEqual(listed.map((p) => `${p.by}: ${p.body}`), ["bob: First", "carol: Second"]);
  assert.deepEqual(listed[0].review, { commit: "bafyc", path: "src/a.c", line: 3, side: "new" });
});

test("releases: a maintainer's, the owner's first", async () => {
  const card = { delegates: ["dana"] };
  const state = memory([
    ...collab.release("dana", "garden", "v1.0", { notes: "dana's", time: 30 }),
    ...collab.release("carol", "garden", "v1.0", { title: "First harvest", notes: "carol's", time: 20 }),
    ...collab.release("dana", "garden", "v2.0", { notes: "only dana", time: 40 }),
    ...collab.release("mallory", "garden", "v3.0", { notes: "not a maintainer", time: 50 }),
  ]);
  const out = await collab.releases(state, "carol", "garden", card);
  assert.deepEqual([...out.keys()].sort(), ["v1.0", "v2.0"]);
  assert.equal(out.get("v1.0").notes, "carol's");
  assert.equal(out.get("v2.0").by, "dana");
});

test("labels as typed", () => {
  assert.deepEqual(collab.labelsOf(" bug, good first issue ,bug,, "), ["bug", "good first issue"]);
  assert.match(collab.newId(), /^[0-9a-f]{16}$/);
});
