// A GitHub repo's issues and pull requests, with their comments and labels,
// as Trellis records (client/collab.mjs) written by whoever imports them. The
// people who wrote them on GitHub can't sign for them here, so each record
// says who wrote it, and links where. Ids come from the GitHub URLs, so an
// import run again writes only what changed.
//
// A pull request comes in as an issue labelled "pull request": its branches
// are GitHub's, not the Trellis repo's, so there is nothing to merge here.
import { createHash } from "node:crypto";
import * as collab from "./collab.mjs";

/** The 16-hex id for something on GitHub, by its URL. */
export const githubId = (url) => createHash("sha256").update(url).digest("hex").slice(0, 16);

const seconds = (iso) => Math.floor(Date.parse(iso) / 1000);
const clip = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
const who = (user) => `@${user?.login ?? "ghost"}`;

/** `owner/name` from `https://github.com/owner/name(.git)` or `owner/name`. */
export function githubRepo(source) {
  const match = /^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(source.trim());
  if (!match) throw new Error(`not a GitHub repo: ${source} (https://github.com/<owner>/<name>)`);
  return `${match[1]}/${match[2]}`;
}

/**
 * The writes, as `me`, that bring `items` (GitHub's issues listing: issues and
 * pull requests) and `comments` (its issue comments listing) to `me/name`.
 */
export function githubRecords(me, name, items, comments) {
  const writes = [];
  const byNumber = new Map();
  for (const item of items) {
    const id = githubId(item.html_url);
    byNumber.set(item.number, id);
    const pull = Boolean(item.pull_request);
    const outcome = pull ? (item.pull_request.merged_at ? "merged" : item.state) : undefined;
    const header = pull
      ? `_Pull request #${item.number} by ${who(item.user)} on GitHub, ${outcome}: ${item.html_url}_`
      : `_Issue #${item.number} by ${who(item.user)} on GitHub: ${item.html_url}_`;
    const closed = item.state === "closed";
    writes.push(
      ...collab.issue(me, id, {
        repo: `${me}/${name}`,
        title: clip(item.title.trim() || `#${item.number}`, 300),
        body: clip(`${header}\n\n${item.body ?? ""}`.trim(), 65536),
        time: seconds(item.created_at),
        ...(closed && { state: "closed", updated: seconds(item.closed_at ?? item.updated_at) }),
      }),
    );
    // A GitHub label Trellis can't hold whole (one with a comma) is left out, not split.
    const names = [...(item.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)), ...(pull ? ["pull request"] : [])];
    const labels = collab.labelsOf(names.filter((n) => !n.includes(",")).join(","));
    if (labels.length) writes.push(...collab.triage(me, me, name, me, id, { labels, time: seconds(item.created_at) }));
  }
  for (const comment of comments) {
    const on = byNumber.get(Number(comment.issue_url?.split("/").pop()));
    if (!on || !comment.body?.trim()) continue;
    writes.push(
      ...collab.post(me, githubId(comment.html_url), {
        on: `${me}/${on}`,
        body: clip(`_${who(comment.user)} on GitHub: ${comment.html_url}_\n\n${comment.body}`, 65536),
        time: seconds(comment.created_at),
      }),
    );
  }
  return writes;
}

/**
 * Every page of a GitHub API listing. Unauthenticated, GitHub allows 60
 * requests an hour; with GITHUB_TOKEN set, 5,000.
 */
export async function githubListing(path, { token = process.env.GITHUB_TOKEN, progress = () => {} } = {}) {
  const out = [];
  for (let url = `https://api.github.com${path}${path.includes("?") ? "&" : "?"}per_page=100`; url; ) {
    const response = await fetch(url, { headers: { Accept: "application/vnd.github+json", ...(token && { Authorization: `Bearer ${token}` }) } });
    if (!response.ok) {
      const limited = response.headers.get("x-ratelimit-remaining") === "0";
      throw new Error(`GitHub: HTTP ${response.status} for ${url}${limited ? " (rate limit: set GITHUB_TOKEN)" : ""}`);
    }
    out.push(...(await response.json()));
    progress(out.length);
    url = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1];
  }
  return out;
}

