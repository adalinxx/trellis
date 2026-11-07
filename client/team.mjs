// `trellis maintainers`, in a repository whose `origin` is trellis::: who may
// push to the repo besides its owner. The owner adds and removes delegates on
// the repo's card; each maintainer then pushes with their own key, and the
// latest push to a ref stands (client/records.mjs).
import * as records from "./records.mjs";

/**
 * The repo `origin` names, and a way to write records as trellis.key's
 * account with the fee paid for work through trellis.sponsor.
 */
export async function origin(gitDir) {
  const sdk = await import("../vendor/lattice-sdk.js");
  const { execFileSync } = await import("node:child_process");
  const { chainAt, monikerAt, parseAddress, setting } = await import("./remote.mjs");
  const { addressOf } = await import("./names.mjs");
  const { changes } = await import("./write.mjs");

  const url = execFileSync("git", ["--git-dir", gitDir, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
  if (!url.startsWith("trellis::")) throw new Error(`origin is ${url}, not a trellis:: address`);
  const parsed = parseAddress(url.slice("trellis::".length));
  const get = (key, variable) => setting(gitDir, key, variable);
  const urls = (get("node", "TRELLIS_NODE") ?? "").split(",").map((u) => u.trim().replace(/\/+$/, "")).filter(Boolean);
  if (!urls.length) throw new Error("set trellis.node (git config) first");
  const moniker = monikerAt(gitDir, urls);
  const { name } = parsed;
  const owner = await addressOf(moniker, parsed.owner);
  const chainPath = (get("chain", "TRELLIS_CHAIN") ?? "Nexus/trellis").split("/");
  const chain = chainAt(urls, chainPath);
  const { signer: signerOf } = await import("./signer.mjs");
  const signer = (say) => signerOf(sdk, gitDir, { urls, say });
  return {
    sdk,
    owner,
    name,
    chain,
    chainPath,
    signer,
    /** `who` (an address or @handle) as an address. */
    addressOf: (who) => addressOf(moniker, who),
    /** Writes `[key, value]` pairs as the key's account; resolves once they read back. */
    async write(writes, { say = () => {}, what, wait = Number(process.env.TRELLIS_WAIT_SECONDS ?? 600) * 1000 } = {}) {
      const actions = await changes(await chain.state(), writes);
      if (!actions.length) return 0;
      say(`writing ${actions.length} records, the fee paid with this machine's work`);
      await signer(say).write(chain, chainPath, actions, what);
      for (const deadline = Date.now() + wait; ; ) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const state = await chain.state().catch(() => undefined);
        if (state && (await Promise.all(writes.map(async ([k, v]) => (await state.get(k)) === v))).every(Boolean)) return actions.length;
        if (Date.now() > deadline) throw new Error(`not mined within ${wait / 1000} s (TRELLIS_WAIT_SECONDS); run it again`);
      }
    },
  };
}

/**
 * The writes that make `card`'s delegates `delegates`. Refs that stand on a
 * dropped delegate's push are re-stated as the owner's, so dropping someone
 * leaves every branch where it is.
 */
export function delegation(owner, name, card, words, delegates) {
  const keep = new Set(records.maintainers(owner, { delegates }));
  return [
    ...records.repo(owner, name, { ...card, delegates }),
    ...[...words]
      .filter(([, word]) => !keep.has(word.by))
      .flatMap(([ref, word]) => records.ref(owner, name, ref, word.commit ?? undefined, { seq: records.nextSeq(word.seq) })),
  ];
}

/**
 * `trellis mirror <sponsor>`, in an up-to-date clone: every block of the
 * repo's branches and tags kept by another sponsor too (one the team runs,
 * say), so the repo outlives any one host. Blocks are the same however they
 * are made, so they are made from the clone, not downloaded.
 */
export async function mirror(gitDir, sponsor, { say = () => {} } = {}) {
  if (!sponsor) throw new Error("trellis mirror <sponsor url>");
  const { encode } = await import("./transfer.mjs");
  const { objectReader, objectsBetween, requireSha256 } = await import("./git.mjs");
  const { keepAll } = await import("./remote.mjs");
  const { readObject } = await import("./objects.mjs");
  requireSha256(gitDir);
  const { sdk, owner, name, chain, chainPath } = await origin(gitDir);
  const state = await chain.state();
  const card = await records.card(state, owner, name);
  const refs = await records.refs(sdk, state, owner, name, card ?? null);
  if (!refs.size) throw new Error(`${owner}/${name} has no branches or tags`);
  const { isPrivate, repoSealer } = await import("./private.mjs");
  let sealer;
  if (isPrivate(card)) {
    const me = (await origin(gitDir)).signer();
    if (!me.privateKey) throw new Error(`${owner}/${name} is private: mirroring it needs a member's key file`);
    sealer = repoSealer(owner, name, card, me.address, me.privateKey);
  }
  const ids = [];
  for (const [ref, cid] of refs) {
    const bytes = await chain.block(cid);
    const block = sealer ? sealer.open(sdk, cid, bytes) : { cid, bytes };
    const id = readObject(sdk, block.cid, block.bytes)?.block?.id;
    if (!id) throw new Error(`${ref}'s block isn't a commit or tag`);
    ids.push([ref, id, cid]);
  }
  const { execFileSync } = await import("node:child_process");
  const missing = ids.filter(([, id]) => {
    try {
      execFileSync("git", ["--git-dir", gitDir, "cat-file", "-e", id], { stdio: "ignore" });
      return false;
    } catch {
      return true;
    }
  });
  if (missing.length) throw new Error(`this clone lacks ${missing.map(([ref]) => ref).join(", ")}: git fetch origin first`);
  if (sealer) {
    // A private repo's blocks may be sealed with older keys than this clone
    // would seal with: keep them as the chain has them, every block walked
    // (and checked) from its refs.
    const { fetchObjects } = await import("./transfer.mjs");
    const sealed = new Map();
    await fetchObjects(sdk, async (cid) => {
      const bytes = await chain.block(cid);
      sealed.set(cid, bytes);
      return bytes;
    }, ids.map(([, , cid]) => cid), new Map(), { sealer });
    const volumes = [...sealed].map(([cid, bytes]) => ({ cid, entries: { [cid]: Buffer.from(bytes).toString("base64") } }));
    await keepAll(sdk, sponsor, chainPath, volumes, say);
    return volumes.length;
  }
  const known = new Map();
  const objects = objectReader(gitDir);
  let volumes;
  try {
    volumes = await encode(sdk, objects.read, objectsBetween(gitDir, ids.map(([, id]) => id), []), known, { sealer });
  } finally {
    objects.close();
  }
  for (const [ref, id, cid] of ids) if (known.get(id) !== cid) throw new Error(`${ref} made a different block here than on the chain`);
  await keepAll(sdk, sponsor, chainPath, volumes, say);
  return volumes.length;
}

/** `trellis maintainers [add|remove <address>]`. */
export async function maintainers(gitDir, verb, who, { say = () => {} } = {}) {
  const repo = await origin(gitDir);
  const { sdk, owner, name, chain } = repo;
  const state = await chain.state();
  const card = await records.card(state, owner, name);
  if (!card) throw new Error(`${owner}/${name} doesn't exist yet: push to it first`);
  const now = records.maintainers(owner, card);
  if (!verb) return now;
  if (verb !== "add" && verb !== "remove") throw new Error(`trellis maintainers add|remove <address>, not ${verb}`);
  if (!who || who.includes("/")) throw new Error("name the account by its address or @handle");
  who = await repo.addressOf(who);
  if (repo.signer().address !== owner) throw new Error(`only ${owner}, the owner, changes who maintains ${owner}/${name}`);
  if (who === owner) throw new Error("the owner always maintains the repo");
  const delegates = verb === "add" ? [...new Set([...(card.delegates ?? []), who])] : (card.delegates ?? []).filter((d) => d !== who);
  const next = await dealt(repo, state, card, { ...card, delegates });
  await repo.write(delegation(owner, name, next, await records.words(sdk, state, owner, name, card), delegates), { say });
  return records.maintainers(owner, { delegates });
}

/** `after`, with a private repo's keys dealt again for its members (private.mjs). */
async function dealt(repo, state, before, after) {
  const { isPrivate, redeal, boxOf } = await import("./private.mjs");
  if (!isPrivate(before)) return after;
  const me = repo.signer();
  if (!me.privateKey) throw new Error("dealing a private repo's keys needs a key file in trellis.key (Selfhold can't open them)");
  return redeal(repo.owner, repo.name, before, after, me.address, me.privateKey, (a) => boxOf(state, a));
}

/** `trellis readers [add|remove <address or @handle>]`: who reads a private repo without pushing. */
export async function readers(gitDir, verb, who, { say = () => {} } = {}) {
  const { isPrivate, members } = await import("./private.mjs");
  const repo = await origin(gitDir);
  const { owner, name, chain } = repo;
  const state = await chain.state();
  const card = await records.card(state, owner, name);
  if (!isPrivate(card)) throw new Error(`${owner}/${name} isn't private: anyone reads it`);
  const now = (card.readers ?? []).filter((r) => typeof r === "string");
  if (!verb) return now;
  if (verb !== "add" && verb !== "remove") throw new Error(`trellis readers add|remove <address>, not ${verb}`);
  if (!who) throw new Error("name the account by its address or @handle");
  who = await repo.addressOf(who);
  if (repo.signer().address !== owner) throw new Error(`only ${owner}, the owner, changes who reads ${owner}/${name}`);
  const list = verb === "add" ? [...new Set([...now, who])] : now.filter((r) => r !== who);
  const next = await dealt(repo, state, card, { ...card, readers: list });
  await repo.write(records.repo(owner, name, next), { say, what: `Readers of ${name}` });
  return members(owner, next).filter((m) => list.includes(m));
}

/**
 * `trellis private`, before the first push: makes `origin` a private repo,
 * whose blocks are sealed so only its members read them (seal.mjs). Its name,
 * branch names and members are public; issues and pull requests are off.
 */
export async function makePrivate(gitDir, { say = () => {} } = {}) {
  const { newPrivate, publishBox } = await import("./private.mjs");
  const { boxKeys } = await import("./seal.mjs");
  const repo = await origin(gitDir);
  const { sdk, owner, name, chain } = repo;
  const me = repo.signer();
  if (me.address !== owner) throw new Error(`only ${owner} makes ${owner}/${name}`);
  if (!me.privateKey) throw new Error("a private repo needs a key file in trellis.key (Selfhold can't open its keys)");
  const state = await chain.state();
  const card = await records.card(state, owner, name);
  if ((await records.refs(sdk, state, owner, name, card ?? null)).size || card) throw new Error(`${owner}/${name} already exists in the open: make a new repo private, before its first push`);
  await repo.write([...records.repo(owner, name, { private: newPrivate(owner, name, boxKeys(me.privateKey).publicKey) }), ...publishBox(owner, me.privateKey)], { say, what: `Make ${name} private` });
}

/**
 * `trellis release <tag> [--title <t>] [--notes <text>] [<file>...]`, by a
 * maintainer: the release of `tag`, its files kept by every sponsor in
 * trellis.sponsor first (paid with this machine's work), then its record.
 */
export async function release(gitDir, tag, { title, notes = "", files = [], say = () => {} } = {}) {
  if (!tag) throw new Error("trellis release <tag> [--title <title>] [--notes <text>] [<file>...]");
  const { readFileSync, statSync } = await import("node:fs");
  const { basename } = await import("node:path");
  const { fileVolumes } = await import("../vendor/storage-file.mjs");
  const { BLOB_TYPE } = await import("./objects.mjs");
  const { keepAll, setting } = await import("./remote.mjs");
  const collab = await import("./collab.mjs");
  const repo = await origin(gitDir);
  const { sdk, owner, name, chain, chainPath } = repo;
  const me = repo.signer(say).address;
  const card = await records.card(await chain.state(), owner, name);
  if (!records.maintainers(owner, card).includes(me)) throw new Error(`${me} isn't one of ${owner}/${name}'s maintainers`);
  await refusePrivate(card, "releases", owner, name);
  if (!(await records.refs(sdk, await chain.state(), owner, name, card ?? null)).has(`refs/tags/${tag}`)) throw new Error(`${owner}/${name} has no tag ${tag}: push it first`);
  const sponsors = (setting(gitDir, "sponsor", "TRELLIS_SPONSOR") ?? "").split(",").map((u) => u.trim()).filter(Boolean);
  if (files.length && !sponsors.length) throw new Error("set trellis.sponsor (git config) first: it keeps the files");
  const kept = [];
  for (const file of files) {
    const bytes = new Uint8Array(readFileSync(file));
    const volumes = fileVolumes(sdk, BLOB_TYPE, bytes);
    for (const sponsor of sponsors) await keepAll(sdk, sponsor, chainPath, volumes, say);
    kept.push({ name: basename(file), cid: volumes[0].cid, size: statSync(file).size });
  }
  const record = { ...(title && { title }), notes, time: Math.floor(Date.now() / 1000), ...(kept.length && { files: kept }) };
  if (!collab.releaseFiles(record.files)) throw new Error("file names must be distinct, without / and not starting with .");
  // A maintainer's release is under their own key, for the repo's name.
  await repo.write(collab.release(me, name, tag, record), { say, what: `Release ${tag} of ${name}` });
  return { tag, files: kept };
}

/** `trellis box`: publishes this key file's box key, so owners can make it a member of private repos. */
export async function publishOwnBox(gitDir, { say = () => {} } = {}) {
  const { publishBox } = await import("./private.mjs");
  const repo = await origin(gitDir);
  const me = repo.signer();
  if (!me.privateKey) throw new Error("a box key comes from a key file in trellis.key");
  await repo.write(publishBox(me.address, me.privateKey), { say, what: "Publish your box key" });
  return me.address;
}

/** `trellis check <name> pending|pass|fail [--summary <s>] [--url <u>] [--commit <rev>]`: a check result, from any CI. */
export async function postCheck(gitDir, name, state, { summary, url, commit = "HEAD", say = () => {} } = {}) {
  const { execFileSync } = await import("node:child_process");
  const { check } = await import("./checks.mjs");
  const repo = await origin(gitDir);
  await refusePrivate(await records.card(await repo.chain.state(), repo.owner, repo.name), "checks", repo.owner, repo.name);
  const id = execFileSync("git", ["--git-dir", gitDir, "rev-parse", `${commit}^{commit}`], { encoding: "utf8" }).trim();
  const me = repo.signer(say).address;
  await repo.write(check(me, repo.owner, repo.name, id, name, { state, summary, url, time: Math.floor(Date.now() / 1000) }), { say, what: `Check ${name}: ${state}` });
  return id;
}

/** `trellis runners [add|remove <address or @handle>]`: whose checks the repo counts, besides its maintainers. */
export async function runnersOf(gitDir, verb, who, { say = () => {} } = {}) {
  const repo = await origin(gitDir);
  const { owner, name, chain } = repo;
  const card = await records.card(await chain.state(), owner, name);
  if (!card) throw new Error(`${owner}/${name} doesn't exist yet: push to it first`);
  const now = Array.isArray(card.runners) ? card.runners : [];
  if (!verb) return now;
  if (verb !== "add" && verb !== "remove") throw new Error(`trellis runners add|remove <address>, not ${verb}`);
  if (!who) throw new Error("name the account by its address or @handle");
  who = await repo.addressOf(who);
  if (repo.signer().address !== owner) throw new Error(`only ${owner}, the owner, changes ${owner}/${name}'s runners`);
  const list = verb === "add" ? [...new Set([...now, who])] : now.filter((r) => r !== who);
  await repo.write(records.repo(owner, name, { ...card, runners: list }), { say, what: `Runners of ${name}` });
  return list;
}

/**
 * `trellis ci [--once] [--every <seconds>] [--name <check>]`: a runner. For
 * each branch of `origin` whose tip has no result of this check from this
 * runner, runs `.trellis/ci` from that commit in a scratch worktree, and
 * posts pending, then pass or fail with the output's last lines. It runs the
 * repo's own code, so run it for repos you trust, as any CI runner.
 */
export async function runCI(gitDir, { once = false, every = 60, check: checkName = "ci", say = () => {} } = {}) {
  const { execFileSync, spawnSync } = await import("node:child_process");
  const { existsSync, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { check, checks } = await import("./checks.mjs");
  const repo = await origin(gitDir);
  const me = repo.signer(say).address;
  const g = (...args) => execFileSync("git", ["--git-dir", gitDir, ...args], { encoding: "utf8" }).trim();
  for (;;) {
    g("fetch", "--quiet", "--prune", "origin");
    const card = await records.card(await repo.chain.state(), repo.owner, repo.name);
    await refusePrivate(card, "checks", repo.owner, repo.name);
    // Each tip once, under the first branch at it (origin/HEAD is not a branch).
    const tips = new Map();
    for (const line of g("for-each-ref", "--format=%(objectname) %(refname)", "refs/remotes/origin").split("\n")) {
      const [id, ref] = line.split(" ");
      if (id && ref !== "refs/remotes/origin/HEAD" && !tips.has(id)) tips.set(id, ref.slice("refs/remotes/".length));
    }
    for (const [id, branch] of tips) {
      const done = (await checks(await repo.chain.state(), repo.owner, repo.name, { ...card, runners: [me] }, id)).some((c) => c.check === checkName && c.by === me);
      if (done) continue;
      const post = (state, summary) => repo.write(check(me, repo.owner, repo.name, id, checkName, { state, summary, time: Math.floor(Date.now() / 1000) }), { say, what: `CI ${branch}` });
      // The commit's files only, with no .git link to this clone, no git
      // config and none of this process's environment: the code run can't
      // reach the runner's key or push as it.
      const dir = mkdtempSync(join(tmpdir(), "trellis-ci-"));
      const home = mkdtempSync(join(tmpdir(), "trellis-ci-home-"));
      try {
        const archive = spawnSync("git", ["--git-dir", gitDir, "archive", "--format=tar", id], { maxBuffer: 1 << 30 });
        if (archive.status !== 0) throw new Error(`git archive ${id}: ${archive.stderr}`);
        const untar = spawnSync("tar", ["-x", "-C", dir], { input: archive.stdout });
        if (untar.status !== 0) throw new Error(`tar: ${untar.stderr}`);
        if (!existsSync(join(dir, ".trellis/ci"))) {
          say(`${branch} ${id.slice(0, 10)}: no .trellis/ci, nothing to run`);
          await post("pass", "No .trellis/ci in this commit: nothing to run.");
          continue;
        }
        say(`${branch} ${id.slice(0, 10)}: running .trellis/ci`);
        await post("pending", `Running on ${me}.`);
        const env = { PATH: process.env.PATH, HOME: home, LANG: process.env.LANG ?? "C.UTF-8", TMPDIR: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", CI: "true", TRELLIS_COMMIT: id, TRELLIS_BRANCH: branch };
        const ran = spawnSync(join(dir, ".trellis/ci"), [], { cwd: dir, encoding: "utf8", maxBuffer: 64 << 20, timeout: 3600_000, env });
        const output = `${ran.stdout ?? ""}${ran.stderr ?? ""}`.trim().split("\n").slice(-20).join("\n");
        const ok = ran.status === 0;
        say(`${branch} ${id.slice(0, 10)}: ${ok ? "pass" : "fail"}`);
        await post(ok ? "pass" : "fail", `${ok ? "Passed" : ran.error ? `Didn't run: ${ran.error.message}` : `Exited ${ran.status ?? ran.signal}`}.\n\n${output}`.slice(0, 2000));
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    }
    if (once) return;
    await new Promise((resolve) => setTimeout(resolve, every * 1000));
  }
}

/** Releases and checks are public records: a private repo has none. */
async function refusePrivate(card, what, owner, name) {
  const { isPrivate } = await import("./private.mjs");
  if (isPrivate(card)) throw new Error(`${owner}/${name} is private, and ${what} are public records on the chain: it has none`);
}
