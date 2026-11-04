import assert from "node:assert/strict";
import { test } from "node:test";
import * as collab from "./collab.mjs";
import { githubId, githubRecords, githubRepo } from "./github.mjs";

function memory(writes) {
  const map = new Map();
  for (const [k, v] of writes) v === undefined ? map.delete(k) : map.set(k, v);
  return {
    get: async (key) => map.get(key),
    async *list(prefix) {
      for (const key of [...map.keys()].sort()) if (key.startsWith(prefix)) yield [key, map.get(key)];
    },
  };
}

const URL = "https://github.com/acme/rocket";
const items = [
  { number: 1, html_url: `${URL}/issues/1`, title: "It explodes", body: "On **launch**.", user: { login: "wile" }, state: "closed", created_at: "2024-01-01T00:00:00Z", closed_at: "2024-01-03T00:00:00Z", labels: [{ name: "bug" }, { name: "bad,label" }] },
  { number: 2, html_url: `${URL}/pull/2`, title: "Add fins", body: null, user: null, state: "closed", created_at: "2024-01-02T00:00:00Z", closed_at: "2024-01-04T00:00:00Z", labels: [], pull_request: { merged_at: "2024-01-04T00:00:00Z" } },
  { number: 3, html_url: `${URL}/issues/3`, title: "Paint it red", body: "", user: { login: "road" }, state: "open", created_at: "2024-01-05T00:00:00Z", labels: ["idea"] },
];
const comments = [
  { html_url: `${URL}/issues/1#issuecomment-10`, issue_url: "https://api.github.com/repos/acme/rocket/issues/1", user: { login: "road" }, body: "Meep meep.", created_at: "2024-01-02T00:00:00Z" },
  { html_url: `${URL}/pull/2#issuecomment-11`, issue_url: "https://api.github.com/repos/acme/rocket/issues/2", user: { login: "wile" }, body: "Ship it", created_at: "2024-01-03T00:00:00Z" },
  { html_url: `${URL}/issues/9#issuecomment-12`, issue_url: "https://api.github.com/repos/acme/rocket/issues/9", user: { login: "x" }, body: "On an issue not imported", created_at: "2024-01-03T00:00:00Z" },
  { html_url: `${URL}/issues/3#issuecomment-13`, issue_url: "https://api.github.com/repos/acme/rocket/issues/3", user: { login: "x" }, body: "  ", created_at: "2024-01-03T00:00:00Z" },
];

test("GitHub's issues and pull requests read back as the page reads them", async () => {
  const state = memory(githubRecords("me", "rocket", items, comments));
  const listed = await collab.issues(state, "me", "rocket", {});
  assert.deepEqual(listed.map((i) => [i.title, i.state, i.labels]), [
    ["Paint it red", "open", ["idea"]],
    ["Add fins", "closed", ["pull request"]],
    ["It explodes", "closed", ["bug"]],
  ]);
  const [paint, fins, explodes] = listed;
  assert.equal(explodes.author, "me");
  assert.equal(explodes.time, Date.parse("2024-01-01T00:00:00Z") / 1000);
  assert.equal(explodes.body, `_Issue #1 by @wile on GitHub: ${URL}/issues/1_\n\nOn **launch**.`);
  assert.equal(fins.body, `_Pull request #2 by @ghost on GitHub, merged: ${URL}/pull/2_`);
  assert.equal(fins.head, undefined, "not a pull request here: its branches are GitHub's");
  assert.equal(paint.id, githubId(`${URL}/issues/3`));

  const posts = await collab.posts(state, "me", explodes.id);
  assert.deepEqual(posts.map((p) => p.body), [`_@road on GitHub: ${URL}/issues/1#issuecomment-10_\n\nMeep meep.`]);
  assert.equal((await collab.posts(state, "me", fins.id)).length, 1);
  assert.equal((await collab.posts(state, "me", paint.id)).length, 0, "an empty comment is left out");
});

test("an import run again writes the same keys and values", () => {
  assert.deepEqual(githubRecords("me", "rocket", items, comments), githubRecords("me", "rocket", items, comments));
});

test("GitHub repos as people write them", () => {
  assert.equal(githubRepo("https://github.com/sindresorhus/ky"), "sindresorhus/ky");
  assert.equal(githubRepo("https://github.com/sindresorhus/ky.git/"), "sindresorhus/ky");
  assert.equal(githubRepo("sindresorhus/ky"), "sindresorhus/ky");
  assert.throws(() => githubRepo("https://gitlab.com/a/b"));
});
