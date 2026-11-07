// git-remote-trellis: stock git pushes to and clones from Trellis.
//
//   git clone trellis::<owner>/<repo>
//   git push  trellis::<owner>/<repo> main
//
// <owner> is a Lattice account address. Settings, from git config or the
// environment:
//
//   trellis.node     TRELLIS_NODE     nodes' public read URLs, comma-separated; the first takes writes
//   trellis.sponsor  TRELLIS_SPONSOR  lattice-sponsors, comma-separated: each keeps the objects for work
//                                     (no coins); the first also pays the fee
//   trellis.key      TRELLIS_KEY      a key file (`lattice key generate`), to push
//   trellis.chain    TRELLIS_CHAIN    the chain, Nexus/trellis by default
//   trellis.moniker  TRELLIS_MONIKER  where @handles are read, Nexus/moniker by default
//
// <owner> may be an @handle: the account that shows it on Moniker now.
// It speaks git's remote-helper protocol (gitremote-helpers(7)) on stdin and
// stdout, and reports progress on stderr. Node only.
import { createInterface } from "node:readline";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import * as sdk from "../vendor/lattice-sdk.js";
import { git, objectReader, objectsBetween, requireSha256, store } from "./git.mjs";
import { readObject } from "./objects.mjs";
import { addressOf } from "./names.mjs";
import { boxOf, isPrivate, publishBox, repoSealer } from "./private.mjs";
import * as records from "./records.mjs";
import { keep, storageChain } from "./sponsor.mjs";
import { anyHost, heldFirst, tip, view, volumeLoader } from "./state.mjs";
import { encode, fetchObjects } from "./transfer.mjs";
import { changes } from "./write.mjs";
import { signer } from "./signer.mjs";

const say = (line) => process.stderr.write(`trellis: ${line}\n`);

export function setting(gitDir, name, variable) {
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
  if (!match) throw new Error(`not a Trellis address: ${address} (trellis::<owner or @handle>/<repo>)`);
  return { owner: match[1], name: records.checkName(match[2]) };
}

/** Moniker's state, read where @handles live (trellis.moniker, Nexus/moniker by default). */
export const monikerAt = (gitDir, urls) => () => chainAt(urls, (setting(gitDir, "moniker", "TRELLIS_MONIKER") ?? "Nexus/moniker").split("/")).state();

