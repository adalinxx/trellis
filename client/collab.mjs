// Issues, pull requests, comments, line reviews, labels and releases, as
// records on Trellis's chain. Every key belongs to the account named in it
// (`user/<a>/...`, or the last segment of `index/...`), so nobody writes for
// anyone else; a repo's maintainers are its owner and the delegates its card
// names, and only their triage records count for it. Values are JSON.
//
//   user/<a>/issue/<id>                              { repo: "<owner>/<name>", title, body, time, state?, updated?, head?, base? }
//   index/issue/<owner>/<name>/<id>/<a>              "1"   lists it under the repo
//   user/<a>/post/<id>                               { on: "<author>/<id>", body, time, review? }
//   index/post/<author>/<id>/<post id>/<a>           "1"   lists it under the issue
//   user/<m>/triage/<owner>/<name>/<author>/<id>     { state?, labels?, time }   a maintainer's word on it
//   user/<m>/release/<name>/<tag>                    { title?, notes, time }     a maintainer's release
//   index/inbox/<to>/<time>/<id>/<a>                 { kind, repo, thread }      tells <to> of <a>'s issue or comment <id>
//
// Whoever writes an issue or comment also tells the people it concerns, in
// the same transaction: the repo's maintainers, and for a comment the
// thread's author and earlier commenters, and anyone it mentions by @handle. Each reads their inbox in one prefix read,
// and a note counts only if the record it names is there.
// A pull request is an issue with `head: "<a>/<name>:<branch>"` (any repo's
// branch) and `base: "<branch>"` (the repo's). It is merged once the base
// branch contains the head's commit: merging is a push, and needs no record.
// A line review is a comment with `review: { commit, path, line, side }`:
// the head commit it was made on, and a line of the new ("new") or old
// ("old") side of that file's diff. Times are the writer's own claim.
import { checkName, maintainers } from "./records.mjs";

const ID = /^[0-9a-f]{16}$/;
const LABEL = /^[^\s,][^,]{0,49}$/;

/** A new id for an issue or comment. Ids carry no meaning; the time is in the record. */
export const newId = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");

const json = (value) => (value === undefined ? undefined : JSON.stringify(value));
const parse = (value) => {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};
const text = (value, max) => typeof value === "string" && value.length <= max;
const isTime = (value) => Number.isSafeInteger(value) && value > 0;
const flag = (on) => (on ? "1" : undefined);

export const issueKey = (a, id) => `user/${a}/issue/${id}`;
export const postKey = (a, id) => `user/${a}/post/${id}`;
export const triageKey = (m, owner, name, author, id) => `user/${m}/triage/${owner}/${checkName(name)}/${author}/${id}`;
export const releaseKey = (m, name, tag) => `user/${m}/release/${checkName(name)}/${tag}`;

// ---- Writes: lists of [key, value]; a value of undefined deletes the key.

/**
 * `a` opens an issue on `<owner>/<name>` (with `head` and `base`, a pull
 * request), or rewrites one they opened (an edit, or `state: "closed"`).
 */
export function issue(a, id, record) {
  const { owner, name } = repoOf(record.repo);
  return [
    [issueKey(a, id), json(record)],
    [`index/issue/${owner}/${checkName(name)}/${id}/${a}`, flag(record !== undefined)],
  ];
}

/** `a` comments on issue `<author>/<id>`; with `review`, on a line of its changes. */
export function post(a, id, record) {
  const [author, on] = record.on.split("/");
  return [
    [postKey(a, id), json(record)],
    [`index/post/${author}/${on}/${id}/${a}`, flag(record !== undefined)],
  ];
}

/** Maintainer `m` closes or reopens, or labels, `<author>/<id>` on `<owner>/<name>`. */
export const triage = (m, owner, name, author, id, record) => [[triageKey(m, owner, name, author, id), json(record)]];

/** Maintainer `m` writes the release of tag `tag` in their repo `name`. */
export const release = (m, name, tag, record) => [[releaseKey(m, name, tag), json(record)]];

/** The inbox key that tells `to` of `a`'s record `id`, written at `time`. */
export const inboxKey = (to, time, id, a) => `index/inbox/${to}/${String(time).padStart(12, "0")}/${id}/${a}`;

/**
 * `a` tells each of `to` (but themself) of their issue or comment `id`:
 * `note` is `{ kind: "issue" | "pull" | "comment" | "review", repo, thread: "<author>/<id>" }`.
 */
export const notify = (a, to, time, id, note) =>
  [...new Set(to)].filter((t) => typeof t === "string" && t && t !== a && !t.includes("/")).slice(0, 50).map((t) => [inboxKey(t, time, id, a), json(note)]);

