// Reading a repo the way a browser shows it: one block at a time, only the
// blocks on the path being shown. A tree is read without its files, a file's
// size without its chunks, and a commit's changes descend only into subtrees
// whose CIDs differ. Every block is checked against its CID (objects.mjs).
// Browser-safe.
import { readObject, decodeBlock } from "./objects.mjs";
import { assemble, chunkLength } from "../vendor/storage-file.mjs";

const utf8 = new TextDecoder();
const GITLINK = "160000";

/** A tree entry's kind, from its mode. */
export const kindOf = (mode) => (mode === "40000" ? "tree" : mode === GITLINK ? "submodule" : mode === "120000" ? "link" : "blob");

/** `Name <email> <seconds> <±hhmm>` as `{ name, email, time, zone }`. */
function person(line) {
  const match = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  return match ? { name: match[1], email: match[2], time: Number(match[3]), zone: match[4] } : { name: line, email: "", time: 0, zone: "+0000" };
}

/**
 * A commit's `rest` (every byte after its tree and parent lines) as
 * `{ author, committer, message, signed }`. The message is UTF-8 unless an
 * `encoding` header names Latin-1.
 */
export function parseCommit(rest) {
  const end = rest.findIndex((byte, i) => byte === 0x0a && rest[i + 1] === 0x0a);
  const head = end < 0 ? rest : rest.subarray(0, end);
  const body = end < 0 ? new Uint8Array() : rest.subarray(end + 2);
  const headers = new Map();
  let last;
  for (const line of utf8.decode(head).split("\n")) {
    if (line.startsWith(" ") && last) headers.set(last, `${headers.get(last)}\n${line.slice(1)}`);
    else {
      const space = line.indexOf(" ");
      last = line.slice(0, space);
      if (!headers.has(last)) headers.set(last, line.slice(space + 1));
    }
  }
  const encoding = headers.get("encoding")?.toLowerCase();
  const message = /^(iso-8859-1|latin-?1)$/.test(encoding ?? "") ? String.fromCharCode(...body) : utf8.decode(body);
  return {
    author: person(headers.get("author") ?? ""),
    committer: person(headers.get("committer") ?? ""),
    message,
    signed: headers.has("gpgsig") || headers.has("gpgsig-sha256"),
  };
}

/** A tag's `rest` as `{ type, tag, tagger, message }`. */
export function parseTag(rest) {
  const text = utf8.decode(rest);
  const end = text.indexOf("\n\n");
  const headers = Object.fromEntries((end < 0 ? text : text.slice(0, end)).split("\n").map((line) => [line.slice(0, line.indexOf(" ")), line.slice(line.indexOf(" ") + 1)]));
  const message = end < 0 ? "" : text.slice(end + 2).replace(/\n-----BEGIN (PGP|SSH) SIGNATURE-----\n[\s\S]*$/, "\n");
  return { type: headers.type, tag: headers.tag, tagger: headers.tagger ? person(headers.tagger) : undefined, message };
}

/**
 * A repo's objects read through `load(cid)` (a block's bytes). Blocks are
 * immutable, so each is read once.
 */
