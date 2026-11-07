// Trellis in the browser: a repo's branches from the chain's state, its code
// from Lattice content, one block at a time, only the blocks a page shows.
// Every block is checked against its CID, so the node is trusted to serve
// the code, never to serve it correctly. Issues, pull requests, comments,
// line reviews, labels and releases are records the reader writes through
// Selfhold, which holds their key; a sponsor takes this device's work for
// each fee, so taking part needs no coins. No server of its own.
import * as sdk from "../vendor/lattice-sdk.js";
import * as records from "../client/records.mjs";
import { fileVolumes } from "../vendor/storage-file.mjs";
import { BLOB_TYPE } from "../client/objects.mjs";
import { keep, storageChain } from "../client/sponsor.mjs";
import { tip, view, volumeLoader } from "../client/state.mjs";
import { hunks, isText, lineDiff, lines, reader } from "../client/browse.mjs";
import * as collab from "../client/collab.mjs";
import { checks as checksOn, overall } from "../client/checks.mjs";
import { changes } from "../client/write.mjs";
import { selfhold } from "./vendor/selfhold.mjs";
import { Marked } from "./vendor/marked.esm.js";
import { ago, bytes, defaultBranch, esc, fullRef, href, imageType, linkTarget, parseRoute, shortAccount as shortId, shortRef, subject } from "./lib.mjs";
import { accountOf, addressOf, handleOf } from "../client/names.mjs";

const $ = (s) => document.querySelector(s);
const DEFAULTS = {
  node: "https://lattice-testnet-apps-iad.fly.dev",
  chain: "Nexus/testnet/trellis",
  // Takes this device's work for each write's fee.
  sponsor: "https://lattice-testnet-apps-iad.fly.dev:8650/sponsor",
};
// Selfhold's window. A page served on this computer may use one served on
// this computer too (the tests do); never any other: the window keeps the account.
const WALLET_PAGE = "https://wallet.selfhold.app/";
const local = (host) => host === "localhost" || host === "127.0.0.1";
function walletPage(asked) {
  try {
    const url = new URL(asked);
    if (url.protocol === "http:" && local(url.hostname) && local(location.hostname) && !url.username && !url.password) return url.href;
  } catch {}
  return WALLET_PAGE;
}
// The largest file shown without asking, and the largest diffed.
const SHOW_BYTES = 2 << 20;
const DIFF_BYTES = 512 << 10;

const saved = (key) => {
  try {
    return localStorage.getItem(`trellis:${key}`);
  } catch {
    return null;
  }
};
const save = (key, value) => {
  try {
    if (value) localStorage.setItem(`trellis:${key}`, value);
    else localStorage.removeItem(`trellis:${key}`);
  } catch {}
};
// ?node=, ?chain= and ?sponsor= on the page's URL win over what Settings saved.
const query = new URLSearchParams(location.search);
const settings = {
  node: (query.get("node") || saved("node") || DEFAULTS.node).replace(/\/+$/, ""),
  chain: query.get("chain") || saved("chain") || DEFAULTS.chain,
  moniker: query.get("moniker") || saved("moniker") || "Nexus/moniker",
  sponsor: query.get("sponsor") ?? saved("sponsor") ?? DEFAULTS.sponsor,
  wallet: walletPage(query.get("wallet") ?? WALLET_PAGE),
};

// The chain, as the node in Settings serves it, and Moniker, where @handles are.
let chain, moniker;
function connect() {
  chain = connectTo(settings.chain.split("/"));
  moniker = connectTo(settings.moniker.split("/"));
}
function connectTo(chainPath) {
  const client = new sdk.VolumeClient(new sdk.BatchingVolumeTransport(new sdk.HTTPVolumeTransport(`${settings.node}/volumes`, { chainPath })));
  // A node answers 503 while it fetches content from its peers: ask again.
  const volumes = {
    async get(cid) {
      for (let wait = 500, waited = 0; ; waited += wait, wait = Math.min(wait * 2, 4000)) {
        try {
          return await client.get(cid);
        } catch (error) {
          if (waited > 60_000) throw error;
          await new Promise((r) => setTimeout(r, wait));
        }
      }
    },
  };
  const read = reader(sdk, async (cid) => (await volumes.get(cid)).bytes(cid));
  // Trie nodes are named by their CIDs, so one cache serves every tip: a
  // newer state costs only the nodes that changed.
  const load = volumeLoader(volumes, sdk.decodeDagCbor);
  let current;
  return {
    read,
    path: chainPath,
    /** Forget the state read, so the next read is at the node's new tip. */
    stale: () => (current = undefined),
    // The state at the node's tip, read again when over 3 s old.
    async state() {
      if (!current || Date.now() - current.at > 3_000) {
        current = (async () => {
          const { generalStateCID } = await tip(sdk, settings.node, chainPath, volumes);
          return view(load, generalStateCID);
        })();
        current.at = Date.now();
        current.catch(() => (current = undefined));
      }
      return current;
    },
  };
}
connect();

// ---- The reader's account ----

// Selfhold holds the key and asks the reader to approve every write; the
// sponsor in Settings takes this device's work for its fee.
const wallet = selfhold({ use: "window", wallet: settings.wallet, hosts: () => [settings.node], sponsor: () => settings.sponsor || undefined });
let me = null;

function renderWho() {
  $("#who").innerHTML = me
    ? `<a class="inbox" href="${href({ view: "inbox" })}">Inbox<span id="unread"></span></a><a class="me" href="${href({ view: "owner", owner: me })}" title="${esc(me)}">${esc(shortAccount(me))}</a><button class="btn small" data-act="signout">Sign out</button>`
    : `<button class="btn small primary" data-act="signin">Sign in</button>`;
  if (me) countUnread();
}

// The inbox: notes from the chain (client/collab.mjs); which are read is this
// device's own memory, the time of the newest note seen.
const seenKey = () => `seen:${me}`;
const seen = () => Number(saved(seenKey()) ?? 0);
async function countUnread() {
  const notes = await chain.state().then((state) => collab.inbox(state, me, { limit: 50 })).catch((error) => (console.warn("inbox", error), []));
  const n = notes.filter((note) => note.time > seen()).length;
  console.debug(`inbox: ${notes.length} notes for ${me}, ${n} unread`);
  const badge = $("#unread");
  if (badge) badge.textContent = n ? ` ${n > 49 ? "50+" : n}` : "";
}

async function inboxPage() {
  if (!me) return `<h1>Inbox</h1><p class="empty">Sign in to see who wrote to you.</p>`;
  const notes = await collab.inbox(await chain.state(), me);
  const before = seen();
  if (notes.length) save(seenKey(), String(Math.min(Math.max(before, notes[0].time), time())));
  countUnread();
  const what = { issue: "opened an issue", pull: "opened a pull request", comment: "commented on", review: "reviewed a line of" };
  const items = notes.map((n) => {
    const { owner, name } = collab.repoOf(n.repo);
    const [author, id] = n.thread.split("/");
    const link = href({ view: n.kind === "pull" || n.pull ? "pull" : "issue", owner, name, author, id });
    const excerpt = n.body.replace(/\s+/g, " ").trim().slice(0, 160);
    return `<li class="${n.time > before ? "unread" : ""}"><a href="${link}"><strong>${esc(shortAccount(n.from))}</strong> ${esc(what[n.kind])} <strong>${esc(n.title)}</strong></a>
      <span class="muted">in ${esc(shortAccount(owner))}/${esc(name)} · ${esc(ago(n.time))}</span>${excerpt ? `<p class="muted">${esc(excerpt)}</p>` : ""}</li>`;
  });
  return `<h1>Inbox</h1>${items.length ? `<ul class="list inbox-list">${items.join("")}</ul>` : `<p class="empty">Nothing yet. You hear here of new issues and pull requests on repos you maintain, comments on threads you're in, and mentions of your @handle.</p>`}`;
}

/** Who a new issue or comment concerns, mentioned @handles included: see collab.concerned. */
async function concerned(state, route, thread, body) {
  const card = await records.card(state, route.owner, route.name);
  // Moniker is read only for a body that mentions someone, and not waited on for long.
  const handles = collab.mentions(body);
  const names = handles.length ? await Promise.race([moniker.state().catch(() => undefined), new Promise((r) => setTimeout(r, 10_000))]) : undefined;
  const mentioned = names ? (await Promise.all(handles.map((h) => accountOf(names, h).catch(() => undefined)))).filter(Boolean) : [];
  return collab.concerned(state, route.owner, route.name, card, thread, mentioned);
}

/** Asks Selfhold for this site's account. Its window opens only from a click: call it before any other wait. */
async function signIn() {
  me = await wallet.connect();
  renderWho();
  render();
}