/** The @handles a body mentions, at most ten, without the @. */
export const mentions = (body) => [...new Set([...String(body).matchAll(/(?:^|[^\w@/])@([a-z0-9_]{1,32})\b/g)].map((m) => m[1]))].slice(0, 10);

// ---- Reads, from a state view `{ get, list }` (state.mjs).

/** `"<owner>/<name>"` as its parts. */
export function repoOf(repo) {
  const [owner, name, ...rest] = String(repo).split("/");
  if (!owner || !name || rest.length) throw new Error(`not a repo: ${repo}`);
  return { owner, name };
}

/** `"<a>/<name>:<branch>"` as its parts, or undefined. */
export function headOf(head) {
  const match = /^([^/:]+)\/([^/:]+):(.+)$/.exec(String(head));
  return match ? { owner: match[1], name: match[2], branch: match[3] } : undefined;
}

/** An issue record, or undefined unless it is one, on `repo`. */
export function readIssue(value, repo) {
  const r = parse(value);
  if (!r || r.repo !== repo || !text(r.title, 300) || r.title.trim() === "" || !text(r.body ?? "", 65536) || !isTime(r.time)) return undefined;
  if (r.state !== undefined && r.state !== "closed" && r.state !== "open") return undefined;
  if (r.updated !== undefined && !isTime(r.updated)) return undefined;
  if ((r.head !== undefined || r.base !== undefined) && !(headOf(r.head) && text(r.base, 250) && r.base !== "")) return undefined;
  return { repo: r.repo, title: r.title, body: r.body ?? "", time: r.time, state: r.state ?? "open", updated: r.updated ?? r.time, ...(r.head && { head: r.head, base: r.base }) };
}

/** A comment record on `on`, or undefined. */
export function readPost(value, on) {
  const r = parse(value);
  if (!r || r.on !== on || !text(r.body, 65536) || r.body.trim() === "" || !isTime(r.time)) return undefined;
  if (r.review !== undefined) {
    const { commit, path, line, side } = r.review ?? {};
    if (!text(commit, 200) || !text(path, 4096) || !Number.isSafeInteger(line) || line < 1 || (side !== "new" && side !== "old")) return undefined;
    return { on, body: r.body, time: r.time, review: { commit, path, line, side } };
  }
  return { on, body: r.body, time: r.time };
}

/**
 * Who a new record on `<owner>/<name>` concerns: the repo's maintainers, and
 * with `thread` (`{ author, id }`, a comment there) its author and everyone
 * who commented. Plus `also` (mentioned).
 */
export async function concerned(state, owner, name, card, thread, also = []) {
  if (!thread) return [...maintainers(owner, card), ...also];
  return [thread.author, ...maintainers(owner, card), ...(await posts(state, thread.author, thread.id)).map((p) => p.by), ...also];
}

/**
 * `me`'s inbox, newest first, at most `limit`: `[{ from, id, time, kind, repo,
 * thread, title, body? }]`, each only if the issue or comment it names is
 * there, by whom the note says, on the thread and repo it says.
 */
export async function inbox(state, me, { limit = 100 } = {}) {
  const prefix = `index/inbox/${me}/`;
  const notes = [];
  for await (const [key, value] of state.list(prefix)) {
    const [time, id, from, ...rest] = key.slice(prefix.length).split("/");
    const note = parse(value);
    if (rest.length || !ID.test(id ?? "") || !/^\d{12}$/.test(time) || !note || !["issue", "pull", "comment", "review"].includes(note.kind)) continue;
    notes.push({ from, id, time: Number(time), kind: note.kind, repo: String(note.repo), thread: String(note.thread) });
  }
  const newest = notes.reverse().slice(0, limit);
  const checked = await Promise.all(newest.map(async (n) => {
    const [author, tid] = n.thread.split("/");
    if (!author || !ID.test(tid ?? "")) return undefined;
    const issue = readIssue(await state.get(issueKey(author, tid)), n.repo);
    if (!issue) return undefined;
    if (n.kind === "issue" || n.kind === "pull") return n.from === author && n.id === tid && Boolean(issue.head) === (n.kind === "pull") ? { ...n, title: issue.title, body: issue.body } : undefined;
    const post = readPost(await state.get(postKey(n.from, n.id)), n.thread);
    return post && Boolean(post.review) === (n.kind === "review") ? { ...n, title: issue.title, body: post.body, pull: Boolean(issue.head) } : undefined;
  }));
  return checked.filter(Boolean);
}

function readTriage(value) {
  const r = parse(value);
  if (!r || !isTime(r.time)) return undefined;
  if (r.state !== undefined && r.state !== "open" && r.state !== "closed") return undefined;
  if (r.labels !== undefined && !(Array.isArray(r.labels) && r.labels.length <= 20 && r.labels.every((l) => typeof l === "string" && LABEL.test(l)))) return undefined;
  return { state: r.state, labels: r.labels, time: r.time };
}

