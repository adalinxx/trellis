// A real SHA-256 repository, every kind of object in it, through Lattice
// blocks and back into an empty repository: the same ids, `git fsck` clean,
// and the SSH signatures on a commit and a tag still verify.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as sdk from "../vendor/lattice-sdk.js";
import { git, objectReader, objectsBetween, requireSha256, store } from "./git.mjs";
import { MAX_BLOCK_BYTES, readObject } from "./objects.mjs";
import { encode, fetchObjects } from "./transfer.mjs";

const env = { GIT_AUTHOR_DATE: "2026-11-02T12:00:00Z", GIT_COMMITTER_DATE: "2026-11-02T12:00:00Z" };
const run = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, ...env } }).trim();

function newRepo(root) {
  mkdirSync(root);
  run(root, "init", "-q", "--object-format=sha256", "-b", "main");
  run(root, "config", "user.name", "Test");
  run(root, "config", "user.email", "test@example.com");
  return root;
}

/** A repository with every kind of object, signed and not. */
function sample() {
  const dir = mkdtempSync(join(tmpdir(), "trellis-test-"));
  const key = join(dir, "key");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "test", "-f", key]);
  const allowed = join(dir, "allowed");
  writeFileSync(allowed, `test@example.com ${execFileSync("cat", [`${key}.pub`], { encoding: "utf8" })}`);
  const repo = newRepo(join(dir, "source"));
  for (const [k, v] of [["gpg.format", "ssh"], ["user.signingkey", `${key}.pub`], ["gpg.ssh.allowedSignersFile", allowed]]) run(repo, "config", k, v);

  writeFileSync(join(repo, "README.md"), "# sample\n");
  writeFileSync(join(repo, "empty"), "");
  mkdirSync(join(repo, "src/deep"), { recursive: true });
  writeFileSync(join(repo, "src/deep/main.c"), "int main(void) { return 0; }\n");
  writeFileSync(join(repo, "run.sh"), "#!/bin/sh\necho hi\n");
  chmodSync(join(repo, "run.sh"), 0o755);
  symlinkSync("README.md", join(repo, "link"));
  // Over one Volume, so the blob is chunked; not all one byte, so chunks differ.
  const big = Buffer.alloc(2.5 * MAX_BLOCK_BYTES);
  for (let i = 0; i < big.length; i++) big[i] = (i * 2654435761) >>> 24;
  writeFileSync(join(repo, "big.bin"), big);
  run(repo, "add", "-A");
  // A submodule: a commit id from another repository, which Trellis keeps as an id.
  run(repo, "update-index", "--add", "--cacheinfo", `160000,${"ab".repeat(32)},vendor/sub`);
  run(repo, "commit", "-q", "-m", "first");

  run(repo, "checkout", "-q", "-b", "side");
  writeFileSync(join(repo, "side.txt"), "from the side\n");
  run(repo, "add", "-A");
  run(repo, "commit", "-q", "-m", "side");
  run(repo, "checkout", "-q", "main");
  writeFileSync(join(repo, "README.md"), "# sample\n\nmore\n");
  run(repo, "commit", "-q", "-S", "-am", "signed\n\nwith a body\n");
  run(repo, "merge", "-q", "--no-ff", "-m", "merge side", "side");
  run(repo, "tag", "-s", "-m", "release one", "v1");
  return { repo, dir, allowed };
}

test("every object goes to blocks and back unchanged", async () => {
  const { repo, dir, allowed } = sample();
  requireSha256(repo);
  const tag = git(repo, "rev-parse", "v1");
  const head = git(repo, "rev-parse", "main");
  const ids = [...objectsBetween(repo, [head]), tag];

  const reader = objectReader(repo);
  const known = new Map();
  let volumes;
  try {
    volumes = await encode(sdk, reader.read, ids, known);
  } finally {
    reader.close();
  }
  const blocks = new Map(volumes.flatMap((v) => Object.entries(v.entries)).map(([cid, b64]) => [cid, Buffer.from(b64, "base64")]));
  assert.ok(volumes.every((v) => Object.keys(v.entries).length === 1), "one block a Volume");
  assert.ok([...blocks.values()].every((b) => b.length <= MAX_BLOCK_BYTES + 1024), "every block fits one Volume");
  const headCID = known.get(head);
  assert.equal(readObject(sdk, headCID, blocks.get(headCID)).block.id, head, "a commit block names its git id");
  assert.equal(readObject(sdk, known.get(tag), blocks.get(known.get(tag))).type, "tag");

  // Into an empty repository, from the blocks alone.
  const copy = newRepo(join(dir, "copy"));
  const load = async (cid) => {
    const bytes = blocks.get(cid);
    if (!bytes) throw new Error(`missing ${cid}`);
    return new Uint8Array(bytes);
  };
  const objects = await fetchObjects(sdk, load, [known.get(tag)]);
  assert.equal(new Set(objects.map((o) => o.id)).size, ids.length, "the same objects, each once");
  for (const { id, cid } of objects) assert.equal(known.get(id), cid);
  store(copy, objects);
  run(copy, "update-ref", "refs/heads/main", head);
  run(copy, "update-ref", "refs/tags/v1", tag);
  run(copy, "fsck", "--strict", "--no-dangling");
  assert.equal(git(copy, "rev-parse", "main"), head);
  run(copy, "config", "gpg.ssh.allowedSignersFile", allowed);
  run(copy, "verify-commit", "main~1");
  run(copy, "verify-tag", "v1");
  assert.equal(git(copy, "show", "main:big.bin", "--format=").length > 0, true);
  assert.equal(git(copy, "cat-file", "-p", "main:link"), "README.md");
});

