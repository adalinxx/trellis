// A SHA-1 repository, signed commits and tags, a merge, a non-UTF-8 message
// and a master branch, imported: the same history file for file, SHA-256
// ids, and each old id and signature in a note.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { git } from "./git.mjs";
import { importRepository, sourceLabel } from "./import.mjs";

const env = { GIT_AUTHOR_DATE: "2026-11-02T12:00:00Z", GIT_COMMITTER_DATE: "2026-11-02T12:00:00Z" };
const run = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, ...env } }).trim();

function sha1Sample() {
  const dir = mkdtempSync(join(tmpdir(), "trellis-import-test-"));
  const key = join(dir, "key");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "test", "-f", key]);
  const repo = join(dir, "project");
  mkdirSync(repo);
  run(repo, "init", "-q", "--object-format=sha1", "-b", "master");
  for (const [k, v] of [["user.name", "Test"], ["user.email", "test@example.com"], ["gpg.format", "ssh"], ["user.signingkey", `${key}.pub`]]) run(repo, "config", k, v);
  writeFileSync(join(repo, "README.md"), "# project\n");
  writeFileSync(join(repo, "run.sh"), "#!/bin/sh\necho hi\n");
  chmodSync(join(repo, "run.sh"), 0o755);
  symlinkSync("README.md", join(repo, "link"));
  run(repo, "add", "-A");
  run(repo, "commit", "-q", "-m", "first");
  run(repo, "checkout", "-q", "-b", "feature");
  writeFileSync(join(repo, "feature.txt"), "feature\n");
  run(repo, "add", "-A");
  run(repo, "commit", "-q", "-S", "-m", "signed feature");
  run(repo, "checkout", "-q", "master");
  // A Latin-1 message, kept as its bytes with its encoding header.
  writeFileSync(join(repo, "README.md"), "# project\n\nmore\n");
  run(repo, "-c", "i18n.commitEncoding=ISO-8859-1", "commit", "-q", "-a", "-F", writeLatin1(dir, "caf\xe9\n"));
  run(repo, "merge", "-q", "--no-ff", "-m", "merge feature", "feature");
  run(repo, "tag", "-s", "-m", "release one", "v1");
  run(repo, "tag", "light", "HEAD~1");
  return { dir, repo };
}

function writeLatin1(dir, text) {
  const file = join(dir, "message");
  writeFileSync(file, Buffer.from(text, "latin1"));
  return file;
}

/** Every path's mode and bytes at `ref`. */
function files(repo, ref) {
  const out = new Map();
  for (const line of git(repo, "ls-tree", "-r", ref).split("\n")) {
    const [meta, path] = line.split("\t");
    const [mode, , id] = meta.split(" ");
    out.set(path, `${mode} ${execFileSync("git", ["-C", repo, "cat-file", "blob", id]).toString("base64")}`);
  }
  return out;
}

