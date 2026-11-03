import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultBranch, fullRef, href, linkTarget, parseRoute, shortAccount } from "./lib.mjs";

test("routes round-trip, a ref with slashes as one segment", () => {
  const routes = [
    { view: "home" },
    { view: "settings" },
    { view: "owner", owner: "bafyreiabc" },
    { view: "code", owner: "bafyreiabc", name: "repo" },
    { view: "tree", owner: "bafyreiabc", name: "repo", ref: "feature/x", path: "src/a b" },
    { view: "blob", owner: "bafyreiabc", name: "repo", ref: "main", path: "README.md" },
    { view: "commits", owner: "bafyreiabc", name: "repo", ref: "v1.0", limit: 60 },
    { view: "commit", owner: "bafyreiabc", name: "repo", cid: "bafyreicommit" },
    { view: "tags", owner: "bafyreiabc", name: "repo" },
    { view: "issues", owner: "bafyreiabc", name: "repo", closed: true },
    { view: "pulls", owner: "bafyreiabc", name: "repo", closed: false },
    { view: "issues-new", owner: "bafyreiabc", name: "repo" },
    { view: "pulls-new", owner: "bafyreiabc", name: "repo" },
    { view: "issue", owner: "bafyreiabc", name: "repo", author: "bafyreibob", id: "00ff", tab: "conversation" },
    { view: "pull", owner: "bafyreiabc", name: "repo", author: "bafyreibob", id: "00ff", tab: "files" },
  ];
  for (const route of routes) assert.deepEqual(parseRoute(href(route)), route);
  assert.deepEqual(parseRoute("#/o/r/tree/main"), { view: "tree", owner: "o", name: "r", ref: "main", path: "" });
  assert.equal(parseRoute("#/o/r/commits/main").limit, 30);
});

test("README links: safe ones kept, relative ones into the repo", () => {
  assert.deepEqual(linkTarget("https://example.com/x", "docs"), { url: "https://example.com/x" });
  assert.deepEqual(linkTarget("../src/a.c#L3", "docs/guide"), { path: "docs/src/a.c" });
  assert.deepEqual(linkTarget("./img.png", ""), { path: "img.png" });
  assert.deepEqual(linkTarget("/top.md", "deep/dir"), { path: "top.md" });
  assert.deepEqual(linkTarget("#usage", ""), { anchor: "#usage" });
  assert.equal(linkTarget("javascript:alert(1)", ""), undefined);
  assert.equal(linkTarget("JavaScript:alert(1)", ""), undefined);
  assert.equal(linkTarget("data:text/html,x", ""), undefined);
  assert.equal(linkTarget("//evil.example/x", ""), undefined);
});

test("which branch a repo opens on, and short names", () => {
  const refs = (...names) => new Map(names.map((n) => [n, "cid"]));
  assert.equal(defaultBranch(refs("refs/heads/dev", "refs/heads/master")), "refs/heads/master");
  assert.equal(defaultBranch(refs("refs/heads/master", "refs/heads/main")), "refs/heads/main");
  assert.equal(defaultBranch(refs("refs/heads/b", "refs/heads/a", "refs/tags/v1")), "refs/heads/a");
  assert.equal(fullRef(refs("refs/heads/x", "refs/tags/v1"), "v1"), "refs/tags/v1");
  assert.equal(fullRef(refs("refs/heads/x"), "y"), undefined);
  assert.equal(shortAccount("bafyreiawq56nmptp77jehccbrsb6dvkra43elzatj4yyyfx5jmefwbhb2m"), "awq56n…hb2m");
});