test("a fetch walks only what isn't held", async () => {
  const { repo } = sample();
  const head = git(repo, "rev-parse", "main");
  const reader = objectReader(repo);
  const known = new Map();
  const volumes = await encode(sdk, reader.read, objectsBetween(repo, [head]), known);
  reader.close();
  const blocks = new Map(volumes.flatMap((v) => Object.entries(v.entries)));
  const loaded = [];
  const load = async (cid) => (loaded.push(cid), new Uint8Array(Buffer.from(blocks.get(cid), "base64")));
  // Everything up to the first commit is held.
  const first = git(repo, "rev-list", "--max-parents=0", "main");
  const held = new Map();
  await fetchObjects(sdk, load, [known.get(first)], held);
  loaded.length = 0;
  const rest = await fetchObjects(sdk, load, [known.get(head)], held);
  assert.deepEqual(new Set(rest.map((o) => o.id)), new Set(objectsBetween(repo, [head], [first])));
  assert.ok(!loaded.includes(known.get(first)));
});

test("a push encodes only the new objects, linking to what the other side has", async () => {
  const { repo } = sample();
  const head = git(repo, "rev-parse", "main");
  const base = git(repo, "rev-parse", "main~1");
  const reader = objectReader(repo);
  const all = new Map();
  await encode(sdk, reader.read, objectsBetween(repo, [base]), all);
  // The other side has `base`: its CID is all that's known.
  const known = new Map([[base, all.get(base)]]);
  const volumes = await encode(sdk, reader.read, objectsBetween(repo, [head], [base]), known);
  reader.close();
  assert.equal(new Set(volumes.map((v) => v.cid)).size, volumes.length);
  assert.ok(volumes.some((v) => v.cid === known.get(head)));
  assert.ok(!volumes.some((v) => v.cid === all.get(base)));
});

test("a block that lies about its git id is refused", async () => {
  const { repo } = sample();
  const head = git(repo, "rev-parse", "main");
  const reader = objectReader(repo);
  const known = new Map();
  const volumes = await encode(sdk, reader.read, objectsBetween(repo, [head]), known);
  reader.close();
  const blocks = new Map(volumes.flatMap((v) => Object.entries(v.entries)).map(([cid, b64]) => [cid, new Uint8Array(Buffer.from(b64, "base64"))]));
  const real = sdk.decodeDagCbor(blocks.get(known.get(head)));
  const forged = sdk.encodeDagCbor({ ...real, id: "00".repeat(32) });
  const forgedCID = sdk.cidV1DagCbor(forged);
  blocks.set(forgedCID, forged);
  await assert.rejects(fetchObjects(sdk, async (cid) => blocks.get(cid), [forgedCID]), /claims git id/);
  // And bytes that are not their CID are no object at all.
  await assert.rejects(fetchObjects(sdk, async () => forged, [known.get(head)]), /not a git object block/);
});

test("a private repo's blocks are sealed, the same each time, and open only with its key", async () => {
  const { sealer, newRepoKey } = await import("./seal.mjs");
  const { repo, head } = await sealedSample();
  const seal = sealer(new Map([[1, newRepoKey()]]), 1);
  const objects = objectReader(repo);
  const encodeWith = async (with_) => {
    const known = new Map();
    const volumes = await encode(sdk, objects.read, objectsBetween(repo, [head]), known, { sealer: with_ });
    return { volumes, known };
  };
  let sealed, again, plainOnes;
  try {
    sealed = await encodeWith(seal);
    again = await encodeWith(seal);
    plainOnes = await encodeWith(undefined);
  } finally {
    objects.close();
  }
  assert.deepEqual(sealed.volumes.map((v) => v.cid), again.volumes.map((v) => v.cid), "sealing is deterministic");
  const blocks = new Map(sealed.volumes.flatMap((v) => Object.entries(v.entries)));
  const text = [...blocks.values()].map((b) => Buffer.from(b, "base64").toString("latin1")).join("");
  assert.ok(!text.includes("secret plans"), "no file text in the clear");
  assert.ok(!text.includes("Test"), "no author in the clear");
  assert.equal(new Set(plainOnes.volumes.map((v) => v.cid)).size > 0, true);
  assert.ok(sealed.volumes.every((v) => !plainOnes.volumes.some((p) => p.cid === v.cid)), "no block shared with the public encoding");
  const load = async (cid) => new Uint8Array(Buffer.from(blocks.get(cid), "base64"));
  const back = await fetchObjects(sdk, load, [sealed.known.get(head)], new Map(), { sealer: seal });
  assert.equal(back.at(-1).id, head);
  assert.equal(back.length, plainOnes.volumes.length > 0 ? back.length : 0);
  await assert.rejects(fetchObjects(sdk, load, [sealed.known.get(head)], new Map(), { sealer: sealer(new Map([[1, newRepoKey()]]), 1) }));
  await assert.rejects(fetchObjects(sdk, load, [sealed.known.get(head)]), /not a git object block/);
});

async function sealedSample() {
  const repo = mkdtempSync(join(tmpdir(), "trellis-sealed-"));
  const run = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  run("init", "-q", "--object-format=sha256", "-b", "main");
  run("config", "user.name", "Test");
  run("config", "user.email", "test@example.com");
  writeFileSync(join(repo, "plans.txt"), "secret plans\n");
  writeFileSync(join(repo, "big.bin"), Buffer.alloc(2.5 * (1 << 20), 3));
  run("add", "-A");
  run("commit", "-q", "-m", "first");
  return { repo, head: run("rev-parse", "main") };
}
