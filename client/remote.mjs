// git-remote-trellis: stock git pushes to and clones from Trellis.
//
//   git clone trellis::<owner>/<repo>
//   git push  trellis::<owner>/<repo> main
//
// <owner> is a Lattice account address. Settings, from git config or the
// environment:
//
//   trellis.node     TRELLIS_NODE     nodes' public read URLs, comma-separated; the first takes writes
//   trellis.sponsor  TRELLIS_SPONSOR  a lattice-sponsor: pays fees and keeps objects for work (no coins)
//   trellis.key      TRELLIS_KEY      a key file (`lattice key generate`), to push
//   trellis.chain    TRELLIS_CHAIN    the chain, Nexus/trellis by default
//
// It speaks git's remote-helper protocol (gitremote-helpers(7)) on stdin and
// stdout, and reports progress on stderr. Node only.
import { createInterface } from "node:readline";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import * as sdk from "../vendor/lattice-sdk.js";
import { git, objectReader, objectsBetween, requireSha256, store } from "./git.mjs";
import { readObject } from "./objects.mjs";
import * as records from "./records.mjs";
import { keep, sponsored, storageChain } from "./sponsor.mjs";
import { anyHost, tip, view, volumeLoader } from "./state.mjs";
import { encode, fetchObjects } from "./transfer.mjs";
import { changes, transaction } from "./write.mjs";

const say = (line) => process.stderr.write(`trellis: ${line}\n`);

function setting(gitDir, name, variable) {
  if (process.env[variable]) return process.env[variable];
  try {
    return execFileSync("git", ["--git-dir", gitDir, "config", "--get", `trellis.${name}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The address `trellis::<owner>/<repo>` names. */
export function parseAddress(address) {
  const match = /^([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(address.replace(/^trellis:\/\//, ""));
  if (!match) throw new Error(`not a Trellis address: ${address} (trellis::<owner>/<repo>)`);
  return { owner: match[1], name: records.checkName(match[2]) };
}

/** The chain as nodes serve it: state at the tip, blocks by CID, and where writes go. */
function chainAt(urls, chainPath) {
  const transports = urls.map((url) => new sdk.BatchingVolumeTransport(new sdk.HTTPVolumeTransport(`${url}/volumes`, { chainPath })));
  const client = new sdk.VolumeClient(anyHost(transports));
  // A node may answer 503 while it fetches new content from its peers.
  // Content is addressed by CID, so asking again is always safe.
  const volumes = {
    async get(cid) {
      const deadline = Date.now() + Number(process.env.TRELLIS_READ_SECONDS ?? 120) * 1000;
      for (let wait = 500; ; wait = Math.min(wait * 2, 5000)) {
        try {
          return await client.get(cid);
        } catch (error) {
          if (Date.now() + wait > deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
      }
    },
  };
  return {
    async state() {
      const { generalStateCID } = await tip(sdk, urls[0], chainPath, volumes);
      return view(volumeLoader(volumes, sdk.decodeDagCbor), generalStateCID);
    },
    block: async (cid) => (await volumes.get(cid)).bytes(cid),
    async nonce(address) {
      const response = await fetch(`${urls[0]}/api/state/account/${address}?chainPath=${chainPath.join("/")}`);
      return BigInt((response.ok ? await response.json() : {}).nonce ?? 0);
    },
    submit: (payload) =>
      fetch(`${urls[0]}/transactions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }),
  };
}

/**
 * The git ids this repository already turned into CIDs, kept in
 * `$GIT_DIR/trellis/cids` so a push or fetch never walks old history again.
 * Only objects the repository still has count.
 */