/**
 * `trellis import-issues <github repo>`, in a repository whose `origin` is
 * `trellis::<owner>/<name>`: brings the GitHub repo's issues, pull requests,
 * comments and labels to it, signed with trellis.key (which must be the
 * owner's) and paid for with this machine's work through trellis.sponsor.
 * Written in transactions of up to `chunk` bytes, one after another.
 */
export async function importIssues(source, { gitDir, say = () => {}, chunk = 400_000 } = {}) {
  const sdk = await import("../vendor/lattice-sdk.js");
  const { readFileSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const { chainAt, parseAddress, setting } = await import("./remote.mjs");
  const { sponsored } = await import("./sponsor.mjs");
  const { changes, transaction } = await import("./write.mjs");

  const repo = githubRepo(source);
  const origin = execFileSync("git", ["--git-dir", gitDir, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
  if (!origin.startsWith("trellis::")) throw new Error(`origin is ${origin}, not a trellis:: address`);
  const { owner, name } = parseAddress(origin.slice("trellis::".length));
  const get = (key, variable) => setting(gitDir, key, variable);
  const urls = (get("node", "TRELLIS_NODE") ?? "").split(",").map((u) => u.trim().replace(/\/+$/, "")).filter(Boolean);
  const keyFile = get("key", "TRELLIS_KEY");
  const sponsor = get("sponsor", "TRELLIS_SPONSOR");
  if (!urls.length || !keyFile || !sponsor) throw new Error("set trellis.node, trellis.key and trellis.sponsor (git config) first");
  const privateKey = sdk.hexToBytes(JSON.parse(readFileSync(keyFile, "utf8")).privateKey);
  if (sdk.accountFromPrivateKey(privateKey).address !== owner) throw new Error(`trellis.key isn't ${owner}'s, whose repo origin is`);
  const chainPath = (get("chain", "TRELLIS_CHAIN") ?? "Nexus/trellis").split("/");
  const chain = chainAt(urls, chainPath);

  say(`reading ${repo}'s issues and pull requests from GitHub`);
  const items = await githubListing(`/repos/${repo}/issues?state=all`, { progress: (n) => say(`  ${n} issues and pull requests`) });
  const comments = await githubListing(`/repos/${repo}/issues/comments`, { progress: (n) => say(`  ${n} comments`) });
  const writes = githubRecords(owner, name, items, comments);
  const actions = await changes(await chain.state(), writes);
  if (!actions.length) {
    say("nothing new to write");
    return { items: items.length, comments: comments.length, written: 0 };
  }

  const batches = [[]];
  let size = 0;
  for (const action of actions) {
    const bytes = JSON.stringify(action).length;
    if (size + bytes > chunk && batches.at(-1).length) batches.push([]), (size = 0);
    batches.at(-1).push(action);
    size += bytes;
  }
  const wait = Number(process.env.TRELLIS_WAIT_SECONDS ?? 600) * 1000;
  for (const [i, batch] of batches.entries()) {
    say(`writing ${i + 1}/${batches.length}: ${batch.length} records, the fee paid with this machine's work`);
    const draft = transaction({ owner, actions: batch, nonce: await chain.nonce(owner), chainPath });
    const response = await chain.submit(await sponsored(sdk, sponsor, draft, privateKey));
    if (!response.ok) throw new Error(`refused: ${(await response.text()).replace(/\s+/g, " ").slice(0, 300)}`);
    // Landed once its first and last records read back (a run again mends any gap).
    const ends = [batch[0], batch.at(-1)];
    for (const deadline = Date.now() + wait; ; ) {
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      const state = await chain.state().catch(() => undefined);
      if (state && (await Promise.all(ends.map(async (a) => (await state.get(a.key)) === a.newValue))).every(Boolean)) break;
      if (Date.now() > deadline) throw new Error(`write ${i + 1} wasn't mined within ${wait / 1000} s (TRELLIS_WAIT_SECONDS); run the import again to go on: it writes only what is missing`);
    }
  }
  return { items: items.length, comments: comments.length, written: actions.length };
}