/** Labels as typed, comma-separated: trimmed, distinct, valid. */
export const labelsOf = (typed) => [...new Set(typed.split(",").map((l) => l.trim()).filter((l) => LABEL.test(l)))].slice(0, 20);

async function collect(iterable) {
  const out = [];
  for await (const entry of iterable) out.push(entry);
  return out;
}

export { maintainers };

/**
 * Every issue and pull request on `<owner>/<name>`, newest first, each with
 * its state and labels as its author and the maintainers last set them:
 * `[{ author, id, ...record, state, labels }]`.
 */
export async function issues(state, owner, name, card) {
  const repo = `${owner}/${name}`;
  const prefix = `index/issue/${owner}/${checkName(name)}/`;
  const listed = (await collect(state.list(prefix)))
    .filter(([, value]) => value === "1")
    .map(([key]) => key.slice(prefix.length).split("/"))
    .filter((parts) => parts.length === 2 && ID.test(parts[0]));
  const words = await triages(state, owner, name, card);
  const out = await Promise.all(listed.map(async ([id, author]) => {
    const record = readIssue(await state.get(issueKey(author, id)), repo);
    return record && withTriage({ author, id, ...record }, words.get(`${author}/${id}`) ?? []);
  }));
  return out.filter(Boolean).sort((a, b) => b.time - a.time || (a.id < b.id ? -1 : 1));
}

/** One issue, or undefined. */
export async function oneIssue(state, owner, name, card, author, id) {
  if (!ID.test(id)) return undefined;
  const record = readIssue(await state.get(issueKey(author, id)), `${owner}/${name}`);
  if (!record) return undefined;
  const words = await triages(state, owner, name, card);
  return withTriage({ author, id, ...record }, words.get(`${author}/${id}`) ?? []);
}

/** Every maintainer's triage records on the repo: a Map from `<author>/<id>` to `[{ by, state?, labels?, time }]`. */
async function triages(state, owner, name, card) {
  const out = new Map();
  for (const m of maintainers(owner, card)) {
    const prefix = `user/${m}/triage/${owner}/${checkName(name)}/`;
    for (const [key, value] of await collect(state.list(prefix))) {
      const target = key.slice(prefix.length);
      const record = target.split("/").length === 2 && readTriage(value);
      if (!record) continue;
      if (!out.has(target)) out.set(target, []);
      out.get(target).push({ by: m, ...record });
    }
  }
  return out;
}

/**
 * The state the latest word set (the author's own, or a maintainer's
 * triage), and the labels the latest maintainer to label it gave.
 */
function withTriage(issue, words) {
  const states = [{ by: issue.author, state: issue.state, time: issue.updated }, ...words.filter((w) => w.state)];
  const latest = states.reduce((a, b) => (b.time >= a.time ? b : a));
  const labelled = words.filter((w) => w.labels).reduce((a, b) => (!a || b.time >= a.time ? b : a), undefined);
  return { ...issue, state: latest.state, closedBy: latest.state === "closed" ? latest.by : undefined, labels: labelled?.labels ?? [] };
}

/** The comments on `<author>/<id>`, oldest first: `[{ by, id, body, time, review? }]`. */
export async function posts(state, author, id) {
  const prefix = `index/post/${author}/${id}/`;
  const listed = (await collect(state.list(prefix)))
    .filter(([, value]) => value === "1")
    .map(([key]) => key.slice(prefix.length).split("/"))
    .filter((parts) => parts.length === 2 && ID.test(parts[0]));
  const out = await Promise.all(listed.map(async ([pid, by]) => {
    const record = readPost(await state.get(postKey(by, pid)), `${author}/${id}`);
    return record && { by, id: pid, ...record };
  }));
  return out.filter(Boolean).sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : 1));
}

/** The maintainers' releases of `<owner>/<name>`: a Map from tag to `{ by, title?, notes, time }`, the latest per tag. */
export async function releases(state, owner, name, card) {
  const out = new Map();
  for (const m of maintainers(owner, card)) {
    const prefix = `user/${m}/release/${checkName(name)}/`;
    for (const [key, value] of await collect(state.list(prefix))) {
      const tag = key.slice(prefix.length);
      const r = parse(value);
      if (!r || !text(r.notes ?? "", 65536) || !isTime(r.time) || (r.title !== undefined && !text(r.title, 300))) continue;
      // The owner's release, else the latest delegate's.
      if (m === owner && m !== out.get(tag)?.by) out.set(tag, { by: m, title: r.title, notes: r.notes ?? "", time: r.time });
      else if (!out.has(tag) || (out.get(tag).by !== owner && r.time > out.get(tag).time)) out.set(tag, { by: m, title: r.title, notes: r.notes ?? "", time: r.time });
    }
  }
  return out;
}
