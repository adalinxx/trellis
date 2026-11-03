// The viewer's reads against git's own answers: a repo pushed as blocks, then
// read back one block at a time.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as sdk from "../vendor/lattice-sdk.js";
import { git, objectReader, objectsBetween } from "./git.mjs";
import { encode } from "./transfer.mjs";
import { hunks, isText, lineDiff, lines, parseCommit, reader } from "./browse.mjs";

const run = (repo, args, env = {}) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, ...env } }).trim();

async function sample() {
  const repo = mkdtempSync(join(tmpdir(), "trellis-browse-"));
  run(repo, ["init", "-q", "--object-format=sha256", "-b", "main"]);
  run(repo, ["config", "user.name", "Test"]);
  run(repo, ["config", "user.email", "test@example.com"]);
  const at = (n) => ({ GIT_AUTHOR_DATE: `${1700000000 + n} +0000`, GIT_COMMITTER_DATE: `${1700000000 + n} +0000` });
  mkdirSync(join(repo, "src/deep"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# sample\n");
  writeFileSync(join(repo, "src/a.txt"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n");
  writeFileSync(join(repo, "src/deep/b.txt"), "b\n");
  writeFileSync(join(repo, "big.bin"), Buffer.alloc(1.5 * (1 << 20), 1));
  run(repo, ["add", "-A"]);
  run(repo, ["commit", "-q", "-m", "first\n\nwith a body"], at(1));
  run(repo, ["checkout", "-q", "-b", "side"]);
  writeFileSync(join(repo, "side.txt"), "side\n");
  run(repo, ["add", "-A"]);
  run(repo, ["commit", "-q", "-m", "side"], at(3));
  run(repo, ["checkout", "-q", "main"]);
  writeFileSync(join(repo, "src/a.txt"), "one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\n");
  execFileSync("rm", [join(repo, "src/deep/b.txt")]);
  writeFileSync(join(repo, "src/c.txt"), "c\n");
  run(repo, ["add", "-A"]);
  run(repo, ["commit", "-q", "-m", "second"], at(2));
  run(repo, ["merge", "-q", "--no-ff", "-m", "merge side", "side"], at(4));

  const objects = objectReader(repo);
  const known = new Map();
  let volumes;
  try {
    volumes = await encode(sdk, objects.read, objectsBetween(repo, [run(repo, ["rev-parse", "main"])]), known);
  } finally {
    objects.close();
  }
  const blocks = new Map(volumes.flatMap((v) => Object.entries(v.entries)));
  const fetched = [];
  const load = async (cid) => {
    fetched.push(cid);
    return new Uint8Array(Buffer.from(blocks.get(cid), "base64"));
  };
  return { repo, known, read: reader(sdk, load), fetched };
}

test("trees, files, history and changes read as git reads them, block by block", async () => {
  const { repo, known, read, fetched } = await sample();
  const head = known.get(run(repo, ["rev-parse", "main"]));
  const commit = await read.commit(head);
  assert.equal(commit.id, run(repo, ["rev-parse", "main"]));
  assert.equal(commit.message, "merge side\n");
  assert.equal(commit.author.name, "Test");
  assert.equal(commit.committer.time, 1700000004);

  // The root, directories first, read without any file's blocks.
  fetched.length = 0;
  const root = await read.tree(commit.tree);
  assert.deepEqual(root.map((e) => `${e.kind} ${e.name}`), ["tree src", "blob README.md", "blob big.bin", "blob side.txt"]);
  assert.equal(fetched.length, 1, "one block: the root tree");

  // A file's size from its root alone; its bytes from its chunks.
  const big = await read.at(commit.tree, "big.bin");
  fetched.length = 0;
  assert.equal(await read.size(big.cid), 1.5 * (1 << 20));
  assert.equal(fetched.length, 1, "the size needs only the root block");
  assert.deepEqual(Buffer.from(await read.blob(big.cid)), Buffer.alloc(1.5 * (1 << 20), 1));
  const a = await read.at(commit.tree, "src/a.txt");
  assert.equal(new TextDecoder().decode(await read.blob(a.cid)), run(repo, ["show", "main:src/a.txt"]) + "\n");
  assert.equal(await read.at(commit.tree, "src/nothing"), undefined);
  assert.equal(await read.at(commit.tree, "README.md/x"), undefined);

  // History in git log's order.
  const { commits, more } = await read.history([head], 10);
  assert.deepEqual(commits.map((c) => c.id), run(repo, ["log", "--format=%H", "main"]).split("\n"));
  assert.equal(more, false);
  const page = await read.history([head], 2);
  assert.deepEqual(page.commits.map((c) => c.id), run(repo, ["log", "--format=%H", "-2", "main"]).split("\n"));
  assert.equal(page.more, true);

  // Changes against the first parent, as git diff-tree names them.
  const second = await read.commit(commit.parents[0]);
  const parent = await read.commit(second.parents[0]);
  const changed = await read.changes(parent.tree, second.tree);
  const status = { added: "A", deleted: "D", modified: "M" };
  assert.deepEqual(changed.map((c) => `${status[c.status]}\t${c.path}`).join("\n"), run(repo, ["diff-tree", "-r", "--name-status", "main~1~1", "main~1"]));
  // The first commit: everything added.
  assert.equal((await read.changes(undefined, parent.tree)).length, run(repo, ["ls-tree", "-r", "main~1~1"]).split("\n").length);
});

test("a line diff rebuilds the new text, and its hunks are git's", async () => {
  const { repo } = await sample();
  const before = lines(run(repo, ["show", "main~1~1:src/a.txt"]) + "\n");
  const after = lines(run(repo, ["show", "main~1:src/a.txt"]) + "\n");
  const edit = lineDiff(before, after);
  assert.deepEqual(edit.filter((s) => s.op !== "-").map((s) => s.line), after);
  assert.deepEqual(edit.filter((s) => s.op !== "+").map((s) => s.line), before);
  const ours = hunks(edit).map((h) => [`@@ -${h.a},${h.aLines} +${h.b},${h.bLines} @@`, ...h.steps.map((s) => s.op + s.line)].join("\n")).join("\n");
  const theirs = run(repo, ["diff", "--no-color", "main~1~1", "main~1", "--", "src/a.txt"]).split("\n").filter((l) => /^(@@|[ +-](?![-+]{2} ))/.test(l)).map((l) => l.replace(/^(@@ [^@]* @@).*/, "$1")).join("\n");
  assert.equal(ours, theirs);
  // Edge cases: empty sides, identical text.
  assert.deepEqual(lineDiff([], ["x"]).map((s) => s.op), ["+"]);
  assert.deepEqual(lineDiff(["x"], []).map((s) => s.op), ["-"]);
  assert.deepEqual(hunks(lineDiff(["x", "y"], ["x", "y"])), []);
});

test("a commit's header and message, and text against binary", () => {
  const rest = new TextEncoder().encode("author A B <a@b> 1700000000 +0100\ncommitter C <c@d> 1700000001 -0500\ngpgsig -----BEGIN SSH SIGNATURE-----\n abc\n -----END SSH SIGNATURE-----\n\nsubject\n\nbody\n");
  const parsed = parseCommit(rest);
  assert.deepEqual(parsed.author, { name: "A B", email: "a@b", time: 1700000000, zone: "+0100" });
  assert.equal(parsed.committer.zone, "-0500");
  assert.equal(parsed.message, "subject\n\nbody\n");
  assert.equal(parsed.signed, true);
  const latin = Uint8Array.from([...new TextEncoder().encode("author A <a> 1 +0000\ncommitter A <a> 1 +0000\nencoding ISO-8859-1\n\ncaf"), 0xe9, 0x0a]);
  assert.equal(parseCommit(latin).message, "café\n");
  assert.equal(isText(new TextEncoder().encode("hello\n")), true);
  assert.equal(isText(Uint8Array.of(1, 0, 2)), false);
});
