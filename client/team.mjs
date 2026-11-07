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
  const { readFileSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const { chainAt, parseAddress, setting } = await import("./remote.mjs");
  const { sponsored } = await import("./sponsor.mjs");
  const { changes, transaction } = await import("./write.mjs");

  const url = execFileSync("git", ["--git-dir", gitDir, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
  if (!url.startsWith("trellis::")) throw new Error(`origin is ${url}, not a trellis:: address`);
  const { owner, name } = parseAddress(url.slice("trellis::".length));
  const get = (key, variable) => setting(gitDir, key, variable);
  const urls = (get("node", "TRELLIS_NODE") ?? "").split(",").map((u) => u.trim().replace(/\/+$/, "")).filter(Boolean);
  if (!urls.length) throw new Error("set trellis.node (git config) first");
  const chainPath = (get("chain", "TRELLIS_CHAIN") ?? "Nexus/trellis").split("/");
  const chain = chainAt(urls, chainPath);
  const signer = () => {
    const keyFile = get("key", "TRELLIS_KEY");
    if (!keyFile) throw new Error("set trellis.key (git config) first");
    const privateKey = sdk.hexToBytes(JSON.parse(readFileSync(keyFile, "utf8")).privateKey);
    return { privateKey, address: sdk.accountFromPrivateKey(privateKey).address };
  };
  return {
    sdk,
    owner,
    name,
    chain,
    chainPath,
    signer,
    /** Writes `[key, value]` pairs as the key's account; resolves once they read back. */
    async write(writes, { say = () => {}, wait = Number(process.env.TRELLIS_WAIT_SECONDS ?? 600) * 1000 } = {}) {
      const sponsor = get("sponsor", "TRELLIS_SPONSOR");
      if (!sponsor) throw new Error("set trellis.sponsor (git config) first");
      const { privateKey, address } = signer();
      const actions = await changes(await chain.state(), writes);
      if (!actions.length) return 0;
      say(`writing ${actions.length} records, the fee paid with this machine's work`);
      const draft = transaction({ owner: address, actions, nonce: await chain.nonce(address), chainPath });
      const response = await chain.submit(await sponsored(sdk, sponsor, draft, privateKey));
      if (!response.ok) throw new Error(`refused: ${(await response.text()).replace(/\s+/g, " ").slice(0, 300)}`);
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
      .flatMap(([ref, word]) => records.ref(owner, name, ref, word.commit ?? undefined, { seq: word.seq + 1 })),
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
  const refs = await records.refs(sdk, await chain.state(), owner, name);
  if (!refs.size) throw new Error(`${owner}/${name} has no branches or tags`);
  const ids = [];
  for (const [ref, cid] of refs) {
    const id = readObject(sdk, cid, await chain.block(cid))?.block?.id;
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
  const known = new Map();
  const objects = objectReader(gitDir);
  let volumes;
  try {
    volumes = await encode(sdk, objects.read, objectsBetween(gitDir, ids.map(([, id]) => id), []), known);
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
  if (!who || who.includes("/")) throw new Error("name the account by its address");
  if (repo.signer().address !== owner) throw new Error(`only ${owner}, the owner, changes who maintains ${owner}/${name}`);
  if (who === owner) throw new Error("the owner always maintains the repo");
  const delegates = verb === "add" ? [...new Set([...(card.delegates ?? []), who])] : (card.delegates ?? []).filter((d) => d !== who);
  await repo.write(delegation(owner, name, card, await records.words(sdk, state, owner, name, card), delegates), { say });
  return records.maintainers(owner, { delegates });
}