/** What went wrong, in the page's words. */
function walletMessage(error) {
  const text = String(error?.message ?? error);
  if (error?.code === "NeedsCoins") {
    const why = { down: "the sponsor isn't answering", dear: "this device can't do the fee's work in reasonable time", most: "the sponsor pays only so much for one write" }[error.sponsor];
    return `This write's fee couldn't be paid with work (${why ?? (settings.sponsor ? "the sponsor didn't pay it" : "no sponsor is set in Settings")}). Try again in a few minutes, or send coins to ${shortAccount(error.address ?? me ?? "")}.`;
  }
  if (/just declined|ask again in a moment/i.test(text)) return "Selfhold waits a few seconds after a decline. Try again in a moment.";
  if (/declined|rejected|denied/i.test(text)) return "You declined it in Selfhold. Nothing was sent.";
  return text;
}

/**
 * Writes the records `build(state)` returns, as the reader, through
 * Selfhold's window, which opens at once (call this from a click, before any
 * other wait) while the page reads the chain. Resolves once the write has
 * landed. `status(text)` hears progress.
 */
async function send(build, status = () => {}) {
  if (!me) throw new Error("Sign in first.");
  const request = (async () => {
    chain.stale();
    const state = await chain.state();
    const actions = await changes(state, await build(state));
    return actions.length ? { chainPath: chain.path, actions } : null;
  })();
  status("Approve it in Selfhold's window…");
  const sent = await wallet.writeRecords(request, { account: me, progress: (text) => status(`${text.replace(/[.…]+$/, "")}…`) });
  if (sent) {
    // A child chain gets at most one block per block of its parent, so the
    // wait is the parent's pace (testnet's: about a minute), shown as it runs.
    const since = Date.now();
    const tick = () => status(`Sent. Waiting for its block… ${Math.round((Date.now() - since) / 1000)} s`);
    tick();
    const ticking = setInterval(tick, 1000);
    try {
      await sent.wait();
    } finally {
      clearInterval(ticking);
    }
  }
  chain.stale();
}

const time = () => Math.floor(Date.now() / 1000);

// ---- Rendering ----

const icon = {
  tree: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 3h4l1.5 1.5h7.5v8.5h-13z"/></svg>',
  blob: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 1.5h6l3 3v10h-9z M9.5 1.5v3h3" fill="none"/></svg>',
  link: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 10l4-4 M5 7.5L3.5 9a2.1 2.1 0 003 3L8 10.5 M11 8.5L12.5 7a2.1 2.1 0 00-3-3L8 5.5" fill="none"/></svg>',
  submodule: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3h12v10H2z M2 6h12" fill="none"/></svg>',
};

const main = () => $("main");
// v0.2.0 before v0.10.0.
const byVersion = (a, b) => a.localeCompare(b, "en", { numeric: true });
let rendering = 0;

async function render() {
  const mine = ++rendering;
  const route = parseRoute(location.hash);
  const show = (html) => {
    if (mine === rendering) main().innerHTML = html;
    return mine === rendering;
  };
  main().setAttribute("aria-busy", "true");
  try {
    const html = await page(route, show);
    if (html !== undefined) show(html);
  } catch (error) {
    console.warn(error);
    show(`<div class="panel bad"><h2>This page couldn't be read</h2><p>${esc(error.message)}</p><p class="muted">From ${esc(settings.node)}, chain ${esc(settings.chain)}.</p><div class="row2"><button class="btn" data-act="retry">Try again</button><a class="btn" href="#/settings">Choose another node</a></div></div>`);
  } finally {
    if (mine === rendering) {
      main().removeAttribute("aria-busy");
      afterRender();
      readHandles().then((found) => found && mine === rendering && render(), () => {});
      if (me && route.view !== "inbox") countUnread();
    }
  }
}

// An account as people know it: the @handle it shows on Moniker, else its
// short id. Handles not yet read are read after the page shows, and the page
// shown again with them.
const handles = new Map();
const wantHandles = new Set();
const shortAccount = (address) => {
  if (!handles.has(address)) wantHandles.add(address);
  const h = handles.get(address);
  return h ? `@${h}` : shortId(address);
};
async function readHandles() {
  const wanted = [...wantHandles].filter((a) => a && !handles.has(a));
  wantHandles.clear();
  if (!wanted.length) return false;
  const state = await moniker.state().catch(() => undefined);
  const found = await Promise.all(wanted.map((a) => (state ? handleOf(state, a).catch(() => undefined) : undefined)));
  wanted.forEach((a, i) => handles.set(a, found[i] ?? null));
  return found.some(Boolean);
}

async function page(route, show) {
  // trellis::@alice/repo, or #/@alice/repo: whoever shows @alice now.
  if (route.owner?.startsWith("@")) {
    const handle = route.owner.slice(1);
    route.owner = await addressOf(() => moniker.state(), route.owner);
    handles.set(route.owner, handle);
    // The page's own links and actions name the account.
    history.replaceState(null, "", href(route));
  }
  if (route.view === "home") return home();
  if (route.view === "settings") return settingsPage();
  if (route.view === "inbox") return inboxPage();
  if (route.view === "owner") return ownerPage(route.owner);
  return repoPage(route, show);
}

async function home() {
  const state = await chain.state();
  const listed = [];
  for await (const [key, value] of state.list("index/repo/")) {
    const [name, owner, extra] = key.slice("index/repo/".length).split("/");
    if (value === "1" && owner && extra === undefined) listed.push({ name, owner });
  }
  const cards = await Promise.all(listed.map(async (r) => ({ ...r, card: await records.card(state, r.owner, r.name).catch(() => undefined) })));
  const rows = cards
    .filter((r) => r.card)
    .sort((a, b) => a.name.localeCompare(b.name) || a.owner.localeCompare(b.owner))
    .map((r) => `<li class="repo-row" data-name="${esc(r.name.toLowerCase())}">
        <a class="repo-name" href="${href({ view: "code", owner: r.owner, name: r.name })}"><span class="muted">${esc(shortAccount(r.owner))} /</span> ${esc(r.name)}</a>
        ${r.card.description ? `<p>${esc(r.card.description)}</p>` : ""}</li>`);
  return `<h1>Repositories</h1>
    <p class="lede">Every repo on ${esc(settings.chain)}. Branches are records on the chain; the code is content anyone can keep and serve.</p>
    ${rows.length ? `<input type="search" id="filter" placeholder="Find a repository" aria-label="Find a repository"><ul class="repos">${rows.join("")}</ul>` : `<p class="empty">No repositories yet.</p>`}`;
}

async function ownerPage(owner) {
  const state = await chain.state();
  const out = [];
  for await (const [key, value] of state.list(`user/${owner}/repo/`)) {
    const name = key.slice(`user/${owner}/repo/`.length);
    if (!name.includes("/")) out.push({ name, card: (() => { try { return JSON.parse(value); } catch { return {}; } })() });
  }
  return `<h1 class="mono-title">${esc(shortAccount(owner))}</h1><p class="mono muted">${esc(owner)}</p>
    ${out.length ? `<ul class="repos">${out.map((r) => `<li class="repo-row"><a class="repo-name" href="${href({ view: "code", owner, name: r.name })}">${esc(r.name)}</a>${r.card?.description ? `<p>${esc(r.card.description)}</p>` : ""}</li>`).join("")}</ul>` : `<p class="empty">No repositories.</p>`}`;
}

/** The repo's card and refs, or a page saying it isn't there. */
async function repoOf(owner, name) {
  const state = await chain.state();
  records.checkName(name);
  const [card, refs] = await Promise.all([records.card(state, owner, name), records.refs(sdk, state, owner, name)]);
  return { state, card, refs };
}

function repoHead({ owner, name }, card, tab, ref) {
  const tabs = [
    ["code", "Code", href({ view: "code", owner, name })],
    ["issues", "Issues", href({ view: "issues", owner, name })],
    ["pulls", "Pull requests", href({ view: "pulls", owner, name })],
    ["commits", "Commits", href({ view: "commits", owner, name, ref: ref ?? "HEAD" })],
    ["branches", "Branches", href({ view: "branches", owner, name })],
    ["tags", "Tags", href({ view: "tags", owner, name })],
    ["search", "Search", href({ view: "search", owner, name, ref: ref ?? "HEAD" })],
  ];
  const fork = card?.forkOf ? `<p class="fork-of">Forked from <a href="${href({ view: "code", ...collab.repoOf(card.forkOf) })}">${esc(shortAccount(collab.repoOf(card.forkOf).owner))}/${esc(collab.repoOf(card.forkOf).name)}</a></p>` : "";
  const forkButton = me && me !== owner && !records.isPrivate(card) ? `<button class="btn small" data-act="fork">Fork</button>` : "";
  const forksLink = `<a class="btn small" href="${href({ view: "forks", owner, name })}">Forks</a>`;
  return `<div class="repo-head"><div class="head-acts">${forksLink}${forkButton}</div>
      <h1><a href="${href({ view: "owner", owner })}" class="owner" title="${esc(owner)}">${esc(shortAccount(owner))}</a> <span class="muted">/</span> <a href="${href({ view: "code", owner, name })}">${esc(name)}</a></h1>
      ${fork}${card?.description ? `<p class="lede">${esc(card.description)}</p>` : ""}
    </div>
    <nav class="tabs" aria-label="Repository">${tabs.map(([key, label, link]) => `<a class="tab" href="${link}" ${key === tab ? 'aria-current="page"' : ""}>${label}</a>`).join("")}</nav>`;
}

