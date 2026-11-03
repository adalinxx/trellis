// Trellis in the browser: a repo's branches from the chain's state, its code
// from Lattice content, one block at a time, only the blocks a page shows.
// Every block is checked against its CID, so the node is trusted to serve
// the code, never to serve it correctly. No server of its own.
import * as sdk from "../vendor/lattice-sdk.js";
import * as records from "../client/records.mjs";
import { tip, view, volumeLoader } from "../client/state.mjs";
import { hunks, isText, lineDiff, lines, reader } from "../client/browse.mjs";
import { Marked } from "./vendor/marked.esm.js";
import { ago, bytes, defaultBranch, esc, fullRef, href, imageType, linkTarget, parseRoute, shortAccount, shortRef, subject } from "./lib.mjs";

const $ = (s) => document.querySelector(s);
const DEFAULTS = { node: "https://lattice-testnet-apps-iad.fly.dev", chain: "Nexus/testnet/trellis" };
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
// ?node= and ?chain= on the page's URL win over what Settings saved.
const query = new URLSearchParams(location.search);
const settings = {
  node: (query.get("node") || saved("node") || DEFAULTS.node).replace(/\/+$/, ""),
  chain: query.get("chain") || saved("chain") || DEFAULTS.chain,
};

// The chain, as the node in Settings serves it.
let chain;
function connect() {
  const chainPath = settings.chain.split("/");
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
  let current;
  chain = {
    read,
    // The state at the node's tip, read again when over 10 s old.
    async state() {
      if (!current || Date.now() - current.at > 10_000) {
        current = (async () => {
          const { generalStateCID } = await tip(sdk, settings.node, chainPath, volumes);
          return view(volumeLoader(volumes, sdk.decodeDagCbor), generalStateCID);
        })();
        current.at = Date.now();
        current.catch(() => (current = undefined));
      }
      return current;
    },
  };
}
connect();

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
    }
  }
}

async function page(route, show) {
  if (route.view === "home") return home();
  if (route.view === "settings") return settingsPage();
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
    ["commits", "Commits", href({ view: "commits", owner, name, ref: ref ?? "HEAD" })],
    ["branches", "Branches", href({ view: "branches", owner, name })],
    ["tags", "Tags", href({ view: "tags", owner, name })],
  ];
  return `<div class="repo-head">
      <h1><a href="${href({ view: "owner", owner })}" class="owner" title="${esc(owner)}">${esc(shortAccount(owner))}</a> <span class="muted">/</span> <a href="${href({ view: "code", owner, name })}">${esc(name)}</a></h1>
      ${card?.description ? `<p class="lede">${esc(card.description)}</p>` : ""}
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
  const head = (tab, ref) => repoHead(route, card, tab, ref);
  if (refs.size === 0) return `${head("code")}<p class="empty">Nothing has been pushed yet.</p>${cloneBox(route)}`;
  if (route.view === "branches" || route.view === "tags") return head(route.view) + (await refList(route, refs));
  if (route.view === "commit") return head("commits") + (await commitPage(route));

  const at = await resolve(refs, route.ref);
  if (!at) return `${head("code")}<p class="empty">No branch or tag called ${esc(route.ref)}.</p>`;
  if (route.view === "commits") return head("commits", at.name) + (await commitsPage(route, refs, at));

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
    <span class="mono id">${esc(c.id.slice(0, 10))}</span></li>`;
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

async function fileDiff(route, commit, { path, status, before, after }) {
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
  const rows = shown.map((h) => `<tr class="hunk"><td colspan="3">@@ −${h.a},${h.aLines} +${h.b},${h.bLines} @@</td></tr>${h.steps.map((s) => `<tr class="${s.op === "+" ? "add" : s.op === "-" ? "del" : ""}"><td class="ln" data-n="${s.a ?? ""}"></td><td class="ln" data-n="${s.b ?? ""}"></td><td class="src"><span class="op">${s.op}</span>${esc(s.line)}</td></tr>`).join("")}`);
  return wrap(`<table class="code diff-table"><tbody>${rows.join("")}</tbody></table>`, added, removed);
}

async function refList(route, refs) {
  const kind = route.view === "branches" ? "refs/heads/" : "refs/tags/";
  const names = [...refs.keys()].filter((r) => r.startsWith(kind)).sort(byVersion);
  if (names.length === 0) return `<p class="empty">No ${route.view}.</p>`;
  const rows = await Promise.all(names.map(async (r) => {
    const { commit, tags } = await chain.read.peel(refs.get(r));
    const c = await chain.read.commit(commit);
    const note = tags[0]?.message ? ` · ${esc(subject(tags[0].message).subject)}` : "";
    return `<li class="ref-row"><a class="ref-name" href="${href({ view: "tree", owner: route.owner, name: route.name, ref: shortRef(r), path: "" })}">${esc(shortRef(r))}</a>
      <span class="muted">${esc(subject(c.message).subject)} · ${esc(ago(c.committer.time))}${note}</span><span class="mono id">${esc(c.id.slice(0, 10))}</span></li>`;
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
      <div class="row2"><button type="button" class="btn" data-act="defaults">Defaults</button><button class="btn primary">Save</button></div>
    </form>`;
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
  if (button.dataset.act === "retry") render();
  if (button.dataset.act === "defaults") {
    $("#node").value = DEFAULTS.node;
    $("#chain").value = DEFAULTS.chain;
  }
  if (button.dataset.act === "download") {
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

document.addEventListener("submit", (event) => {
  if (event.target.id !== "settings") return;
  event.preventDefault();
  settings.node = $("#node").value.trim().replace(/\/+$/, "");
  settings.chain = $("#chain").value.trim();
  save("node", settings.node === DEFAULTS.node ? "" : settings.node);
  save("chain", settings.chain === DEFAULTS.chain ? "" : settings.chain);
  connect();
  location.hash = "#/";
});

addEventListener("hashchange", render);
render();