export function reader(sdk, load) {
  const objects = new Map();
  const object = (cid) => {
    if (!objects.has(cid)) {
      objects.set(cid, (async () => {
        const read = readObject(sdk, cid, await load(cid));
        if (!read) throw new Error(`${cid} is not a git object block`);
        return read;
      })());
      objects.get(cid).catch(() => objects.delete(cid));
    }
    return objects.get(cid);
  };

  async function commit(cid) {
    const { type, block } = await object(cid);
    if (type !== "commit") throw new Error(`${cid} is a ${type}, not a commit`);
    return { cid, id: block.id, tree: block.tree, parents: block.parents, ...parseCommit(block.rest) };
  }

  /** The commit a ref names, through any tags; with the tags it passed. */
  async function peel(cid) {
    const tags = [];
    for (;;) {
      const { type, block } = await object(cid);
      if (type === "commit") return { commit: cid, tags };
      if (type !== "tag") throw new Error(`${cid} is a ${type}, not a commit`);
      tags.push({ cid, id: block.id, ...parseTag(block.rest) });
      cid = block.object;
    }
  }

  /** A tree's entries, directories first, then by name (as GitHub lists them). */
  async function tree(cid) {
    const { type, block } = await object(cid);
    if (type !== "tree") throw new Error(`${cid} is a ${type}, not a tree`);
    return block.entries
      .map((e) => ({ name: utf8.decode(e.name), mode: e.mode, kind: kindOf(e.mode), cid: e.cid, id: e.id }))
      .sort((a, b) => (a.kind === "tree") !== (b.kind === "tree") ? (a.kind === "tree" ? -1 : 1) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  }

  /** A file's size from its root block alone. */
  async function size(cid) {
    const { type, block } = await object(cid);
    if (type !== "blob") throw new Error(`${cid} is a ${type}, not a file`);
    return Number(block.size);
  }

  /** A file's bytes: its root block, then its chunks if it has any. */
  async function blob(cid) {
    const { type, block, links } = await object(cid);
    if (type !== "blob") throw new Error(`${cid} is a ${type}, not a file`);
    if (links.length === 0) return block.bytes;
    const chunks = await Promise.all(links.map(async (chunkCID, index) => {
      const chunk = decodeBlock(sdk, chunkCID, await load(chunkCID));
      if (!(chunk?.bytes instanceof Uint8Array) || chunk.bytes.length !== chunkLength(block, index)) throw new Error(`${chunkCID} is not chunk ${index} of ${cid}`);
      return chunk.bytes;
    }));
    return assemble(block, chunks);
  }

  /** The entry at `path` ("" is the root) under tree `root`, or undefined. */
  async function at(root, path) {
    let entry = { name: "", mode: "40000", kind: "tree", cid: root };
    for (const part of path.split("/").filter(Boolean)) {
      if (entry.kind !== "tree") return undefined;
      entry = (await tree(entry.cid)).find((e) => e.name === part);
      if (!entry) return undefined;
    }
    return entry;
  }

  /**
   * Up to `limit` commits reachable from `starts`, newest committed first
   * (git log's default order), and whether there are more.
   */
  async function history(starts, limit) {
    const seen = new Set(starts);
    let queue = await Promise.all(starts.map(commit));
    const out = [];
    while (queue.length > 0 && out.length < limit) {
      queue.sort((a, b) => b.committer.time - a.committer.time);
      const next = queue.shift();
      out.push(next);
      const parents = next.parents.filter((p) => !seen.has(p));
      parents.forEach((p) => seen.add(p));
      queue.push(...(await Promise.all(parents.map(commit))));
    }
    return { commits: out, more: queue.length > 0 };
  }

  /**
   * What changed from tree `before` (undefined: nothing) to tree `after`:
   * `[{ path, status: "added" | "deleted" | "modified", before?, after? }]`,
   * in path order. Subtrees with the same CID are not read.
   */
  async function changes(before, after, prefix = "") {
    if (before === after) return [];
    const [old, now] = await Promise.all([before ? tree(before) : [], after ? tree(after) : []]);
    const names = [...new Set([...old.map((e) => e.name), ...now.map((e) => e.name)])].sort();
    const out = [];
    for (const name of names) {
      const a = old.find((e) => e.name === name);
      const b = now.find((e) => e.name === name);
      const path = prefix + name;
      if (a && b && (a.cid ?? a.id) === (b.cid ?? b.id) && a.mode === b.mode) continue;
      const aTree = a?.kind === "tree" ? a : undefined;
      const bTree = b?.kind === "tree" ? b : undefined;
      if (aTree || bTree) out.push(...(await changes(aTree?.cid, bTree?.cid, `${path}/`)));
      const aFile = aTree ? undefined : a;
      const bFile = bTree ? undefined : b;
      if (aFile || bFile) out.push({ path, status: !aFile ? "added" : !bFile ? "deleted" : "modified", before: aFile, after: bFile });
    }
    return out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  }

  /** The CIDs of `from` and its ancestors, at most `limit` of them. */
  async function ancestors(from, limit) {
    const seen = new Set([from]);
    let frontier = [from];
    while (frontier.length > 0 && seen.size < limit) {
      const parents = (await Promise.all(frontier.map(commit))).flatMap((c) => c.parents).filter((p) => !seen.has(p));
      parents.forEach((p) => seen.add(p));
      frontier = [...new Set(parents)];
    }
    return seen;
  }

  /**
   * A pull request's commits: those reachable from `head` but not from
   * `base` (looking `limit` commits back from each), newest first, and the
   * newest commit they share (their merge base), or undefined.
   */
  async function compare(base, head, limit = 2000) {
    const onBase = await ancestors(base, limit);
    const seen = new Set([head]);
    let queue = [await commit(head)];
    const commits = [];
    let mergeBase;
    while (queue.length > 0 && commits.length < limit) {
      queue.sort((a, b) => b.committer.time - a.committer.time);
      const next = queue.shift();
      if (onBase.has(next.cid)) {
        mergeBase ??= next.cid;
        continue;
      }
      commits.push(next);
      const parents = next.parents.filter((p) => !seen.has(p));
      parents.forEach((p) => seen.add(p));
      queue.push(...(await Promise.all(parents.map(commit))));
    }
    return { commits, mergeBase };
  }

  /** Whether `target` is `from` or one of its ancestors, looking `limit` commits back. */
  const contains = async (from, target, limit = 2000) => (await ancestors(from, limit)).has(target);

  /**
   * Files under tree `root` whose path or text holds `query` (case-insensitive):
   * `{ matches: [{ path, lines: [{ line, text }] }], files, skipped, more }`.
   * Text files of at most `maxBytes` are read, a few at a time; at most
   * `limit` files match. Every block read is checked by its CID, as always.
   */
  async function grep(root, query, { limit = 100, maxBytes = 512 << 10, linesPerFile = 5, progress = () => {} } = {}) {
    const needle = query.toLowerCase();
    const files = [];
    const walk = async (cid, prefix) => {
      const entries = await tree(cid);
      await Promise.all(entries.map((e) => (e.kind === "tree" ? walk(e.cid, `${prefix}${e.name}/`) : e.kind === "blob" ? files.push({ path: prefix + e.name, cid: e.cid }) : undefined)));
    };
    await walk(root, "");
    files.sort((a, b) => (a.path < b.path ? -1 : 1));
    const matches = [];
    let skipped = 0;
    let read = 0;
    let next = 0;
    const worker = async () => {
      while (next < files.length && matches.length < limit) {
        const file = files[next++];
        const byPath = file.path.toLowerCase().includes(needle);
        let lines = [];
        if ((await size(file.cid)) > maxBytes) skipped++;
        else {
          const bytes = await blob(file.cid);
          if (!isText(bytes)) skipped++;
          else {
            const all = new TextDecoder().decode(bytes).split("\n");
            for (let i = 0; i < all.length && lines.length < linesPerFile; i++) if (all[i].toLowerCase().includes(needle)) lines.push({ line: i + 1, text: all[i].slice(0, 300) });
          }
        }
        progress(++read, files.length);
        if (byPath || lines.length) matches.push({ path: file.path, lines });
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    matches.sort((a, b) => (a.path < b.path ? -1 : 1));
    return { matches: matches.slice(0, limit), files: files.length, skipped, more: next < files.length };
  }

  return { object, commit, peel, tree, size, blob, at, history, changes, ancestors, compare, contains, grep };
}

/** Whether bytes look like text: no NUL in the first 8000, as git decides. */
export const isText = (bytes) => !bytes.subarray(0, 8000).includes(0);

/** Text as lines, without the newline each ends with. */
export const lines = (text) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));

/**
 * The shortest edit from `a` to `b` (arrays of lines), by Myers' algorithm:
 * `[{ op: " " | "-" | "+", line, a?, b? }]`, with 1-based line numbers.
 */
export function lineDiff(a, b) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v = new Int32Array(2 * max + 2);
  const trace = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[max + k - 1] < v[max + k + 1]) ? v[max + k + 1] : v[max + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) x++, y++;
      v[max + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  // Walk back through the trace.
  const out = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const w = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && w[max + k - 1] < w[max + k + 1]) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : w[max + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) out.push({ op: " ", line: a[--x], a: x + 1, b: --y + 1 });
    if (d === 0) break;
    if (x === prevX) out.push({ op: "+", line: b[--y], b: y + 1 });
    else out.push({ op: "-", line: a[--x], a: x + 1 });
  }
  return out.reverse();
}

/** An edit as hunks: the changed lines with `context` lines around them. */
export function hunks(edit, context = 3) {
  const out = [];
  let current;
  edit.forEach((step, i) => {
    if (step.op === " ") return;
    const from = Math.max(0, i - context);
    if (current && from <= current.end) current.end = Math.min(edit.length, i + context + 1);
    else out.push((current = { start: from, end: Math.min(edit.length, i + context + 1) }));
  });
  return out.map(({ start, end }) => {
    const steps = edit.slice(start, end);
    const firstA = edit.slice(0, end).find((s, j) => j >= start && s.a)?.a ?? (edit.slice(0, start).findLast((s) => s.a)?.a ?? 0) + 1;
    const firstB = edit.slice(0, end).find((s, j) => j >= start && s.b)?.b ?? (edit.slice(0, start).findLast((s) => s.b)?.b ?? 0) + 1;
    return {
      a: firstA,
      aLines: steps.filter((s) => s.op !== "+").length,
      b: firstB,
      bLines: steps.filter((s) => s.op !== "-").length,
      steps,
    };
  });
}