/** A ref from the URL as `{ full, commit }`: a branch or tag name, HEAD, or a commit's CID. */
async function resolve(refs, ref) {
  const full = ref === "HEAD" || ref === undefined ? defaultBranch(refs) : fullRef(refs, ref);
  if (full) return { full, name: shortRef(full), commit: (await chain.read.peel(refs.get(full))).commit };
  if (ref && /^bafy/.test(ref)) {
    await chain.read.commit(ref);
    return { name: ref, commit: ref };
  }
  return undefined;
}

function refPicker(route, refs, current) {
  const options = [...refs.keys()].sort((a, b) => (a.startsWith("refs/heads/") === b.startsWith("refs/heads/") ? byVersion(a, b) : a.startsWith("refs/heads/") ? -1 : 1));
  const known = options.some((r) => shortRef(r) === current);
  return `<label class="sr-only" for="ref">Branch or tag</label><select id="ref" data-route="${esc(JSON.stringify({ ...route, ref: undefined }))}">
    ${known ? "" : `<option selected>${esc(current.slice(0, 16))}…</option>`}
    ${options.filter((r) => r.startsWith("refs/heads/") || r.startsWith("refs/tags/")).map((r) => `<option value="${esc(shortRef(r))}" ${shortRef(r) === current ? "selected" : ""}>${r.startsWith("refs/tags/") ? "tag: " : ""}${esc(shortRef(r))}</option>`).join("")}
  </select>`;
}

function crumbs(route, ref, path, last = true) {
  const parts = path.split("/").filter(Boolean);
  const links = [`<a href="${href({ view: "tree", owner: route.owner, name: route.name, ref, path: "" })}">${esc(route.name)}</a>`];
  parts.forEach((part, i) => {
    const sub = parts.slice(0, i + 1).join("/");
    links.push(i === parts.length - 1 && last ? `<strong>${esc(part)}</strong>` : `<a href="${href({ view: "tree", owner: route.owner, name: route.name, ref, path: sub })}">${esc(part)}</a>`);
  });
  return `<nav class="crumbs" aria-label="Path">${links.join('<span class="muted">/</span>')}</nav>`;
}

async function repoPage(route, show) {
  const { card, refs } = await repoOf(route.owner, route.name);
  if (!card && refs.size === 0) return `<h1>Not found</h1><p class="empty">${esc(shortAccount(route.owner))} has no repository called ${esc(route.name)} on ${esc(settings.chain)}.</p>`;
  // A move (both cards say so, client/records.mjs): the old address keeps its
  // issues and pull requests to read; the code, and anything new, is there.
  const state = await chain.state();
  const moved = await records.movedTo(state, route.owner, route.name, card);
  const fromText = typeof card?.movedFrom === "string" ? card.movedFrom : "";
  const [fromOwner, fromName] = fromText.split("/");
  const from = fromOwner && fromName && (await records.movedTo(state, fromOwner, fromName).catch(() => undefined));
  const cameFrom = from && from.owner === route.owner && from.name === route.name ? { owner: fromOwner, name: fromName } : undefined;
  const banner = moved
    ? `<p class="moved panel">This repository moved to <a href="${href({ view: "code", ...moved })}">${esc(shortAccount(moved.owner))}/${esc(moved.name)}</a>. Its issues and pull requests from before the move are still here to read.</p>`
    : cameFrom
      ? `<p class="moved panel">Moved here from ${esc(shortAccount(cameFrom.owner))}/${esc(cameFrom.name)}: <a href="${href({ view: "issues", ...cameFrom })}">its earlier issues</a> and <a href="${href({ view: "pulls", ...cameFrom })}">pull requests</a>.</p>`
      : "";
  const head = (tab, ref) => repoHead(route, card, tab, ref) + banner;
  if (moved && !["issues", "pulls", "issue", "pull"].includes(route.view)) return head(route.view.startsWith("pulls") ? "pulls" : route.view.startsWith("issues") ? "issues" : "code");
  // A private repo's blocks are sealed for its members' key files (client/seal.mjs); the page can't open them.
  if (Array.isArray(card?.private?.keys)) {
    return `${head("code")}<div class="panel"><h2>A private repository</h2><p>Its files and history are sealed so only its members read them, with their key files: clone it with git.</p>
      <pre class="cmd">git clone trellis::${esc(route.owner)}/${esc(route.name)}</pre><p class="hint">Its name, branch names and members are public. Issues and pull requests are off, since they would be public too.</p></div>`;
  }
  const talk = { issues: "issues", "issues-new": "issues", pulls: "pulls", "pulls-new": "pulls", issue: "issues", pull: "pulls" }[route.view];
  if (talk) return head(talk) + (await talkPage(route, card, refs));
  if (refs.size === 0) return `${head("code")}<p class="empty">Nothing has been pushed yet.</p>${cloneBox(route)}`;
  if (route.view === "branches" || route.view === "tags") return head(route.view) + (await refList(route, card, refs));
  if (route.view === "forks") {
    const list = await records.forks(state, route.owner, route.name);
    return head("code") + (list.length
      ? `<h2>Forks</h2><ul class="forks">${list.map((a) => `<li><a href="${href({ view: "code", owner: a, name: route.name })}">${esc(shortAccount(a))}/${esc(route.name)}</a></li>`).join("")}</ul>`
      : `<p class="empty">No forks yet.</p>`);
  }
  if (route.view === "commit") return head("commits") + (await commitPage(route));

  const at = await resolve(refs, route.ref);
  if (!at) return `${head("code")}<p class="empty">No branch or tag called ${esc(route.ref)}.</p>`;
  if (route.view === "commits") return head("commits", at.name) + (await commitsPage(route, refs, at));
  if (route.view === "search") return searchPage(route, refs, at, head("search", at.name), show);

  const commit = await chain.read.commit(at.commit);
  const path = route.path ?? "";
  const entry = await chain.read.at(commit.tree, path);
  if (!entry) return `${head("code", at.name)}<p class="empty">No ${esc(path)} in ${esc(at.name)}.</p>`;
  const bar = `<div class="bar">${refPicker({ view: entry.kind === "tree" ? "tree" : "blob", owner: route.owner, name: route.name, path }, refs, at.name)}${crumbs(route, at.name, path)}</div>`;
  if (entry.kind !== "tree") return head("code", at.name) + bar + (await filePage(route, at, path, entry));

  const entries = await chain.read.tree(entry.cid);
  const latest = `<div class="latest"><a href="${href({ view: "commit", owner: route.owner, name: route.name, cid: commit.cid })}">${esc(subject(commit.message).subject)}</a>
      <span class="muted">${esc(commit.author.name)} · ${esc(ago(commit.committer.time))} · <span class="mono">${esc(commit.id.slice(0, 10))}</span></span>
      <a class="count" href="${href({ view: "commits", owner: route.owner, name: route.name, ref: at.name })}">History</a></div>`;
  const rows = entries.map((e) => {
    const target = e.kind === "tree" ? "tree" : "blob";
    const link = e.kind === "submodule" ? `<span>${esc(e.name)}</span> <span class="muted mono">@ ${esc(e.id.slice(0, 10))}</span>` : `<a href="${href({ view: target, owner: route.owner, name: route.name, ref: at.name, path: path ? `${path}/${e.name}` : e.name })}">${esc(e.name)}</a>`;
    return `<li class="entry ${e.kind}">${icon[e.kind]}${link}</li>`;
  });
  const up = path ? `<li class="entry"><span></span><a href="${href({ view: "tree", owner: route.owner, name: route.name, ref: at.name, path: path.split("/").slice(0, -1).join("/") })}">..</a></li>` : "";
  const readme = entries.find((e) => e.kind === "blob" && /^readme(\.(md|markdown|txt))?$/i.test(e.name));
  const top = `${head("code", at.name)}${bar}<div class="files">${latest}<ul class="entries">${up}${rows.join("")}</ul></div>`;
  // The listing first; the README when it arrives.
  if (readme) {
    show(`${top}${path ? "" : cloneBox(route)}<p class="muted loading">Reading ${esc(readme.name)}…</p>`);
    const text = await textOf(readme.cid);
    const body = text === undefined ? "" : /\.(md|markdown)$/i.test(readme.name) ? `<div class="markdown">${markdown(text, route, at.name, path)}</div>` : `<pre class="plain">${esc(text)}</pre>`;
    return `${top}${path ? "" : cloneBox(route)}<section class="readme"><h2>${esc(readme.name)}</h2>${body}</section>`;
  }
  return top + (path ? "" : cloneBox(route));
}

