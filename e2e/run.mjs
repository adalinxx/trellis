// Trellis end to end on real nodes, with no coins. A private host mines Nexus
// and Nexus/trellis (chain/trellis_policy.wasm, a fast test spec). A sponsor
// (lattice-sponsor) pays fees and keeps files for work. Alice has no coins:
// she pushes a SHA-256 repository, her objects kept by the sponsor for her
// machine's work and her ref written with its fee paid the same way. Bob,
// also coinless, can't move her ref. A second push sends only new objects.
// A reader's node, knowing only the first as a peer, finds her ref in its own
// state and clones from peers into an empty repository: the same commit,
// `git fsck` clean.
//
//   LATTICE=<lattice-node>/.build/debug/lattice \
//   LATTICE_SPONSOR=<lattice-sponsor>/.build/debug/lattice-sponsor node e2e/run.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdk from "../vendor/lattice-sdk.js";
import { git, objectReader, objectsBetween, store } from "../client/git.mjs";
import * as records from "../client/records.mjs";
import * as collab from "../client/collab.mjs";
import { checks as checksOn } from "../client/checks.mjs";
import { reader as blockReader } from "../client/browse.mjs";
import { keep, sponsored } from "../client/sponsor.mjs";
import { encode, fetchObjects } from "../client/transfer.mjs";
import { changes, transaction } from "../client/write.mjs";
import * as stack from "./stack.mjs";
import { CHAIN, host, here, openReads, until } from "./stack.mjs";

const reader = { listen: 27011, rpc: 27090, publicRead: 27091 };
const readers = host(mkdtempSync(`${tmpdir()}/trellis-e2e-reader-`));
const work = mkdtempSync(`${tmpdir()}/trellis-e2e-repos-`);
let authors, author, authorNode, sponsorURL;
const account = (address, at = authorNode) => stack.account(at, address);
const state = (at = authorNode) => stack.state(at);