test("a SHA-1 repository imports as SHA-256, history and signatures kept", async () => {
  const { dir, repo } = sha1Sample();
  const dest = join(dir, "imported");
  const result = await importRepository(repo, dest);
  assert.equal(result.head, "master");
  assert.deepEqual(result.branches, ["refs/heads/feature", "refs/heads/master"]);
  assert.deepEqual(result.tags, ["refs/tags/light", "refs/tags/v1"]);
  assert.equal(result.signed, 2, "the signed commit and the signed tag");

  assert.equal(git(dest, "rev-parse", "--show-object-format"), "sha256");
  git(dest, "fsck", "--strict");
  assert.equal(git(dest, "symbolic-ref", "HEAD"), "refs/heads/master");
  assert.equal(readFileSync(join(dest, "README.md"), "utf8"), "# project\n\nmore\n", "checked out");
  for (const ref of ["master", "feature", "v1", "light"]) {
    assert.deepEqual(files(dest, ref), files(repo, ref), `${ref}: every file, mode and byte`);
    assert.equal(git(dest, "log", "--format=%an %ae %ad %cn %ce %cd %B", ref), git(repo, "log", "--format=%an %ae %ad %cn %ce %cd %B", ref), `${ref}: the same history`);
  }
  assert.equal(git(dest, "rev-list", "--count", "--exclude=refs/notes/*", "--all"), git(repo, "rev-list", "--count", "--all"));
  assert.equal(git(dest, "cat-file", "-t", "v1"), "tag");
  assert.equal(git(dest, "for-each-ref", "--format=%(contents:subject)", "refs/tags/v1"), "release one");
  // The Latin-1 message: the same bytes, the same encoding header.
  const latin = (r) => execFileSync("git", ["-C", r, "cat-file", "commit", `${git(r, "rev-parse", "master^1")}`]);
  assert.ok(latin(dest).includes(Buffer.from("encoding ISO-8859-1\n")));
  assert.ok(latin(dest).includes(Buffer.from("caf\xe9\n", "latin1")));

  // Notes: the old id of every commit and tag, and the signatures as text.
  const signed = git(dest, "rev-parse", "feature");
  const note = git(dest, "notes", "show", signed);
  assert.match(note, new RegExp(`^Imported from project as ${git(repo, "rev-parse", "feature")}\\.`));
  assert.match(note, /Signed before import[\s\S]*-----BEGIN SSH SIGNATURE-----[\s\S]*-----END SSH SIGNATURE-----/);
  assert.doesNotMatch(execFileSync("git", ["-C", dest, "cat-file", "commit", signed], { encoding: "utf8" }), /gpgsig/, "stripped from the commit");
  const tagNote = git(dest, "notes", "show", git(dest, "rev-parse", "v1"));
  assert.match(tagNote, new RegExp(`as ${git(repo, "rev-parse", "v1")}\\.[\\s\\S]*BEGIN SSH SIGNATURE`));
  assert.match(git(dest, "notes", "show", git(dest, "rev-parse", "master~1")), new RegExp(`as ${git(repo, "rev-parse", "master~1")}\\.$`), "unsigned: the old id only");
  assert.deepEqual([...new Set(git(dest, "log", "--format=%an <%ae> %cn <%ce>", "refs/notes/commits").split("\n"))], ["Trellis import <> Trellis import <>"], "the notes name no one");
  assert.match(git(dest, "log", "-1", "feature"), /Notes:\n\s+Imported from project as/, "git log shows it");
});

test("a repository with a submodule is refused, saying why", async () => {
  const { dir, repo } = sha1Sample();
  run(repo, "update-index", "--add", "--cacheinfo", `160000,${"ab".repeat(20)},vendor/sub`);
  run(repo, "commit", "-q", "-m", "a submodule");
  await assert.rejects(importRepository(repo, join(dir, "imported")), /submodules/);
});

test("a source is named without paths or credentials", () => {
  assert.equal(sourceLabel("https://user:token@github.com/org/repo.git"), "https://github.com/org/repo.git");
  assert.equal(sourceLabel("git@github.com:org/repo.git"), "github.com:org/repo.git");
  assert.equal(sourceLabel("/home/someone/work/repo.git/"), "repo");
  assert.equal(sourceLabel("file:///home/someone/work/repo"), "repo");
});

test("an imported repository exports back to SHA-1 with its old ids, and again only what is new", async () => {
  const { toSha1 } = await import("./export.mjs");
  const work = mkdtempSync(join(tmpdir(), "trellis-export-"));
  const old = join(work, "old");
  mkdirSync(old);
  const g = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: "1700000000 +0000", GIT_COMMITTER_DATE: "1700000000 +0000" } }).trim();
  g(old, "init", "-q", "--object-format=sha1", "-b", "main");
  g(old, "config", "user.name", "Dana");
  g(old, "config", "user.email", "dana@example.com");
  writeFileSync(join(old, "a.txt"), "a\n");
  g(old, "add", "-A");
  g(old, "commit", "-q", "-m", "first");
  g(old, "tag", "-a", "-m", "one", "v1");
  const dest = join(work, "new");
  await importRepository(old, dest);
  const { copy } = toSha1(dest);
  assert.equal(g(copy, "rev-parse", "refs/heads/main"), g(old, "rev-parse", "main"), "the same SHA-1 commit");
  assert.equal(g(copy, "rev-parse", "refs/tags/v1"), g(old, "rev-parse", "v1"), "the same SHA-1 tag");
  // A new commit on Trellis's side, then a deleted tag: the copy follows.
  g(dest, "config", "user.name", "Dana");
  g(dest, "config", "user.email", "dana@example.com");
  writeFileSync(join(dest, "b.txt"), "b\n");
  g(dest, "add", "-A");
  g(dest, "commit", "-q", "-m", "second");
  g(dest, "tag", "-d", "v1");
  toSha1(dest);
  assert.equal(g(copy, "log", "--format=%s", "main"), "second\nfirst");
  assert.equal(g(copy, "rev-parse", "main~1"), g(old, "rev-parse", "main"));
  assert.equal(g(copy, "tag"), "");
  g(copy, "fsck", "--strict");
});