/** The public read URLs of the nodes that host `chainPath`, as `url` knows them; none if it can't say. */
export async function endpoints(url, chainPath) {
  try {
    const response = await fetch(`${url}/api/chain/endpoints?chainPath=${chainPath.join("/")}`, { signal: AbortSignal.timeout(10_000) });
    const found = response.ok ? (await response.json()).endpoints : [];
    return (Array.isArray(found) ? found : []).filter((u) => typeof u === "string" && /^https?:\/\//.test(u)).map((u) => u.replace(/\/+$/, ""));
  } catch {
    return [];
  }
}

/** The chain as nodes serve it: state at the tip, blocks by CID, and where writes go. */
export function chainAt(urls, chainPath) {
  const transports = urls.map((url) => new sdk.BatchingVolumeTransport(new sdk.HTTPVolumeTransport(`${url}/volumes`, { chainPath })));
  // Every node that hosts the chain, as the first lists them, is asked for
  // the blocks it holds before any node fetches one from its peers.
  let hosts;
  const allHosts = () =>
    (hosts ??= endpoints(urls[0], chainPath).then((found) =>
      [...new Set([...urls, ...found])].map((url) => new sdk.HTTPVolumeTransport(`${url}/volumes`, { chainPath })),
    ));
  const client = new sdk.VolumeClient(heldFirst(allHosts, anyHost(transports)));
  // A node may answer 503 while it fetches new content from its peers, one
  // or a few Volumes at a time, so one read can wait behind many others.
  // Content is addressed by CID, so asking again is always safe; give up only
  // when no read has succeeded for TRELLIS_READ_SECONDS.
  const patience = Number(process.env.TRELLIS_READ_SECONDS ?? 120) * 1000;
  let progress = Date.now();
  const volumes = {
    async get(cid) {
      for (let wait = 500; ; wait = Math.min(wait * 2, 5000)) {
        try {
          const volume = await client.get(cid);
          progress = Date.now();
          return volume;
        } catch (error) {
          if (Date.now() + wait - progress > patience) throw error;
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

/** Every block in `volumes` kept by `sponsor`, paid with this machine's work. */
export async function keepAll(sdk, sponsor, chainPath, volumes, say = () => {}) {
  const workOn = await storageChain(sponsor, chainPath.join("/"));
  if (!workOn) throw new Error("it keeps no files (no storage rate in its /terms)");
  say(`keeping ${volumes.length} blocks through ${sponsor}`);
  await keep(sdk, sponsor, workOn, volumes, { progress: ({ stored, total }) => say(`kept ${stored}/${total}`) });
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
  const parsed = parseAddress(argv[1] ?? argv[0]);
  const urls = (setting(gitDir, "node", "TRELLIS_NODE") ?? "").split(",").map((u) => u.trim().replace(/\/+$/, "")).filter(Boolean);
  if (urls.length === 0) throw new Error("no Trellis node: set trellis.node (git config) or TRELLIS_NODE");
  const chainPath = (setting(gitDir, "chain", "TRELLIS_CHAIN") ?? "Nexus/trellis").split("/");
  let { name } = parsed;
  let owner = await addressOf(monikerAt(gitDir, urls), parsed.owner);
  const chain = chainAt(urls, chainPath);
  const cache = cidCache(gitDir);
  // A moved repo (both cards say so) is fetched from and pushed to where it is now.
  {
    const now = await records.whereNow(await chain.state(), owner, name);
    if (now.moved) {
      say(`${owner}/${name} moved to ${now.owner}/${now.name}; using it there (git remote set-url origin trellis::${now.owner}/${now.name})`);
      ({ owner, name } = now);
    }
  }

  // The remote's refs: ref name → { cid, id }, the id as the commit block claims it.
  let remote, card, sealing;
  // A private repo's blocks are sealed (seal.mjs): reading or pushing them
  // needs a member's key file.
  const sealerFor = () => {
    if (!isPrivate(card)) return undefined;
    if (sealing) return sealing;
    const keyFile = setting(gitDir, "key", "TRELLIS_KEY");
    if (!keyFile || keyFile === "selfhold") throw new Error(`${owner}/${name} is private: reading it needs a member's key file in trellis.key`);
    const privateKey = sdk.hexToBytes(JSON.parse(readFileSync(keyFile, "utf8")).privateKey);
    sealing = repoSealer(owner, name, card, sdk.accountFromPrivateKey(privateKey).address, privateKey);
    return sealing;
  };
  const openBlock = async (cid) => {
    const bytes = await chain.block(cid);
    return sealerFor() ? sealerFor().open(sdk, cid, bytes) : { cid, bytes };
  };
  const remoteRefs = async () => {
    if (remote) return remote;
    remote = new Map();
    const state = await chain.state();
    card = await records.card(state, owner, name);
    sealing = undefined; // the card's newest key, as it is now
    for (const [ref, word] of await records.words(sdk, state, owner, name, card ?? null)) {
      if (!word.commit) {
        remote.set(ref, { seq: word.seq });
        continue;
      }
      const block = await openBlock(word.commit);
      const object = readObject(sdk, block.cid, block.bytes);
      if (object?.type === "commit" || object?.type === "tag") remote.set(ref, { cid: word.commit, id: object.block.id, seq: word.seq });
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
      for (const [ref, { id }] of refs) if (id) out(`${id} ${ref}\n`);
      // HEAD: main, else master, else the first branch.
      const branches = [...refs.keys()].filter((ref) => ref.startsWith("refs/heads/")).sort();
      const head = ["refs/heads/main", "refs/heads/master"].find((ref) => refs.has(ref)) ?? branches[0];
      if (head) out(`@${head} HEAD\n`);
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
    const byId = new Map([...(await remoteRefs()).values()].filter(({ id }) => id).map(({ id, cid }) => [id, cid]));
    const roots = ids.map((id) => byId.get(id)).filter(Boolean);
    const held = cache.byCID();
    say(`fetching ${owner}/${name}`);
    const objects = await fetchObjects(sdk, chain.block, roots, held, { sealer: sealerFor() });
    store(gitDir, objects);
    for (const { id, cid } of objects) cache.byId.set(id, cid);
    cache.save();
    say(`fetched ${objects.length} objects`);
  }

  async function pushFrom(specs) {
    requireSha256(gitDir);
    const sponsors = (setting(gitDir, "sponsor", "TRELLIS_SPONSOR") ?? "").split(",").map((u) => u.trim()).filter(Boolean);
    const sponsor = sponsors[0];
    const fail = (why) => specs.map((spec) => `error ${spec.split(":")[1]} ${why}\n`).join("");
    if (!sponsor) return fail("no sponsor: set trellis.sponsor (git config) or TRELLIS_SPONSOR");
    let me;
    try {
      me = signer(sdk, gitDir, { say, urls });
    } catch (error) {
      return fail(error.message);
    }
    const refs = await remoteRefs();
    if (!records.maintainers(owner, card).includes(me.address)) {
      return fail(`this key is ${me.address}, not one of ${owner}/${name}'s maintainers; push to trellis::${me.address}/${name}`);
    }
    if (!card && me.address !== owner) return fail(`${owner}/${name} doesn't exist`);
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
      const old = refs.get(dst)?.id && refs.get(dst);
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
    }
    const moving = updates.filter((u) => u.id);
    if (updates.length === 0) return replies.join("");

    // What the remote has stands in for all it holds: its refs' CIDs.
    const known = new Map(cache.byId);
    for (const { id, cid } of refs.values()) if (id) known.set(id, cid);
    const have = [...refs.values()].map((r) => r.id).filter((id) => id && existsObject(id));
    const objects = objectReader(gitDir);
    let volumes;
    try {
      volumes = await encode(sdk, objects.read, objectsBetween(gitDir, moving.map((u) => u.id), have), known, { sealer: sealerFor() });
    } finally {
      objects.close();
    }
    if (volumes.length > 0) {
      const workOn = await storageChain(sponsor, chainPath.join("/"));
      if (!workOn) return fail("the sponsor keeps no files (no storage rate in its /terms)");
      say(`keeping ${volumes.length} blocks through the sponsor, paid with this machine's work`);
      await keep(sdk, sponsor, workOn, volumes, { progress: ({ stored, total }) => say(`kept ${stored}/${total}`) });
      // More sponsors keep more copies; one that can't now is caught up by `trellis mirror`.
      for (const other of sponsors.slice(1)) {
        try {
          await keepAll(sdk, other, chainPath, volumes, say);
        } catch (error) {
          say(`${other} didn't keep them (${error.message}); run \`trellis mirror ${other}\` later`);
        }
      }
    }
    // Only now: the cache stands for what is kept, and a push that stopped
    // before every block was kept must send them again.
    for (const [id, cid] of known) cache.byId.set(id, cid);
    cache.save();

    const state = await chain.state();
    // A ref already where it's asked to be needs no word.
    const moved = updates.filter(({ dst, id }) => (refs.get(dst)?.cid ?? undefined) !== (id && known.get(id)));
    const writes = [
      ...(card ? [] : records.repo(owner, name, {})),
      // A key-file account publishes its box key once, so it can be made a member of private repos.
      ...(me.privateKey && !(await boxOf(state, me.address)) ? publishBox(me.address, me.privateKey) : []),
      ...moved.flatMap(({ dst, id }) => records.ref(owner, name, dst, id && known.get(id), { as: me.address, seq: records.nextSeq(refs.get(dst)?.seq ?? 0) })),
    ];
    const actions = await changes(state, writes);
    if (actions.length > 0) {
      say("writing refs, the fee paid with this machine's work");
      try {
        await me.write(chain, chainPath, actions, `Push to ${parsed.owner}/${name}`);
      } catch (error) {
        const why = error.message.replace(/\s+/g, " ").slice(0, 200);
        return updates.map(({ dst }) => `error ${dst} ${why}\n`).join("") + replies.filter((r) => r.startsWith("error")).join("");
      }
      await waitFor("the refs to be mined", async () => {
        const now = await chain.state();
        for (const [k, v] of writes) if ((await now.get(k)) !== v) return false;
        return true;
      }, Number(process.env.TRELLIS_WAIT_SECONDS ?? 600));
    }
    // Another maintainer's push can land in the same block with the same seq,
    // and only one word stands; say which refs this push didn't move.
    const now = moved.length ? await records.words(sdk, await chain.state(), owner, name) : new Map();
    for (const { dst, id } of updates) {
      const lost = moved.some((u) => u.dst === dst) && (now.get(dst)?.commit ?? undefined) !== (id && known.get(id));
      replies.push(lost ? `error ${dst} another maintainer pushed to it at the same time; fetch and push again\n` : `ok ${dst}\n`);
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