/** Files of a branch whose path or text holds the query, read in the browser. */
async function searchPage(route, refs, at, top, show) {
  const form = `<div class="bar">${refPicker({ view: "search", owner: route.owner, name: route.name, q: route.q }, refs, at.name)}
    <form class="search" data-form="search"><label class="sr-only" for="q">Search ${esc(at.name)}</label><input type="search" id="q" name="q" value="${esc(route.q)}" placeholder="Search file names and text in ${esc(at.name)}" required><button class="btn">Search</button></form></div>`;
  if (!route.q.trim()) return `${top}${form}<p class="empty">Every file is read from the chain's blocks in your browser, so the first search of a big repo takes a while.</p>`;
  const commit = await chain.read.commit(at.commit);
  let shown = 0;
  const found = await chain.read.grep(commit.tree, route.q.trim(), {
    progress: (n, total) => {
      if (n - shown >= 25 || n === total) show(`${top}${form}<p class="muted loading">Read ${(shown = n)} of ${total} files…</p>`);
    },
  });
  const mark = (text) => {
    const at = text.toLowerCase().indexOf(route.q.trim().toLowerCase());
    return at < 0 ? esc(text) : `${esc(text.slice(0, at))}<mark>${esc(text.slice(at, at + route.q.trim().length))}</mark>${esc(text.slice(at + route.q.trim().length))}`;
  };
  const rows = found.matches.map((m) => {
    const link = href({ view: "blob", owner: route.owner, name: route.name, ref: at.name, path: m.path });
    return `<li class="hit"><a href="${link}" class="mono">${mark(m.path)}</a>${m.lines.length ? `<pre class="plain">${m.lines.map((l) => `<span class="muted">${l.line}</span>  ${mark(l.text)}`).join("\n")}</pre>` : ""}</li>`;
  });
  const note = `${found.matches.length}${found.more ? "+" : ""} file${found.matches.length === 1 ? "" : "s"} of ${found.files} match${found.skipped ? `; ${found.skipped} large or binary file${found.skipped === 1 ? " was" : "s were"} searched by name only` : ""}.`;
  return `${top}${form}<p class="summary">${note}</p>${rows.length ? `<ul class="hits">${rows.join("")}</ul>` : ""}`;
}

function cloneBox(route) {
  const config = `git config --global trellis.node ${settings.node}\ngit config --global trellis.chain ${settings.chain}`;
  return `<details class="clone"><summary>Clone</summary>
    <pre class="cmd">git clone trellis::${esc(route.owner)}/${esc(route.name)}</pre>
    <p class="hint">With <a href="https://github.com/adalinxx/trellis">git-remote-trellis</a> on your PATH and this node:</p>
    <pre class="cmd">${esc(config)}</pre></details>`;
}

/** A file's text if it is small text, else undefined. */
async function textOf(cid) {
  if ((await chain.read.size(cid)) > SHOW_BYTES) return undefined;
  const data = await chain.read.blob(cid);
  return isText(data) ? new TextDecoder().decode(data) : undefined;
}

async function filePage(route, at, path, entry) {
  if (entry.kind === "submodule") return `<p class="empty">A submodule at ${esc(entry.id)}.</p>`;
  const size = await chain.read.size(entry.cid);
  const name = path.split("/").pop();
  const meta = `<div class="file-meta"><span>${esc(bytes(size))}</span>${entry.mode === "100755" ? '<span>executable</span>' : ""}${entry.kind === "link" ? "<span>symbolic link</span>" : ""}
    <button class="btn small" data-act="download" data-cid="${esc(entry.cid)}" data-name="${esc(name)}">Download</button></div>`;
  if (size > SHOW_BYTES && !new URLSearchParams(location.hash.split("?")[1]).has("all")) {
    return `${meta}<div class="panel"><p>This file is ${esc(bytes(size))}, so it isn't read until you ask.</p><a class="btn" href="${location.hash.split("?")[0]}?all">Show it anyway</a></div>`;
  }
  const data = await chain.read.blob(entry.cid);
  const type = imageType(name);
  if (type) return `${meta}<div class="image"><img alt="${esc(name)}" data-blob="${esc(entry.cid)}" data-type="${esc(type)}"></div>`;
  if (!isText(data)) return `${meta}<p class="empty">A binary file.</p>`;
  const text = new TextDecoder().decode(data);
  if (/\.(md|markdown)$/i.test(name) && !location.hash.includes("?source")) {
    return `${meta}<p class="toggle"><a href="${location.hash.split("?")[0]}?source">Source</a></p><div class="markdown">${markdown(text, route, at.name, path.split("/").slice(0, -1).join("/"))}</div>`;
  }
  return `${meta}${code(lines(text))}`;
}

const code = (rows) => `<table class="code"><tbody>${rows.map((line, i) => `<tr><td class="ln" data-n="${i + 1}"></td><td class="src">${esc(line)}</td></tr>`).join("")}</tbody></table>`;

async function commitsPage(route, refs, at) {
  const { commits, more } = await chain.read.history([at.commit], route.limit);
  // Each commit's checks (CI results, client/checks.mjs), as one word.
  const state = await chain.state();
  const card = await records.card(state, route.owner, route.name);
  const found = await Promise.all(commits.map((c) => checksOn(state, route.owner, route.name, card, c.id).catch(() => [])));
  commits.forEach((c, i) => (c.checks = found[i]));
  const byDay = new Map();
  for (const c of commits) {
    const day = new Date(c.committer.time * 1000).toISOString().slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(c);
  }
  const groups = [...byDay].map(([day, list]) => `<h3 class="day">Commits on ${esc(day)}</h3><ul class="commits">${list.map((c) => commitRow(route, c)).join("")}</ul>`);
  return `<div class="bar">${refPicker({ view: "commits", owner: route.owner, name: route.name }, refs, at.name)}</div>${groups.join("")}
    ${more ? `<a class="btn more" href="${href({ view: "commits", owner: route.owner, name: route.name, ref: at.name, limit: route.limit + 30 })}">More</a>` : ""}`;
}

function commitRow(route, c) {
  const { subject: first } = subject(c.message);
  return `<li class="commit-row"><a class="subject" href="${href({ view: "commit", owner: route.owner, name: route.name, cid: c.cid })}">${esc(first)}</a>
    <span class="muted">${esc(c.author.name)} committed ${esc(ago(c.committer.time))}${c.signed ? ' · <span class="badge" title="It carries a signature. The page does not check it: git verify-commit does, on a clone.">signed</span>' : ""}</span>
    ${checkBadge(c.checks)}<span class="mono id">${esc(c.id.slice(0, 10))}</span></li>`;
}

/** A commit's checks as a badge, each named in its title; nothing for none. */
function checkBadge(list = []) {
  const word = overall(list);
  if (!word) return "";
  const title = list.map((c) => `${c.check}: ${c.state}${c.summary ? ` — ${c.summary.split("\n")[0]}` : ""}`).join("\n");
  return `<span class="check ${word}" title="${esc(title)}">${{ pass: "✓ checks", fail: "✗ checks", pending: "• checks" }[word]}</span>`;
}

/** A commit's checks, listed, with their summaries and links. */
function checkList(list) {
  if (!list.length) return "";
  return `<div class="checks panel"><h3>Checks ${checkBadge(list)}</h3><ul>${list.map((c) => `<li><span class="check ${c.state}">${esc(c.state)}</span> <strong>${esc(c.check)}</strong> <span class="muted">by ${esc(shortAccount(c.by))} · ${esc(ago(c.time))}</span>${c.url ? ` <a href="${esc(c.url)}" rel="noopener noreferrer" target="_blank">details</a>` : ""}${c.summary ? `<details><summary>Output</summary><pre class="plain">${esc(c.summary)}</pre></details>` : ""}</li>`).join("")}</ul></div>`;
}

async function commitPage(route) {
  const c = await chain.read.commit(route.cid);
  const parent = c.parents[0] ? await chain.read.commit(c.parents[0]) : undefined;
  const changed = await chain.read.changes(parent?.tree, c.tree);
  const { subject: first, body } = subject(c.message);
  const parents = c.parents.map((p, i) => `<a class="mono" href="${href({ view: "commit", owner: route.owner, name: route.name, cid: p })}">${i === 0 && parent ? esc(parent.id.slice(0, 10)) : esc(p.slice(-10))}</a>`).join(" + ");
  const files = await Promise.all(changed.map((change) => fileDiff(route, c, change)));
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  return `<article class="commit"><h2>${esc(first)}</h2>${body ? `<pre class="message">${esc(body)}</pre>` : ""}
      <dl class="kv"><dt>Author</dt><dd>${esc(c.author.name)} &lt;${esc(c.author.email)}&gt;, ${esc(ago(c.author.time))}</dd>
      ${c.committer.name !== c.author.name || c.committer.email !== c.author.email ? `<dt>Committer</dt><dd>${esc(c.committer.name)}, ${esc(ago(c.committer.time))}</dd>` : ""}
      <dt>Commit</dt><dd class="mono">${esc(c.id)}</dd>
      ${parents ? `<dt>${c.parents.length > 1 ? "Parents" : "Parent"}</dt><dd>${parents}</dd>` : ""}
      ${c.signed ? '<dt>Signature</dt><dd>Signed. The page does not check signatures: <code>git verify-commit</code> does, on a clone.</dd>' : ""}
      <dt>Browse</dt><dd><a href="${href({ view: "tree", owner: route.owner, name: route.name, ref: c.cid, path: "" })}">Files at this commit</a></dd></dl></article>
    <p class="summary">${changed.length} file${changed.length === 1 ? "" : "s"} changed${parent ? "" : " (the first commit)"}, <span class="add">+${added}</span> <span class="del">−${removed}</span>${c.parents.length > 1 ? ", against the first parent" : ""}</p>
    ${files.map((f) => f.html).join("")}`;
}