/** `who` writes `writes` with no coins: the sponsor pays the fee for work. Resolves to the node's answer. */
async function submit(who, writes) {
  const actions = await changes(await state(), writes);
  const nonce = BigInt((await account(who.address)).nonce ?? 0);
  const draft = transaction({ owner: who.address, actions, nonce, chainPath: CHAIN });
  const payload = await sponsored(sdk, sponsorURL, draft, who.privateKey);
  return fetch(`${authorNode}/transactions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
}

/** Submits until accepted, then waits until every write reads back. */
async function writes(label, who, list) {
  await until(label, async () => {
    const response = await submit(who, list);
    if (!response.ok) console.log(`  ${label}: ${response.status} ${await response.text()}`);
    return response.ok;
  });
  await until(`${label} is mined`, async () => {
    const now = await state();
    for (const [key, value] of list) if ((await now.get(key)) !== value) return false;
    return true;
  });
  console.log(label);
}

/** Alice's push: the objects the remote lacks, kept by the sponsor; then her ref. */
async function push(who, repo, name, ref, remote) {
  const head = git(repo, "rev-parse", ref);
  const known = new Map(remote ? [[remote.id, remote.cid]] : []);
  const objects = objectReader(repo);
  let volumes;
  try {
    volumes = await encode(sdk, objects.read, objectsBetween(repo, [head], remote ? [remote.id] : []), known);
  } finally {
    objects.close();
  }
  await keep(sdk, sponsorURL, CHAIN.join("/"), volumes);
  const cid = known.get(head);
  await writes(`push ${volumes.length} Volumes and move ${ref}`, who, [
    ...(remote ? [] : records.repo(who.address, name, { description: "a sample" })),
    ...records.ref(who.address, name, ref, cid),
  ]);
  return { id: head, cid, volumes };
}

const run = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
function newRepo(path) {
  mkdirSync(path);
  run(path, "init", "-q", "--object-format=sha256", "-b", "main");
  run(path, "config", "user.name", "Alice");
  run(path, "config", "user.email", "alice@example.com");
  return path;
}

let running;
try {
  running = await stack.start(27000);
  ({ authors, authorNode, sponsorURL } = running);
  author = running.ports;

  // Alice's repository: a file over one Volume, so a blob is chunked.
  const alice = sdk.accountFromPrivateKey(sdk.generatePrivateKey());
  const bob = sdk.accountFromPrivateKey(sdk.generatePrivateKey());
  const repo = newRepo(join(work, "alice"));
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "README.md"), "# trellis sample\n");
  writeFileSync(join(repo, "src/main.c"), "int main(void) { return 0; }\n");
  const big = Buffer.alloc(1.5 * (1 << 20));
  for (let i = 0; i < big.length; i++) big[i] = (i * 2654435761) >>> 24;
  writeFileSync(join(repo, "data.bin"), big);
  run(repo, "add", "-A");
  run(repo, "commit", "-q", "-m", "first");
  writeFileSync(join(repo, "README.md"), "# trellis sample\n\nsecond\n");
  run(repo, "commit", "-q", "-am", "second");

  const first = await push(alice, repo, "sample", "refs/heads/main");
  assert.equal(BigInt((await account(alice.address)).balance ?? 0), 0n, "Alice has no coins");

  // Bob, also coinless and sponsored, can't move Alice's ref.
  const elsewhere = sdk.cidV1DagCbor(sdk.encodeDagCbor({ forged: true }));
  const forged = await submit(bob, records.ref(alice.address, "sample", "refs/heads/main", elsewhere));
  assert.ok(!forged.ok, "writing another account's ref is refused");
  console.log(`forgery refused: ${forged.status} ${await forged.text()}`);

  // A second push sends only what's new: the README's new blob, its tree, the commit.
  writeFileSync(join(repo, "README.md"), "# trellis sample\n\nthird\n");
  run(repo, "commit", "-q", "-am", "third");
  const second = await push(alice, repo, "sample", "refs/heads/main", first);
  assert.equal(second.volumes.length, 3, "a new blob, a new tree, a new commit");
  assert.equal(BigInt((await account(alice.address)).balance ?? 0), 0n, "Alice still has no coins");

  // The reader's node knows only the host, and hosts the chain itself.
  readers.lattice("init");
  readers.configure((t) => {
    Object.assign(t, { ...reader, webSocket: 0, hostedChains: [CHAIN.join("/")] });
    openReads(t);
    const identity = authors.lattice("identity").match(/([0-9a-f]{64})@/)[1];
    t.peers = [`${identity}@127.0.0.1:${author.listen}`];
  });
  readers.lattice("up");
  const readerNode = `http://127.0.0.1:${reader.publicRead}`;
  const refs = await until("the reader's node has Alice's ref", async () => {
    const found = await records.refs(sdk, await state(readerNode), alice.address, "sample");
    return found.get("refs/heads/main") === second.cid && found;
  });
  assert.deepEqual(await records.owners(await state(readerNode), "sample"), [alice.address]);
  console.log("reader: Alice's ref, from its own state");

  // Clone through the reader's own node, which reads every block from peers.
  const auth = { Authorization: `Basic ${Buffer.from(readers.cookie()).toString("base64")}` };
  const load = (cid) =>
    until(`block ${cid}`, async () => {
      const r = await fetch(`http://127.0.0.1:${reader.rpc}/fetch/${cid}`, { headers: auth });
      if (!r.ok) return undefined;
      const entry = (await r.json()).entries?.[cid];
      return entry && new Uint8Array(Buffer.from(entry, "base64"));
    }, 60);
  const objects = await fetchObjects(sdk, load, [refs.get("refs/heads/main")]);
  const clone = newRepo(join(work, "clone"));
  store(clone, objects);
  run(clone, "update-ref", "refs/heads/main", second.id);
  run(clone, "fsck", "--strict", "--no-dangling");
  assert.equal(run(clone, "rev-parse", "main"), run(repo, "rev-parse", "main"));
  assert.equal(run(clone, "log", "--format=%s", "main"), "third\nsecond\nfirst");
  assert.equal(run(clone, "rev-parse", "main:data.bin"), run(repo, "rev-parse", "main:data.bin"));
  console.log(`reader: cloned ${objects.length} objects from peers; same history, fsck clean`);

  // Stock git through bin/git-remote-trellis. Carol, coinless, pushes with a key file.
  const carolKey = sdk.generatePrivateKey();
  const carol = sdk.accountFromPrivateKey(carolKey);
  const keyFile = join(work, "carol.json");
  writeFileSync(keyFile, JSON.stringify({ address: carol.address, privateKey: Buffer.from(carolKey).toString("hex") }));
  const helperEnv = (node, key = keyFile) => ({
    ...process.env,
    PATH: `${here("../bin")}:${process.env.PATH}`,
    TRELLIS_NODE: node,
    TRELLIS_SPONSOR: sponsorURL,
    TRELLIS_KEY: key,
    TRELLIS_CHAIN: CHAIN.join("/"),
    GIT_TERMINAL_PROMPT: "0",
  });
  const gitWith = (env, cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const gitFails = (env, cwd, ...args) => {
    try {
      gitWith(env, cwd, ...args);
    } catch (error) {
      return String(error.stderr);
    }
    throw new Error(`git ${args.join(" ")} should have failed`);
  };
  const address = `trellis::${carol.address}/tools`;
  const tools = newRepo(join(work, "tools"));
  writeFileSync(join(tools, "tool.sh"), "#!/bin/sh\necho tool\n");
  run(tools, "add", "-A");
  run(tools, "commit", "-q", "-m", "tool");
  run(tools, "remote", "add", "origin", address);
  gitWith(helperEnv(authorNode), tools, "push", "-q", "origin", "main");
  assert.equal(BigInt((await account(carol.address)).balance ?? 0), 0n, "Carol has no coins");
  console.log("git push: a new repo, coinless");

  // Cloned through the reader's node, once it has the push.
  await until("the reader's node has Carol's main", async () => (await records.refs(sdk, await state(readerNode), carol.address, "tools")).has("refs/heads/main"));
  const cloneDir = join(work, "tools-clone");
  gitWith(helperEnv(readerNode), work, "clone", "-q", address, cloneDir);
  assert.equal(run(cloneDir, "rev-parse", "--show-object-format"), "sha256");
  assert.equal(run(cloneDir, "rev-parse", "HEAD"), run(tools, "rev-parse", "HEAD"));
  run(cloneDir, "fsck", "--strict");
  console.log("git clone: through the reader's node, same HEAD");

  // A second commit and a tag; the clone fetches both.
  writeFileSync(join(tools, "tool.sh"), "#!/bin/sh\necho tool v2\n");
  run(tools, "commit", "-q", "-am", "v2");
  run(tools, "tag", "-a", "-m", "release", "v2");
  gitWith(helperEnv(authorNode), tools, "push", "-q", "origin", "main", "v2");
  await until("the reader's node has v2", async () => (await records.refs(sdk, await state(readerNode), carol.address, "tools")).has("refs/tags/v2"));
  gitWith(helperEnv(readerNode), cloneDir, "fetch", "-q", "--tags", "origin");
  assert.equal(run(cloneDir, "rev-parse", "origin/main"), run(tools, "rev-parse", "main"));
  assert.equal(run(cloneDir, "rev-parse", "v2"), run(tools, "rev-parse", "v2"));
  console.log("git fetch: a new commit and an annotated tag");

  // A rewrite needs --force; someone else's key can't push at all.
  run(tools, "commit", "-q", "--amend", "-m", "v2, reworded");
  assert.match(gitFails(helperEnv(authorNode), tools, "push", "origin", "main"), /rejected|non-fast-forward/);
  gitWith(helperEnv(authorNode), tools, "push", "-q", "--force", "origin", "main");
  const aliceKey = join(work, "alice.json");
  writeFileSync(aliceKey, JSON.stringify({ address: alice.address, privateKey: Buffer.from(alice.privateKey).toString("hex") }));
  run(tools, "commit", "-q", "--allow-empty", "-m", "by someone else");
  assert.match(gitFails(helperEnv(authorNode, aliceKey), tools, "push", "origin", "main"), /this key is/);
  console.log("git push: a rewrite only with --force; another account's key refused");

  // A team: Carol makes Alice a maintainer; Alice pushes with her own key,
  // and a clone sees her commit. Once Carol drops her, Alice can't push, and
  // main stays at Alice's commit.
  const trellis = (env, cwd, ...args) => execFileSync(here("../bin/trellis"), args, { cwd, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
  assert.match(trellis(helperEnv(authorNode), tools, "maintainers", "add", alice.address), new RegExp(alice.address));
  assert.throws(() => trellis(helperEnv(authorNode, aliceKey), tools, "maintainers", "add", bob.address), /only .* the owner/);
  gitWith(helperEnv(authorNode, aliceKey), tools, "push", "-q", "origin", "main");
  const byAlice = run(tools, "rev-parse", "main");
  await until("the reader's node has Alice's push", async () => {
    const words = await records.words(sdk, await state(readerNode), carol.address, "tools");
    return words.get("refs/heads/main")?.by === alice.address;
  });
  gitWith(helperEnv(readerNode), cloneDir, "fetch", "-q", "origin");
  assert.equal(run(cloneDir, "rev-parse", "origin/main"), byAlice);
  // main stands on Alice's push; dropping her re-states it as Carol's.
  trellis(helperEnv(authorNode), tools, "maintainers", "remove", alice.address);
  assert.deepEqual((await records.words(sdk, await state(), carol.address, "tools")).get("refs/heads/main")?.by, carol.address);
  run(tools, "commit", "-q", "--allow-empty", "-m", "by Alice, dropped");
  assert.match(gitFails(helperEnv(authorNode, aliceKey), tools, "push", "origin", "main"), /not one of .* maintainers/);
  run(tools, "reset", "-q", "--hard", byAlice);
  await until("the reader's node has the new card", async () => !(await records.card(await state(readerNode), carol.address, "tools"))?.delegates?.length);
  gitWith(helperEnv(readerNode), cloneDir, "fetch", "-q", "origin");
  assert.equal(run(cloneDir, "rev-parse", "origin/main"), byAlice);
  console.log("team: a maintainer pushes with their own key; once dropped, can't, and main stays put");

  // A mirror keeps every block of the repo through a sponsor, from a clone;
  // a clone that lacks a branch is told to fetch first.
  assert.match(trellis(helperEnv(readerNode), cloneDir, "mirror", sponsorURL), /^\d+ blocks kept by /);
  console.log("trellis mirror: the repo's blocks kept again, made from a clone");

  // trellis release: a tag's notes and a file, the file kept by the sponsor
  // and read back by its CID.
  const asset = join(work, "tool-v2.sh");
  writeFileSync(asset, "#!/bin/sh\necho tool v2, packed\n");
  assert.match(trellis(helperEnv(authorNode), tools, "release", "v2", "--title", "Two", "--notes", "The second tool.", asset), /released v2 with tool-v2\.sh/);
  const released = (await collab.releases(await state(), carol.address, "tools", await records.card(await state(), carol.address, "tools"))).get("v2");
  assert.equal(released.title, "Two");
  assert.deepEqual(released.files.map((f) => [f.name, f.size]), [["tool-v2.sh", readFileSync(asset).length]]);
  const assetBytes = await blockReader(sdk, load).blob(released.files[0].cid);
  assert.equal(Buffer.from(assetBytes).toString(), readFileSync(asset, "utf8"));
  console.log("trellis release: notes and a file, kept by the sponsor");

  // CI: a runner runs .trellis/ci on the branch tip and posts its result;
  // a check from someone the card doesn't name doesn't count.
  mkdirSync(join(tools, ".trellis"), { recursive: true });
  writeFileSync(join(tools, ".trellis/ci"), "#!/bin/sh\necho checking $TRELLIS_BRANCH\ntest -f tool.sh\n");
  chmodSync(join(tools, ".trellis/ci"), 0o755);
  run(tools, "add", "-A");
  run(tools, "commit", "-q", "-m", "ci");
  gitWith(helperEnv(authorNode), tools, "push", "-q", "origin", "main");
  const ciTip = run(tools, "rev-parse", "main");
  trellis(helperEnv(authorNode), tools, "ci", "--once");
  trellis(helperEnv(authorNode, aliceKey), tools, "check", "lint", "fail", "--summary", "not a runner");
  const tipChecks = await checksOn(await state(), carol.address, "tools", await records.card(await state(), carol.address, "tools"), ciTip);
  assert.deepEqual(tipChecks.map((c) => [c.check, c.state, c.by]), [["ci", "pass", carol.address]]);
  assert.match(tipChecks[0].summary, /checking origin\/main/);
  console.log("ci: .trellis/ci run on the tip and its result posted; a stranger's check not counted");

  // A private repo: sealed blocks; its owner and a reader clone it, nobody
  // else can; a dropped reader can't read what is pushed after.
  const vault = newRepo(join(work, "vault"));
  writeFileSync(join(vault, "plans.txt"), "secret plans\n");
  run(vault, "add", "-A");
  run(vault, "commit", "-q", "-m", "the plans");
  run(vault, "remote", "add", "origin", `trellis::${carol.address}/vault`);
  trellis(helperEnv(authorNode), vault, "private");
  gitWith(helperEnv(authorNode), vault, "push", "-q", "origin", "main");
  const vaultHead = await records.refs(sdk, await state(), carol.address, "vault");
  const sealedBytes = Buffer.from(await blockReader(sdk, load).object(vaultHead.get("refs/heads/main")).then(() => "", (e) => e.message));
  assert.match(sealedBytes.toString(), /not a git object block/, "a node sees no git object, only a sealed block");
  await until("the reader's node has the vault", async () => (await records.refs(sdk, await state(readerNode), carol.address, "vault")).has("refs/heads/main"));
  const vaultClone = join(work, "vault-clone");
  gitWith(helperEnv(readerNode), work, "clone", "-q", `trellis::${carol.address}/vault`, vaultClone);
  assert.equal(readFileSync(join(vaultClone, "plans.txt"), "utf8"), "secret plans\n");
  assert.match(gitFails(helperEnv(readerNode, aliceKey), work, "clone", "-q", `trellis::${carol.address}/vault`, join(work, "vault-alice")), /isn't one of its members/);
  trellis(helperEnv(authorNode), vault, "readers", "add", alice.address);
  await until("the reader's node has Alice as a reader", async () => (await records.card(await state(readerNode), carol.address, "vault"))?.readers?.includes(alice.address));
  const aliceVault = join(work, "vault-alice2");
  gitWith(helperEnv(readerNode, aliceKey), work, "clone", "-q", `trellis::${carol.address}/vault`, aliceVault);
  assert.equal(readFileSync(join(aliceVault, "plans.txt"), "utf8"), "secret plans\n");
  run(aliceVault, "config", "user.name", "Alice");
  run(aliceVault, "config", "user.email", "alice@example.com");
  run(aliceVault, "commit", "-q", "--allow-empty", "-m", "by a reader");
  assert.match(gitFails(helperEnv(authorNode, aliceKey), aliceVault, "push", "origin", "main"), /not one of .* maintainers/);
  trellis(helperEnv(authorNode), vault, "readers", "remove", alice.address);
  writeFileSync(join(vault, "plans.txt"), "newer secret plans\n");
  run(vault, "commit", "-q", "-am", "newer plans");
  gitWith(helperEnv(authorNode), vault, "push", "-q", "origin", "main");
  await until("the reader's node has the newer plans", async () => (await records.refs(sdk, await state(readerNode), carol.address, "vault")).get("refs/heads/main") !== vaultHead.get("refs/heads/main"));
  assert.match(gitFails(helperEnv(readerNode, aliceKey), aliceVault, "fetch", "origin"), /one of its members/);
  gitWith(helperEnv(readerNode), vaultClone, "pull", "-q", "--ff-only");
  assert.equal(readFileSync(join(vaultClone, "plans.txt"), "utf8"), "newer secret plans\n");
  console.log("private: sealed blocks; members clone, others can't; a dropped reader can't fetch what came after");

  // trellis import: a SHA-1 repository on master, signed, then pushed whole.
  const old = join(work, "old-project");
  mkdirSync(old);
  run(old, "init", "-q", "--object-format=sha1", "-b", "master");
  run(old, "config", "user.name", "Dana");
  run(old, "config", "user.email", "dana@example.com");
  writeFileSync(join(old, "notes.txt"), "from a SHA-1 repo\n");
  run(old, "add", "-A");
  run(old, "commit", "-q", "-m", "old history");
  run(old, "tag", "-a", "-m", "old release", "v0");
  const imported = join(work, "imported");
  execFileSync(here("../bin/trellis"), ["import", old, imported], { stdio: "inherit" });
  const importAddress = `trellis::${carol.address}/old-project`;
  run(imported, "remote", "add", "origin", importAddress);
  gitWith(helperEnv(authorNode), imported, "push", "-q", "origin", "--all");
  gitWith(helperEnv(authorNode), imported, "push", "-q", "origin", "--tags", "refs/notes/commits");
  const importClone = join(work, "imported-clone");
  gitWith(helperEnv(readerNode), work, "clone", "-q", importAddress, importClone);
  assert.equal(run(importClone, "symbolic-ref", "--short", "HEAD"), "master", "HEAD: the only branch, master");
  assert.equal(readFileSync(join(importClone, "notes.txt"), "utf8"), "from a SHA-1 repo\n");
  gitWith(helperEnv(readerNode), importClone, "fetch", "-q", "origin", "refs/notes/commits:refs/notes/commits");
  assert.match(run(importClone, "log", "-1"), new RegExp(`Imported from old-project as ${run(old, "rev-parse", "master")}`));
  assert.equal(run(importClone, "cat-file", "-t", "v0"), "tag");
  console.log("trellis import: a SHA-1 repo pushed whole; cloned with master checked out, its old ids in notes");

  // A push that fails before its blocks are kept, then succeeds: the second
  // sends every block again, so a clone gets them all.
  const retried = newRepo(join(work, "retried"));
  writeFileSync(join(retried, "file.txt"), "kept on the second try\n");
  run(retried, "add", "-A");
  run(retried, "commit", "-q", "-m", "retried");
  const retriedAddress = `trellis::${carol.address}/retried`;
  run(retried, "remote", "add", "origin", retriedAddress);
  gitFails({ ...helperEnv(authorNode), TRELLIS_SPONSOR: "http://127.0.0.1:1" }, retried, "push", "origin", "main");
  gitWith(helperEnv(authorNode), retried, "push", "-q", "origin", "main");
  const retriedClone = join(work, "retried-clone");
  gitWith({ ...helperEnv(readerNode), TRELLIS_READ_SECONDS: "60" }, work, "clone", "-q", retriedAddress, retriedClone);
  assert.equal(readFileSync(join(retriedClone, "file.txt"), "utf8"), "kept on the second try\n");
  console.log("git push: after a failed push, the next one keeps every block");

  // Optional (E2E_BIG_MB=<n>): a repo of about n MiB, many small files and a
  // few large ones over several commits, pushed by stock git and cloned
  // through the reader's node.
  const bigMiB = Number(process.env.E2E_BIG_MB ?? 0);
  if (bigMiB > 0) {
    const large = newRepo(join(work, "large"));
    let seed = 1;
    const noise = (bytes) => {
      const out = Buffer.alloc(bytes);
      for (let i = 0; i < bytes; i++) out[i] = (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 24;
      return out;
    };
    const commits = 4;
    for (let c = 0; c < commits; c++) {
      const dir = join(large, `part${c}`);
      mkdirSync(dir, { recursive: true });
      // Half the bytes in ~800 small files per commit, half in a few 4 MiB ones.
      const share = (bigMiB << 20) / commits;
      for (let i = 0; i < 800; i++) writeFileSync(join(dir, `f${i}.txt`), noise(Math.floor(share / 2 / 800)));
      for (let i = 0; i * (4 << 20) < share / 2; i++) writeFileSync(join(dir, `blob${i}.bin`), noise(4 << 20));
      writeFileSync(join(large, "README.md"), `commit ${c}\n`);
      run(large, "add", "-A");
      run(large, "commit", "-q", "-m", `part ${c}`);
    }
    const objectCount = run(large, "rev-list", "--objects", "--all").split("\n").length;
    const largeAddress = `trellis::${carol.address}/large`;
    run(large, "remote", "add", "origin", largeAddress);
    let started = Date.now();
    gitWith(helperEnv(authorNode), large, "push", "-q", "origin", "main");
    const pushSeconds = (Date.now() - started) / 1000;
    started = Date.now();
    const largeClone = join(work, "large-clone");
    gitWith(helperEnv(readerNode), work, "clone", "-q", largeAddress, largeClone);
    const cloneSeconds = (Date.now() - started) / 1000;
    // From the host that keeps the blocks: no peer fetches.
    started = Date.now();
    gitWith(helperEnv(authorNode), work, "clone", "-q", largeAddress, join(work, "large-clone-host"));
    const hostSeconds = (Date.now() - started) / 1000;
    assert.equal(run(join(work, "large-clone-host"), "rev-parse", "HEAD"), run(large, "rev-parse", "HEAD"));
    assert.equal(run(largeClone, "rev-parse", "HEAD"), run(large, "rev-parse", "HEAD"));
    run(largeClone, "fsck", "--strict");
    assert.equal(BigInt((await account(carol.address)).balance ?? 0), 0n, "Carol still has no coins");
    console.log(`large repo: ${bigMiB} MiB, ${objectCount} objects; push ${pushSeconds}s, clone through the reader ${cloneSeconds}s (it fetches every block from peers), from the host ${hostSeconds}s; fsck clean`);
  }
  console.log("PASS");
} finally {
  try { readers.lattice("down"); } catch {}
  running?.stop();
}
