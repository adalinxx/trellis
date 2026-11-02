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
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as sdk from "../vendor/lattice-sdk.js";
import { git, objectReader, objectsBetween, store } from "../client/git.mjs";
import * as records from "../client/records.mjs";
import { keep, sponsored } from "../client/sponsor.mjs";
import { tip, view, volumeLoader } from "../client/state.mjs";
import { encode, fetchObjects } from "../client/transfer.mjs";
import { changes, transaction } from "../client/write.mjs";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const CHAIN = ["Nexus", "trellis"];
const author = { listen: 27001, rpc: 27080, publicRead: 27081 };
const reader = { listen: 27011, rpc: 27090, publicRead: 27091 };
const SPONSOR_PORT = 27095;
const authorNode = `http://127.0.0.1:${author.publicRead}`;
const sponsorURL = `http://127.0.0.1:${SPONSOR_PORT}`;
const LATTICE = process.env.LATTICE;
const LATTICE_SPONSOR = process.env.LATTICE_SPONSOR || join(dirname(LATTICE), "lattice-sponsor");

const host = (root) => ({
  root,
  lattice: (...args) => execFileSync(LATTICE, [...args, "--root", root], { encoding: "utf8" }),
  configure(edit) {
    const file = `${root}/lattice.json`;
    const topology = JSON.parse(readFileSync(file, "utf8"));
    edit(topology);
    writeFileSync(file, JSON.stringify(topology, null, 2));
  },
  cookie: () => readFileSync(`${root}/chains/Nexus/.cookie`, "utf8"),
});
const authors = host(mkdtempSync(`${tmpdir()}/trellis-e2e-`));
const readers = host(mkdtempSync(`${tmpdir()}/trellis-e2e-reader-`));
const work = mkdtempSync(`${tmpdir()}/trellis-e2e-repos-`);

async function until(label, condition, seconds = Number(process.env.E2E_SECONDS ?? 300)) {
  const deadline = Date.now() + seconds * 1000;
  let failure;
  for (;;) {
    const value = await condition().catch((error) => void (failure = error));
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`, { cause: failure });
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function account(address, at = authorNode) {
  const response = await fetch(`${at}/api/state/account/${address}?chainPath=${CHAIN.join("/")}`);
  return response.ok ? response.json() : {};
}

/** The chain's state at a node's tip, as a view. */
async function state(at = authorNode) {
  const volumes = new sdk.VolumeClient(new sdk.HTTPVolumeTransport(`${at}/volumes`, { chainPath: CHAIN }));
  const { generalStateCID } = await tip(sdk, at, CHAIN, volumes);
  return view(volumeLoader(volumes, sdk.decodeDagCbor), generalStateCID);
}

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

let sponsor;
try {
  // The host: Nexus and Nexus/trellis, a fee of 1 as on testnet, mined here.
  const minerKey = sdk.generatePrivateKey();
  const miner = sdk.accountFromPrivateKey(minerKey);
  authors.lattice("init");
  authors.configure((t) => {
    Object.assign(t, { ...author, webSocket: 0, publicSubmit: true, minRelayFee: 1 });
    t.publicReadExpensiveRate = 10000;
    t.publicReadRate = 10000;
    t.publicReadMaxRate = 100000;
    t.peers = [];
    t.mine = { worker: "cpu", workers: 1, batchSize: 100000 };
  });
  authors.lattice("up");
  authors.lattice("child", "create", CHAIN.join("/"), "--spec", here("./spec.json"), "--policy-module", here("../chain/trellis_policy.wasm"));
  authors.configure((t) => (t.mine.recipients = { [CHAIN.join("/")]: miner.address }));
  authors.lattice("mine", "start");
  await until("Nexus/trellis pays the miner", async () => BigInt((await account(miner.address)).balance ?? 0) > 1000n);
  console.log("Nexus/trellis is mined");

  // The sponsor: fees and storage for work, its own coins funded by the miner.
  const sponsorKey = `${authors.root}/sponsor-key.json`;
  execFileSync(LATTICE, ["key", "generate", "--out", sponsorKey]);
  const sponsorAddress = JSON.parse(readFileSync(sponsorKey, "utf8")).address;
  {
    const nonce = BigInt((await account(miner.address)).nonce ?? 0);
    const body = sdk.buildTransfer({ from: miner.address, to: sponsorAddress, amount: 500n, fee: 1n, nonce, chainPath: CHAIN });
    const { publicKey, signature } = sdk.signTransactionBody(body, minerKey);
    const r = await fetch(`${authorNode}/transactions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sdk.transactionPayload({ [publicKey]: signature }, body)) });
    assert.ok(r.ok, `fund the sponsor: ${r.status} ${await r.text()}`);
    await until("the sponsor is funded", async () => BigInt((await account(sponsorAddress)).balance ?? 0) >= 500n);
  }
  const log = openSync(`${authors.root}/sponsor.log`, "a");
  sponsor = spawn(LATTICE_SPONSOR, [
    "--node", `http://127.0.0.1:${author.rpc}`, "--cookie-file", `${authors.root}/chains/Nexus/.cookie`, "--key", sponsorKey,
    "--share-work", "2^12", "--fee", "1", "--most-pay", "0", "--port", String(SPONSOR_PORT),
    "--sell-storage", "--storage-rate", `${CHAIN.join("/")}=1000000`, "--storage-file", `${authors.root}/sponsor-storage.json`,
  ], { stdio: ["ignore", log, log] });
  await until("the sponsor takes work on Nexus/trellis", async () =>
    (await fetch(`${sponsorURL}/work`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chain: CHAIN.join("/") }) })).ok, 180);
  console.log("the sponsor takes work");

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
    t.publicReadExpensiveRate = 10000;
    t.publicReadRate = 10000;
    t.publicReadMaxRate = 100000;
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

  // Cloned through the reader's node.
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
  console.log("PASS");
} finally {
  sponsor?.kill();
  try { readers.lattice("down"); } catch {}
  try { authors.lattice("mine", "stop"); } catch {}
  try { authors.lattice("down"); } catch {}
}