async function fileDiff(route, commit, { path, status, before, after }, review) {
  const title = `<a href="${href({ view: status === "deleted" ? "blob" : "blob", owner: route.owner, name: route.name, ref: status === "deleted" ? commit.parents[0] : commit.cid, path })}">${esc(path)}</a>`;
  const label = { added: "added", deleted: "deleted", modified: "" }[status];
  const wrap = (inner, added = 0, removed = 0) => ({ added, removed, html: `<section class="diff" data-path="${esc(path)}"><h3>${title} ${label ? `<span class="badge">${label}</span>` : ""}<span class="counts"><span class="add">+${added}</span> <span class="del">−${removed}</span></span></h3>${inner}</section>` });
  const side = async (entry) => {
    if (!entry || entry.kind === "submodule") return entry ? `Subproject commit ${entry.id}\n` : "";
    if ((await chain.read.size(entry.cid)) > DIFF_BYTES) return null;
    const data = await chain.read.blob(entry.cid);
    return isText(data) ? new TextDecoder().decode(data) : null;
  };
  const [a, b] = await Promise.all([side(before), side(after)]);
  if (a === null || b === null) return wrap(`<p class="muted note">Binary or large: not shown.</p>`);
  const edit = lineDiff(lines(a), lines(b));
  const shown = hunks(edit);
  const added = edit.filter((s) => s.op === "+").length;
  const removed = edit.filter((s) => s.op === "-").length;
  if (shown.length === 0) return wrap(`<p class="muted note">${before?.mode !== after?.mode ? `Mode ${esc(before?.mode)} → ${esc(after?.mode)}` : "No change in the text."}</p>`);
  // In a pull request: a + to comment on each line, and the comments made on them.
  const line = (s) => {
    const side = s.op === "-" ? "old" : "new";
    const n = side === "old" ? s.a : s.b;
    const here = review ? review.reviews.filter((c) => c.review.path === path && c.review.side === side && c.review.line === n) : [];
    const plus = review && me ? `<button class="plus" data-act="review" data-path="${esc(path)}" data-line="${n}" data-side="${side}" aria-label="Comment on line ${n}">+</button>` : "";
    const row = `<tr class="${s.op === "+" ? "add" : s.op === "-" ? "del" : ""}"><td class="ln" data-n="${s.a ?? ""}"></td><td class="ln gutter" data-n="${s.b ?? ""}">${plus}</td><td class="src"><span class="op">${s.op}</span>${esc(s.line)}</td></tr>`;
    return row + here.map((c) => `<tr class="inline-comment"><td colspan="3">${commentCard(route, c.by, c.time, c.body)}</td></tr>`).join("");
  };
  const rows = shown.map((h) => `<tr class="hunk"><td colspan="3">@@ −${h.a},${h.aLines} +${h.b},${h.bLines} @@</td></tr>${h.steps.map(line).join("")}`);
  return wrap(`<table class="code diff-table"><tbody>${rows.join("")}</tbody></table>`, added, removed);
}

async function refList(route, card, refs) {
  const kind = route.view === "branches" ? "refs/heads/" : "refs/tags/";
  const names = [...refs.keys()].filter((r) => r.startsWith(kind)).sort(byVersion);
  if (names.length === 0) return `<p class="empty">No ${route.view}.</p>`;
  const tagsPage = route.view === "tags";
  const notes = tagsPage ? await collab.releases(await chain.state(), route.owner, route.name, card) : new Map();
  const canRelease = tagsPage && me && collab.maintainers(route.owner, card).includes(me);
  const rows = await Promise.all(names.map(async (r) => {
    const { commit, tags } = await chain.read.peel(refs.get(r));
    const c = await chain.read.commit(commit);
    const note = tags[0]?.message ? ` · ${esc(subject(tags[0].message).subject)}` : "";
    const tag = shortRef(r);
    const rel = notes.get(tag);
    const assets = rel?.files.length ? `<ul class="assets">${rel.files.map((f) => `<li><a href="#" data-act="download" data-cid="${esc(f.cid)}" data-name="${esc(f.name)}">${esc(f.name)}</a> <span class="muted">${esc(bytes(f.size))}</span></li>`).join("")}</ul>` : "";
    const release = rel ? `<div class="release"><h3>${esc(rel.title || tag)}</h3><div class="markdown">${markdown(rel.notes, route, tag, "")}</div>${assets}<p class="muted small">Released by ${byline(rel.by)} ${esc(ago(rel.time))}</p></div>` : "";
    const write = canRelease ? `<details class="write-release"><summary>${rel ? "Edit the release" : "Write release notes"}</summary>
        <form data-form="release" data-tag="${esc(tag)}"><label>Title<input type="text" name="title" value="${esc(rel?.title ?? "")}"></label>
        <label>Notes<textarea name="notes" required>${esc(rel?.notes ?? "")}</textarea></label>
        <label>Files<input type="file" name="files" multiple></label>${rel?.files.length ? `<p class="hint">Files chosen here are added to the ${rel.files.length} it has; one with the same name replaces it.</p>` : ""}
        <div class="row2"><span class="status"></span><button class="btn primary">Save the release</button></div></form></details>` : "";
    return `<li class="ref-row"><a class="ref-name" href="${href({ view: "tree", owner: route.owner, name: route.name, ref: tag, path: "" })}">${esc(tag)}</a>
      <span class="muted">${esc(subject(c.message).subject)} · ${esc(ago(c.committer.time))}${note}</span><span class="mono id">${esc(c.id.slice(0, 10))}</span>${release}${write}</li>`;
  }));
  return `<ul class="refs">${rows.join("")}</ul>`;
}

/** A README as HTML: no raw HTML, only safe links, relative ones into the repo. */
function markdown(text, route, ref, dir) {
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      html: ({ text: raw }) => esc(raw),
      link({ href: target, tokens }) {
        const inner = this.parser.parseInline(tokens);
        const to = linkTarget(target, dir);
        if (!to) return inner;
        if (to.url) return `<a href="${esc(to.url)}" rel="noopener noreferrer nofollow">${inner}</a>`;
        if (to.anchor) return inner;
        return `<a href="${href({ view: "blob", owner: route.owner, name: route.name, ref, path: to.path })}">${inner}</a>`;
      },
      image({ href: target, text: alt }) {
        const to = linkTarget(target, dir);
        if (to?.path !== undefined && imageType(to.path)) return `<img alt="${esc(alt)}" data-path="${esc(to.path)}" data-ref="${esc(ref)}" data-type="${esc(imageType(to.path))}">`;
        // An image from elsewhere would tell its host who reads: a link instead.
        return to?.url ? `<a href="${esc(to.url)}" rel="noopener noreferrer nofollow">${esc(alt || to.url)}</a>` : esc(alt);
      },
    },
  });
  return marked.parse(text);
}

function settingsPage() {
  return `<h1>Settings</h1>
    <form id="settings" class="panel">
      <label for="node">Node</label><input type="url" id="node" value="${esc(settings.node)}" required>
      <p class="hint">Any Lattice node serving the chain's public reads. Every block it serves is checked against its CID.</p>
      <label for="chain">Chain</label><input type="text" id="chain" value="${esc(settings.chain)}" required>
      <label for="moniker">Names</label><input type="text" id="moniker" value="${esc(settings.moniker)}" required>
      <p class="hint">The Moniker chain @handles are read from: an account shows @alice only while it names alice there and alice points at it.</p>
      <label for="sponsor">Sponsor</label><input type="url" id="sponsor" value="${esc(settings.sponsor)}">
      <p class="hint">Takes this device's work for each write's fee, so writing needs no coins. Empty: fees are paid in coins.</p>
      <div class="row2"><button type="button" class="btn" data-act="defaults">Defaults</button><button class="btn primary">Save</button></div>
    </form>`;
}

// ---- Issues and pull requests ----

const who = (a) => (a === me ? "you" : shortAccount(a));
const byline = (a) => `<a class="author" href="${href({ view: "owner", owner: a })}" title="${esc(a)}">${esc(who(a))}</a>`;
const chips = (labels) => labels.map((l) => `<span class="label">${esc(l)}</span>`).join("");
const signInFirst = (what) => `<div class="panel quiet"><p>Sign in to ${what}. Selfhold makes your account with a passkey; no coins needed.</p><button class="btn primary" data-act="signin">Sign in</button></div>`;