function cidCache(gitDir) {
  const dir = join(gitDir, "trellis");
  const file = join(dir, "cids");
  const byId = new Map();
  if (existsSync(file)) {
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => line.split(" "));
    const ids = lines.map(([id]) => id);
    const present = ids.length
      ? execFileSync("git", ["--git-dir", gitDir, "cat-file", "--batch-check=%(objectname) %(objecttype)"], { input: ids.join("\n") + "\n", encoding: "utf8", maxBuffer: 1 << 30 })
          .split("\n")
          .filter((line) => line && !line.endsWith(" missing"))
          .map((line) => line.split(" ")[0])
      : [];
    const have = new Set(present);
    for (const [id, cid] of lines) if (have.has(id)) byId.set(id, cid);
  }
  const saved = new Set(byId.keys());
  return {
    byId,
    byCID: () => new Map([...byId].map(([id, cid]) => [cid, id])),
    save() {
      const fresh = [...byId].filter(([id]) => !saved.has(id));
      if (fresh.length === 0) return;
      mkdirSync(dir, { recursive: true });
      appendFileSync(file, fresh.map(([id, cid]) => `${id} ${cid}\n`).join(""));
      fresh.forEach(([id]) => saved.add(id));
    },
  };
}

async function waitFor(label, condition, seconds) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    if (await condition().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (!process.env.GIT_DIR) throw new Error("git-remote-trellis runs under git (GIT_DIR is not set)");
  // git may pass it relative; every git command here runs with -C it.
  const gitDir = (process.env.GIT_DIR = resolve(process.env.GIT_DIR));
  const { owner, name } = parseAddress(argv[1] ?? argv[0]);
  const urls = (setting(gitDir, "node", "TRELLIS_NODE") ?? "").split(",").map((u) => u.trim().replace(/\/+$/, "")).filter(Boolean);
  if (urls.length === 0) throw new Error("no Trellis node: set trellis.node (git config) or TRELLIS_NODE");
  const chainPath = (setting(gitDir, "chain", "TRELLIS_CHAIN") ?? "Nexus/trellis").split("/");
  const chain = chainAt(urls, chainPath);
  const cache = cidCache(gitDir);

  // The remote's refs: ref name → { cid, id }, the id as the commit block claims it.
  let remote;
  const remoteRefs = async () => {
    if (remote) return remote;
    remote = new Map();
    const found = await records.refs(sdk, await chain.state(), owner, name);
    for (const [ref, cid] of found) {
      const object = readObject(sdk, cid, await chain.block(cid));
      if (object?.type === "commit" || object?.type === "tag") remote.set(ref, { cid, id: object.block.id });
    }
    return remote;
  };

  const out = (text) => process.stdout.write(text);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
  const next = async () => {
    const { value, done } = await lines.next();
    return done ? undefined : value;
  };

  for (let line; (line = await next()) !== undefined; ) {
    if (line === "") break;
    if (line === "capabilities") {
      out("fetch\npush\noption\nobject-format\n\n");
    } else if (line.startsWith("option ")) {
      out(line.startsWith("option object-format") ? "ok\n" : "unsupported\n");
    } else if (line === "list" || line === "list for-push") {
      const refs = await remoteRefs();
      out(":object-format sha256\n");
      for (const [ref, { id }] of refs) out(`${id} ${ref}\n`);
      if (refs.has("refs/heads/main")) out("@refs/heads/main HEAD\n");
      out("\n");
    } else if (line.startsWith("fetch ")) {
      const wanted = [];
      for (let l = line; l && l.startsWith("fetch "); l = await next()) wanted.push(l.split(" ")[1]);
      await fetchInto(wanted);
      out("\n");
    } else if (line.startsWith("push ")) {
      const specs = [];
      for (let l = line; l && l.startsWith("push "); l = await next()) specs.push(l.slice(5));
      out(await pushFrom(specs));
      out("\n");
    } else {
      throw new Error(`git asked for something this helper doesn't do: ${line}`);
    }
  }

  async function fetchInto(ids) {
    requireSha256(gitDir);
    const byId = new Map([...(await remoteRefs()).values()].map(({ id, cid }) => [id, cid]));
    const roots = ids.map((id) => byId.get(id)).filter(Boolean);
    const held = cache.byCID();
    say(`fetching ${owner}/${name}`);
    const objects = await fetchObjects(sdk, chain.block, roots, held);
    store(gitDir, objects);
    for (const { id, cid } of objects) cache.byId.set(id, cid);
    cache.save();
    say(`fetched ${objects.length} objects`);
  }

  async function pushFrom(specs) {
    requireSha256(gitDir);
    const keyFile = setting(gitDir, "key", "TRELLIS_KEY");
    const sponsor = setting(gitDir, "sponsor", "TRELLIS_SPONSOR");
    const fail = (why) => specs.map((spec) => `error ${spec.split(":")[1]} ${why}\n`).join("");
    if (!keyFile) return fail("no key: set trellis.key (git config) or TRELLIS_KEY to a key file");
    if (!sponsor) return fail("no sponsor: set trellis.sponsor (git config) or TRELLIS_SPONSOR");
    const key = JSON.parse(readFileSync(keyFile, "utf8"));
    const me = sdk.accountFromPrivateKey(sdk.hexToBytes(key.privateKey));
    if (me.address !== owner) return fail(`this key is ${me.address}; push to trellis::${me.address}/${name}`);

    const refs = await remoteRefs();
    const updates = [];
    const replies = [];
    for (const spec of specs) {
      const force = spec.startsWith("+");
      const [src, dst] = spec.replace(/^\+/, "").split(":");
      try {
        records.checkRef(dst);
      } catch (error) {
        replies.push(`error ${dst} ${error.message}\n`);
        continue;
      }
      const id = src === "" ? undefined : git(gitDir, "rev-parse", src);
      const old = refs.get(dst);
      if (id && old && !force && old.id !== id) {
        let ancestor = false;
        try {
          execFileSync("git", ["--git-dir", gitDir, "merge-base", "--is-ancestor", old.id, id], { stdio: "ignore" });
          ancestor = true;
        } catch {}
        if (!ancestor) {
          replies.push(`error ${dst} non-fast-forward\n`);
          continue;
        }
      }
      updates.push({ dst, id });
      replies.push(`ok ${dst}\n`);
    }
    const moving = updates.filter((u) => u.id);
    if (updates.length === 0) return replies.join("");

    // What the remote has stands in for all it holds: its refs' CIDs.
    const known = new Map(cache.byId);
    for (const { id, cid } of refs.values()) known.set(id, cid);
    const have = [...refs.values()].map((r) => r.id).filter(existsObject);
    const objects = objectReader(gitDir);
    let volumes;
    try {
      volumes = await encode(sdk, objects.read, objectsBetween(gitDir, moving.map((u) => u.id), have), known);
    } finally {
      objects.close();
    }
    for (const [id, cid] of known) cache.byId.set(id, cid);
    cache.save();

    if (volumes.length > 0) {
      const workOn = await storageChain(sponsor, chainPath.join("/"));
      if (!workOn) return fail("the sponsor keeps no files (no storage rate in its /terms)");
      say(`keeping ${volumes.length} blocks through the sponsor, paid with this machine's work`);
      await keep(sdk, sponsor, workOn, volumes, { progress: ({ stored, total }) => say(`kept ${stored}/${total}`) });
    }

    const state = await chain.state();
    const writes = [
      ...((await records.card(state, owner, name)) ? [] : records.repo(owner, name, {})),
      ...updates.flatMap(({ dst, id }) => records.ref(owner, name, dst, id && known.get(id))),
    ];
    const actions = await changes(state, writes);
    if (actions.length > 0) {
      say("writing refs, the fee paid with this machine's work");
      const draft = transaction({ owner, actions, nonce: await chain.nonce(owner), chainPath });
      const payload = await sponsored(sdk, sponsor, draft, sdk.hexToBytes(key.privateKey));
      const response = await chain.submit(payload);
      if (!response.ok) {
        const why = (await response.text()).replace(/\s+/g, " ").slice(0, 200);
        return updates.map(({ dst }) => `error ${dst} refused: ${why}\n`).join("") + replies.filter((r) => r.startsWith("error")).join("");
      }
      await waitFor("the refs to be mined", async () => {
        const now = await chain.state();
        for (const [k, v] of writes) if ((await now.get(k)) !== v) return false;
        return true;
      }, Number(process.env.TRELLIS_WAIT_SECONDS ?? 600));
    }
    return replies.join("");
  }

  function existsObject(id) {
    try {
      execFileSync("git", ["--git-dir", gitDir, "cat-file", "-e", id], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
}