async function talkPage(route, card, refs) {
  const state = await chain.state();
  if (route.view === "issues" || route.view === "pulls") return issueList(route, state, card, refs);
  if (route.view === "issues-new") return me ? issueForm(route) : signInFirst("open an issue");
  if (route.view === "pulls-new") return me ? pullForm(route, state, refs) : signInFirst("open a pull request");
  return issuePage(route, state, card, refs);
}

/** A pull request's head and base commits as the chain names them now, and whether the base contains the head. */
async function pullStatus(state, pr, refs, limit = 2000) {
  const h = collab.headOf(pr.head);
  const headRefs = h.owner === pr.repo.split("/")[0] && h.name === pr.repo.split("/")[1] ? refs : await records.refs(sdk, state, h.owner, h.name);
  const baseRef = refs.get(`refs/heads/${pr.base}`);
  const headRef = headRefs.get(`refs/heads/${h.branch}`);
  const baseCommit = baseRef && (await chain.read.peel(baseRef)).commit;
  const headCommit = headRef && (await chain.read.peel(headRef)).commit;
  const merged = Boolean(baseCommit && headCommit && (await chain.read.contains(baseCommit, headCommit, limit)));
  return { baseCommit, headCommit, merged, state: merged ? "merged" : pr.state };
}

const stateBadge = (state) => `<span class="state ${state}">${{ open: "Open", closed: "Closed", merged: "Merged" }[state]}</span>`;

async function issueList(route, state, card, refs) {
  const pulls = route.view === "pulls";
  const words = (route.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const hay = (i) => [i.title, i.body, ...i.labels, shortAccount(i.author), i.author].join("\n").toLowerCase();
  const all = (await collab.issues(state, route.owner, route.name, card)).filter((i) => Boolean(i.head) === pulls && words.every((w) => hay(i).includes(w)));
  // A merged pull request is done, whatever its record says.
  const shown = await Promise.all(all.map(async (i) => ({ ...i, state: pulls && i.state === "open" ? (await pullStatus(state, i, refs, 500).catch(() => ({ state: "open" }))).state : i.state })));
  const open = shown.filter((i) => i.state === "open");
  const done = shown.filter((i) => i.state !== "open");
  const list = route.closed ? done : open;
  const kind = pulls ? "pull requests" : "issues";
  const rows = list.map((i) => `<li class="issue-row">${stateBadge(i.state)}
      <a class="issue-title" href="${href({ view: pulls ? "pull" : "issue", owner: route.owner, name: route.name, author: i.author, id: i.id })}">${esc(i.title)}</a>${chips(i.labels)}
      <span class="muted">opened ${esc(ago(i.time))} by ${byline(i.author)}${pulls ? ` · ${esc(i.head.replace(/^[^/]+/, (o) => shortAccount(o)))} → ${esc(i.base)}` : ""}</span></li>`);
  return `<div class="bar between"><nav class="seg" aria-label="State">
      <a href="${href({ view: route.view, owner: route.owner, name: route.name, q: route.q })}" ${route.closed ? "" : 'aria-current="page"'}>${open.length} open</a>
      <a href="${href({ view: route.view, owner: route.owner, name: route.name, closed: true, q: route.q })}" ${route.closed ? 'aria-current="page"' : ""}>${done.length} ${pulls ? "closed or merged" : "closed"}</a></nav>
      <form class="search" data-form="issue-search"><label class="sr-only" for="q">Search ${kind}</label><input type="search" id="q" name="q" value="${esc(route.q ?? "")}" placeholder="Search ${kind}"></form>
      <a class="btn primary" href="${href({ view: `${route.view}-new`, owner: route.owner, name: route.name })}">New ${pulls ? "pull request" : "issue"}</a></div>
    ${rows.length ? `<ul class="issues">${rows.join("")}</ul>` : `<p class="empty">No ${route.closed ? (pulls ? "closed or merged" : "closed") : "open"} ${kind}.</p>`}`;
}

function issueForm(route) {
  return `<form class="panel" data-form="issue"><h2>New issue</h2>
    <label>Title<input type="text" name="title" required maxlength="300"></label>
    <label>Description<textarea name="body" maxlength="65536" placeholder="Markdown"></textarea></label>
    <div class="row2"><span class="status"></span><button class="btn primary">Open the issue</button></div></form>`;
}

async function pullForm(route, state, refs) {
  // Heads: the branches of every copy of this repo, forks included.
  const owners = [...new Set([route.owner, ...(await records.owners(state, route.name))])];
  const heads = [];
  for (const owner of owners) {
    const theirs = owner === route.owner ? refs : await records.refs(sdk, state, owner, route.name);
    for (const ref of [...theirs.keys()].filter((r) => r.startsWith("refs/heads/")).sort(byVersion)) heads.push(`${owner}/${route.name}:${shortRef(ref)}`);
  }
  const bases = [...refs.keys()].filter((r) => r.startsWith("refs/heads/")).map(shortRef).sort(byVersion);
  const base = shortRef(defaultBranch(refs) ?? "");
  const label = (h) => h.replace(/^[^/]+/, (o) => (o === me ? "you" : shortAccount(o)));
  const mine = heads.find((h) => h.startsWith(`${me}/`) && !h.endsWith(`:${base}`)) ?? heads.find((h) => !h.startsWith(`${route.owner}/`)) ?? heads[0];
  if (!bases.length) return `<p class="empty">This repository has no branch to merge into yet.</p>`;
  return `<form class="panel" data-form="pull"><h2>New pull request</h2>
    <p class="hint">Push your branch to your copy of this repo (git push trellis::&lt;you&gt;/${esc(route.name)}), then choose it here.</p>
    <div class="pick"><label>Merge<select name="head">${heads.map((h) => `<option value="${esc(h)}" ${h === mine ? "selected" : ""}>${esc(label(h))}</option>`).join("")}</select></label>
    <label>into<select name="base">${bases.map((b) => `<option ${b === base ? "selected" : ""}>${esc(b)}</option>`).join("")}</select></label></div>
    <label>Title<input type="text" name="title" required maxlength="300"></label>
    <label>Description<textarea name="body" maxlength="65536" placeholder="Markdown"></textarea></label>
    <div class="row2"><span class="status"></span><button class="btn primary">Open the pull request</button></div></form>`;
}

async function issuePage(route, state, card, refs) {
  const issue = await collab.oneIssue(state, route.owner, route.name, card, route.author, route.id);
  if (!issue) return `<p class="empty">No such ${route.view === "pull" ? "pull request" : "issue"}.</p>`;
  const pr = Boolean(issue.head);
  const comments = await collab.posts(state, route.author, route.id);
  const status = pr ? await pullStatus(state, issue, refs) : { state: issue.state };
  const compared = pr && status.baseCommit && status.headCommit ? await chain.read.compare(status.baseCommit, status.headCommit) : undefined;
  const isMaintainer = me && collab.maintainers(route.owner, card).includes(me);
  const self = { view: route.view, owner: route.owner, name: route.name, author: route.author, id: route.id };
  const head = pr ? collab.headOf(issue.head) : undefined;
  const top = `<div class="issue-head"><h2>${esc(issue.title)} <span class="muted id">#${esc(issue.id.slice(0, 7))}</span></h2>
    <p>${stateBadge(status.state)} ${byline(issue.author)} opened this ${esc(ago(issue.time))}${pr ? ` · wants to merge ${compared ? `${compared.commits.length} commit${compared.commits.length === 1 ? "" : "s"}` : "a branch"} into <code>${esc(issue.base)}</code> from <a href="${href({ view: "tree", owner: head.owner, name: head.name, ref: head.branch, path: "" })}"><code>${esc(label(issue.head))}</code></a>` : ""}</p>
    <div class="labels">${chips(issue.labels)}${isMaintainer ? `<details class="edit-labels"><summary>Labels</summary><form data-form="labels"><input type="text" name="labels" value="${esc(issue.labels.join(", "))}" placeholder="bug, help wanted"><div class="row2"><span class="status"></span><button class="btn small">Save labels</button></div></form></details>` : ""}</div></div>`;
  const tabs = pr ? `<nav class="tabs sub" aria-label="Pull request">${[["conversation", "Conversation"], ["commits", `Commits ${compared ? compared.commits.length : ""}`], ["files", "Files changed"]].map(([t, l]) => `<a class="tab" href="${href({ ...self, tab: t })}" ${route.tab === t ? 'aria-current="page"' : ""}>${l}</a>`).join("")}</nav>` : "";
  if (pr && route.tab === "commits") return top + tabs + (compared ? `<ul class="commits">${compared.commits.map((c) => commitRow(route, c)).join("")}</ul>` : `<p class="empty">Its branch is gone.</p>`);
  if (pr && route.tab === "files") return top + tabs + (await pullFiles(route, status, compared, comments));
  const headChecks = pr && compared?.commits[0] ? await checksOn(state, route.owner, route.name, card, compared.commits[0].id).catch(() => []) : [];
  return top + tabs + checkList(headChecks) + conversation(route, issue, comments, status, isMaintainer, compared);
}

function label(head) {
  return head.replace(/^[^/]+/, (o) => (o === me ? "you" : shortAccount(o)));
}

function commentCard(route, by, time, body, extra = "") {
  return `<article class="comment"><header>${byline(by)} <span class="muted">${esc(ago(time))}</span>${extra}</header><div class="markdown">${body.trim() ? markdown(body, route, "HEAD", "") : '<p class="muted">No description.</p>'}</div></article>`;
}

function conversation(route, issue, comments, status, isMaintainer, compared) {
  const items = comments.map((c) => commentCard(route, c.by, c.time, c.body, c.review ? ` <span class="muted">on <a href="${href({ view: "pull", owner: route.owner, name: route.name, author: route.author, id: route.id, tab: "files" })}"><code>${esc(c.review.path)}</code> line ${c.review.line}</a>${c.review.commit !== status.headCommit ? " (an earlier commit)" : ""}</span>` : ""));
  const closedNote = issue.state === "closed" && issue.closedBy ? `<p class="event">${byline(issue.closedBy)} closed this.</p>` : "";
  const mergeNote = status.state === "merged" ? `<p class="event merged">Merged: <code>${esc(issue.base)}</code> now contains this branch's commits.</p>` : "";
  const canClose = me && (me === issue.author || isMaintainer) && status.state !== "merged";
  // The base behind the head: the page moves it (a fast-forward). Else a
  // merge commit is needed, made in a clone: the page can't name a new tree
  // without the git ids of everything beside what changed.
  const fastForward = compared && compared.mergeBase === status.baseCommit;
  const from = collab.headOf(issue.head ?? "");
  const commands = !from ? "" : `<pre class="cmd">git fetch trellis::${esc(from.owner)}/${esc(from.name)} ${esc(from.branch)}
git checkout ${esc(issue.base)} && git merge FETCH_HEAD
git push origin ${esc(issue.base)}</pre>`;
  const howToMerge = status.state !== "open" || !compared || !isMaintainer ? "" : fastForward
    ? `<form class="merge panel" data-form="merge"><p><strong>Ready to merge.</strong> <code>${esc(issue.base)}</code> is behind this branch, so merging moves it to <code>${esc(compared.commits[0]?.id.slice(0, 10) ?? "")}</code>, with no new commit.</p>
        <div class="row2"><span class="status"></span><button class="btn primary">Merge into ${esc(issue.base)}</button></div>
        <details><summary>Or merge by pushing</summary>${commands}</details></form>`
    : `<details class="merge" open><summary>Merge by pushing</summary><p><code>${esc(issue.base)}</code> has commits this branch doesn't, so merging makes a merge commit; make it in a clone:</p>${commands}<p class="hint">Once <code>${esc(issue.base)}</code> contains its commits, this shows as merged.</p></details>`;
  const form = me
    ? `<form class="comment-form" data-form="comment"><label class="sr-only" for="comment-body">Comment</label><textarea id="comment-body" name="body" required maxlength="65536" placeholder="Leave a comment (Markdown)"></textarea>
        <div class="row2"><span class="status"></span>${canClose ? `<button type="button" class="btn" data-act="state" data-state="${issue.state === "open" ? "closed" : "open"}">${issue.state === "open" ? "Close" : "Reopen"}</button>` : ""}<button class="btn primary">Comment</button></div></form>`
    : signInFirst("comment");
  return `${commentCard(route, issue.author, issue.time, issue.body)}${items.join("")}${closedNote}${mergeNote}${howToMerge}${form}`;
}

/** A pull request's changes from its merge base, each line open to review on the head commit. */
async function pullFiles(route, status, compared, comments) {
  if (!compared) return `<p class="empty">Its branch is gone.</p>`;
  const head = await chain.read.commit(status.headCommit);
  const base = compared.mergeBase ? await chain.read.commit(compared.mergeBase) : undefined;
  // ?since=<commit>: only what changed after a commit of the branch, such as the last one reviewed.
  const since = route.since && compared.commits.some((c) => c.cid === route.since) ? await chain.read.commit(route.since) : undefined;
  const from = since ?? base;
  const changed = await chain.read.changes(from?.tree, head.tree);
  const reviews = comments.filter((c) => c.review?.commit === status.headCommit);
  const files = await Promise.all(changed.map((change) => fileDiff(route, { cid: head.cid, parents: [from?.cid] }, change, { reviews, commit: head.cid })));
  const self = { view: route.view, owner: route.owner, name: route.name, author: route.author, id: route.id, tab: "files" };
  const mine = comments.filter((c) => c.by === me && c.review && compared.commits.some((k) => k.cid === c.review.commit)).at(-1);
  const newer = mine && mine.review.commit !== status.headCommit ? compared.commits.findIndex((c) => c.cid === mine.review.commit) : -1;
  const toggle = since
    ? ` <a href="${href(self)}">Show all changes</a>`
    : newer > 0 ? ` <a href="${href({ ...self, since: mine.review.commit })}">Show the ${newer} commit${newer === 1 ? "" : "s"} since your last review</a>` : "";
  const what = since ? `since <code>${esc(since.id.slice(0, 10))}</code>` : "from the merge base";
  return `<p class="summary">${changed.length} file${changed.length === 1 ? "" : "s"} changed ${what}, <span class="add">+${files.reduce((n, f) => n + f.added, 0)}</span> <span class="del">−${files.reduce((n, f) => n + f.removed, 0)}</span>${me ? ". Press + beside a line to comment on it." : ""}${toggle}</p>${files.map((f) => f.html).join("")}`;
}

// ---- After a render: images, filter, ref picker ----

async function afterRender() {
  for (const img of document.querySelectorAll("img[data-blob], img[data-path]")) {
    try {
      let cid = img.dataset.blob;
      if (!cid) {
        const { refs } = await repoOf(...repoNames());
        const at = await resolve(refs, img.dataset.ref);
        const entry = at && (await chain.read.at((await chain.read.commit(at.commit)).tree, img.dataset.path));
        if (!entry || entry.kind !== "blob" || (await chain.read.size(entry.cid)) > SHOW_BYTES) continue;
        cid = entry.cid;
      }
      img.src = URL.createObjectURL(new Blob([await chain.read.blob(cid)], { type: img.dataset.type }));
    } catch (error) {
      console.warn(error);
    }
  }
}

const repoNames = () => {
  const route = parseRoute(location.hash);
  return [route.owner, route.name];
};

document.addEventListener("input", (event) => {
  if (event.target.id !== "filter") return;
  const term = event.target.value.trim().toLowerCase();
  for (const row of document.querySelectorAll(".repo-row")) row.hidden = term !== "" && !row.dataset.name.includes(term);
});

document.addEventListener("change", (event) => {
  if (event.target.id !== "ref") return;
  const route = JSON.parse(event.target.dataset.route);
  location.hash = href({ ...route, ref: event.target.value });
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-act]");
  if (!button) return;
  const act = button.dataset.act;
  const route = parseRoute(location.hash);
  if (act === "retry") render();
  if (act === "download") {
    event.preventDefault();
    const label = button.textContent;
    button.textContent = `${label} (reading…)`;
    try {
      const url = URL.createObjectURL(new Blob([await chain.read.blob(button.dataset.cid)], { type: "application/octet-stream" }));
      const a = Object.assign(document.createElement("a"), { href: url, download: button.dataset.name });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      notice(`${button.dataset.name} couldn't be read: ${error.message}`);
    } finally {
      button.textContent = label;
    }
  }
  if (act === "defaults") {
    $("#node").value = DEFAULTS.node;
    $("#chain").value = DEFAULTS.chain;
    $("#moniker").value = "Nexus/moniker";
    $("#sponsor").value = DEFAULTS.sponsor;
  }
  if (act === "signin") signIn().catch((error) => notice(walletMessage(error)));
  if (act === "signout") {
    await wallet.disconnect();
    me = null;
    renderWho();
    render();
  }
  if (act === "fork") {
    // A fork is the same repo name under the reader's account: a card and the
    // same refs. Its blocks are the original's, so nothing is copied.
    // Forked already: go to it.
    const mine = await records.card(await chain.state(), me, route.name).catch(() => undefined);
    if (mine?.forkOf === `${route.owner}/${route.name}`) return void (location.hash = href({ view: "code", owner: me, name: route.name }));
    button.disabled = true;
    button.textContent = "Forking…";
    send(async (state) => {
      const card = await records.card(state, route.owner, route.name);
      const refs = await records.refs(sdk, state, route.owner, route.name, card ?? null);
      return records.fork(me, route.owner, route.name, card, refs, await records.card(state, me, route.name));
    }, (text) => (button.textContent = text))
      .then(() => (location.hash = href({ view: "code", owner: me, name: route.name })))
      .catch((error) => {
        notice(walletMessage(error));
        button.disabled = false;
        button.textContent = "Fork";
      });
  }
  if (act === "state") {
    const form = button.closest("form");
    const next = button.dataset.state;
    run(form, async (state) => {
      const raw = JSON.parse((await state.get(collab.issueKey(route.author, route.id))) ?? "{}");
      if (me === route.author) return collab.issue(me, route.id, { ...raw, state: next, updated: time() });
      const key = collab.triageKey(me, route.owner, route.name, route.author, route.id);
      const old = JSON.parse((await state.get(key)) ?? "{}");
      return collab.triage(me, route.owner, route.name, route.author, route.id, { ...old, state: next, time: time() });
    });
  }
  if (act === "review") {
    const row = button.closest("tr");
    if (row.nextElementSibling?.classList.contains("review-row")) return row.nextElementSibling.querySelector("textarea").focus();
    row.insertAdjacentHTML("afterend", `<tr class="review-row"><td colspan="3"><form data-form="review" data-path="${esc(button.dataset.path)}" data-line="${esc(button.dataset.line)}" data-side="${esc(button.dataset.side)}">
      <label class="sr-only">Comment on line ${esc(button.dataset.line)}<textarea name="body" required maxlength="65536" placeholder="Comment on line ${esc(button.dataset.line)} (Markdown)"></textarea></label>
      <div class="row2"><span class="status"></span><button type="button" class="btn" data-act="cancel-review">Cancel</button><button class="btn primary">Comment on this line</button></div></form></td></tr>`);
    row.nextElementSibling.querySelector("textarea").focus();
  }
  if (act === "cancel-review") button.closest("tr").remove();
  if (act === "download") {
    button.disabled = true;
    try {
      const url = URL.createObjectURL(new Blob([await chain.read.blob(button.dataset.cid)]));
      const a = Object.assign(document.createElement("a"), { href: url, download: button.dataset.name });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } finally {
      button.disabled = false;
    }
  }
});

/** A note above the page, until dismissed. */
function notice(text) {
  $("#notices").insertAdjacentHTML("beforeend", `<div class="notice" role="alert"><p>${esc(text)}</p><button class="close" aria-label="Dismiss" onclick="this.parentElement.remove()">×</button></div>`);
}

/**
 * Sends a form's write (`build(state)`, its records), saying how it goes in
 * the form, then shows the page again, or `then()`. Called from the submit or
 * click itself, so Selfhold's window may open.
 */
function run(form, build, then = render) {
  const status = form.querySelector(".status");
  const say = (text, bad = false) => {
    status.textContent = text;
    status.classList.toggle("bad", bad);
  };
  const buttons = [...form.querySelectorAll("button")];
  buttons.forEach((b) => (b.disabled = true));
  send(build, say).then(then, (error) => {
    say(walletMessage(error), true);
    buttons.forEach((b) => (b.disabled = false));
  });
}

document.addEventListener("submit", (event) => {
  const form = event.target;
  const route = parseRoute(location.hash);
  const field = (name) => form.elements[name]?.value ?? "";
  if (form.id === "settings") {
    event.preventDefault();
    settings.node = $("#node").value.trim().replace(/\/+$/, "");
    settings.chain = $("#chain").value.trim();
    settings.moniker = $("#moniker").value.trim();
    handles.clear();
    settings.sponsor = $("#sponsor").value.trim();
    save("node", settings.node === DEFAULTS.node ? "" : settings.node);
    save("chain", settings.chain === DEFAULTS.chain ? "" : settings.chain);
    save("moniker", settings.moniker === "Nexus/moniker" ? "" : settings.moniker);
    try {
      if (settings.sponsor === DEFAULTS.sponsor) localStorage.removeItem("trellis:sponsor");
      else localStorage.setItem("trellis:sponsor", settings.sponsor);
    } catch {}
    connect();
    location.hash = "#/";
    return;
  }
  const kind = form.dataset.form;
  if (!kind) return;
  event.preventDefault();
  if (kind === "search" || kind === "issue-search") {
    location.hash = href({ ...route, q: field("q").trim() });
    return;
  }
  const repo = `${route.owner}/${route.name}`;
  if (kind === "issue" || kind === "pull") {
    const id = collab.newId();
    const record = { repo, title: field("title").trim(), body: field("body"), time: time(), ...(kind === "pull" && { head: field("head"), base: field("base") }) };
    const note = { kind, repo, thread: `${me}/${id}` };
    run(
      form,
      async (state) => [...collab.issue(me, id, record), ...collab.notify(me, await concerned(state, route, undefined, record.body), record.time, id, note)],
      () => (location.hash = href({ view: kind, owner: route.owner, name: route.name, author: me, id })),
    );
  }
  const thread = { author: route.author, id: route.id };
  const tell = async (state, id, post, kind) => collab.notify(me, await concerned(state, route, thread, post.body), post.time, id, { kind, repo, thread: post.on });
  if (kind === "comment") {
    run(form, async (state) => {
      const id = collab.newId();
      const post = { on: `${route.author}/${route.id}`, body: field("body"), time: time() };
      return [...collab.post(me, id, post), ...(await tell(state, id, post, "comment"))];
    });
  }
  if (kind === "review") {
    const review = { commit: null, path: form.dataset.path, line: Number(form.dataset.line), side: form.dataset.side };
    run(form, async (state) => {
      // The head commit the reader is looking at, as the chain names it now.
      const card = await records.card(state, route.owner, route.name);
      const issue = await collab.oneIssue(state, route.owner, route.name, card, route.author, route.id);
      const { headCommit } = await pullStatus(state, issue, await records.refs(sdk, state, route.owner, route.name));
      const id = collab.newId();
      const post = { on: `${route.author}/${route.id}`, body: field("body"), time: time(), review: { ...review, commit: headCommit } };
      return [...collab.post(me, id, post), ...(await tell(state, id, post, "review"))];
    });
  }
  if (kind === "merge") {
    run(form, async (state) => {
      // Read again: the merge must still be a fast-forward of the base as it stands now.
      const card = await records.card(state, route.owner, route.name);
      const issue = await collab.oneIssue(state, route.owner, route.name, card, route.author, route.id);
      const words = await records.words(sdk, state, route.owner, route.name, card ?? null);
      const status = await pullStatus(state, issue, await records.refs(sdk, state, route.owner, route.name, card ?? null));
      if (!status.headCommit || !status.baseCommit) throw new Error("The branch or its base is gone.");
      if (!(await chain.read.contains(status.headCommit, status.baseCommit))) throw new Error(`${issue.base} moved on: merge in a clone.`);
      const ref = `refs/heads/${issue.base}`;
      return records.ref(route.owner, route.name, ref, status.headCommit, { as: me, seq: (words.get(ref)?.seq ?? 0) + 1 });
    });
  }
  if (kind === "labels") {
    run(form, async (state) => {
      const key = collab.triageKey(me, route.owner, route.name, route.author, route.id);
      const old = JSON.parse((await state.get(key)) ?? "{}");
      return collab.triage(me, route.owner, route.name, route.author, route.id, { ...old, labels: collab.labelsOf(field("labels")), time: time() });
    });
  }
  if (kind === "release") {
    const title = field("title").trim();
    const chosen = [...(form.elements.files?.files ?? [])];
    const status = form.querySelector(".status");
    run(form, async (state) => {
      // The files first, kept by the sponsor for this device's work, then the record naming them.
      const card = await records.card(state, route.owner, route.name);
      const had = (await collab.releases(state, route.owner, route.name, card)).get(form.dataset.tag);
      const files = new Map((had?.by === me ? had.files : []).map((f) => [f.name, f]));
      for (const file of chosen) {
        const workOn = settings.sponsor && (await storageChain(settings.sponsor, settings.chain));
        if (!workOn) throw new Error("Files are kept by a sponsor that keeps files: set one in Settings.");
        const volumes = fileVolumes(sdk, BLOB_TYPE, new Uint8Array(await file.arrayBuffer()));
        await keep(sdk, settings.sponsor, workOn, volumes, { progress: ({ stored, total }) => (status.textContent = `Keeping ${file.name}: ${stored} of ${total} blocks…`) });
        files.set(file.name, { name: file.name, cid: volumes[0].cid, size: file.size });
      }
      const record = { ...(title && { title }), notes: field("notes"), time: time(), ...(files.size && { files: [...files.values()] }) };
      if (!collab.releaseFiles(record.files)) throw new Error("File names must be distinct, without / and not starting with a dot.");
      return collab.release(me, route.name, form.dataset.tag, record);
    });
  }
});

addEventListener("hashchange", render);
// New notes show without a page change.
setInterval(() => me && document.visibilityState === "visible" && parseRoute(location.hash).view !== "inbox" && countUnread(), 30_000);
me = await wallet.address().catch(() => null);
renderWho();
render();
