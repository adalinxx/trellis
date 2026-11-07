// The page's pure parts: routes, names, sizes, dates, and README links.
// No DOM, so the unit tests run them.

export const esc = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * A route from the hash: `#/<owner>/<name>/<view>/<ref>/<path>`. Each segment
 * is URI-encoded, so a ref with slashes is one segment.
 */
export function parseRoute(hash) {
  const parts = hash.replace(/^#\/?/, "").split("?")[0].split("/").filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  const query = new URLSearchParams(hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "");
  if (parts.length === 0) return { view: "home" };
  if (parts[0] === "settings") return { view: "settings" };
  if (parts[0] === "inbox" && parts.length === 1) return { view: "inbox" };
  if (parts.length === 1) return { view: "owner", owner: parts[0] };
  const [owner, name, view = "code", ref, ...path] = parts;
  if (view === "commit") return { view, owner, name, cid: ref };
  if (view === "issues" || view === "pulls") return ref === "new" ? { view: `${view}-new`, owner, name } : { view, owner, name, closed: query.get("state") === "closed", ...(query.get("q") && { q: query.get("q") }) };
  if (view === "issue" || view === "pull") return { view, owner, name, author: ref, id: path[0], tab: path[1] === "files" || path[1] === "commits" ? path[1] : "conversation", ...(query.get("since") && { since: query.get("since") }) };
  if (view === "commits") return { view, owner, name, ref, limit: Number(query.get("n")) || 30 };
  if (view === "branches" || view === "tags") return { view, owner, name };
  if (view === "search") return { view, owner, name, ref, q: query.get("q") ?? "" };
  if (view === "tree" || view === "blob") return { view, owner, name, ref, path: path.join("/") };
  return { view: "code", owner, name };
}

/** The hash for a route (the inverse of parseRoute). */
export function href({ view, owner, name, ref, path, cid, limit, closed, author, id, tab, since, q }) {
  const e = encodeURIComponent;
  if (view === "home") return "#/";
  if (view === "settings") return "#/settings";
  if (view === "inbox") return "#/inbox";
  if (view === "owner") return `#/${e(owner)}`;
  const base = `#/${e(owner)}/${e(name)}`;
  if (view === "commit") return `${base}/commit/${e(cid)}`;
  if (view === "commits") return `${base}/commits/${e(ref)}${limit ? `?n=${limit}` : ""}`;
  if (view === "issues" || view === "pulls") {
    const query = new URLSearchParams({ ...(closed && { state: "closed" }), ...(q && { q }) }).toString();
    return `${base}/${view}${query ? `?${query}` : ""}`;
  }
  if (view === "search") return `${base}/search/${e(ref ?? "HEAD")}${q ? `?q=${e(q)}` : ""}`;
  if (view === "issues-new" || view === "pulls-new") return `${base}/${view.slice(0, -4)}/new`;
  if (view === "issue" || view === "pull") return `${base}/${view}/${e(author)}/${e(id)}${tab && tab !== "conversation" ? `/${tab}` : ""}${since ? `?since=${e(since)}` : ""}`;
  if (view === "branches" || view === "tags") return `${base}/${view}`;
  if (view === "tree" || view === "blob") return `${base}/${view}/${e(ref)}${path ? `/${path.split("/").map(e).join("/")}` : ""}`;
  return base;
}

/** The branch a repo opens on: main, else master, else the first. */
export function defaultBranch(refs) {
  const names = [...refs.keys()].filter((r) => r.startsWith("refs/heads/")).sort();
  return ["refs/heads/main", "refs/heads/master"].find((r) => refs.has(r)) ?? names[0];
}

/** A short ref name (`main`, `v1.0`) or a full one, as its full name in `refs`. */
export function fullRef(refs, ref) {
  return [ref, `refs/heads/${ref}`, `refs/tags/${ref}`].find((r) => refs.has(r));
}

/** A ref's name as people say it. */
export const shortRef = (ref) => ref.replace(/^refs\/(heads|tags)\//, "");

/** An account address, shortened: `bafyrei` dropped, the first and last few kept. */
export const shortAccount = (address) => {
  const body = address.replace(/^bafyrei/, "");
  return body.length > 12 ? `${body.slice(0, 6)}…${body.slice(-4)}` : body;
};

export function bytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) (value /= 1024), unit++;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** A time as "3 days ago", or the date when over a month old. */
export function ago(seconds, now = Date.now() / 1000) {
  const s = Math.max(0, now - seconds);
  const steps = [[60, "second"], [60, "minute"], [24, "hour"], [30, "day"]];
  let value = s;
  for (const [size, unit] of steps) {
    if (value < size) {
      const n = Math.floor(value);
      return n <= 0 && unit === "second" ? "just now" : `${n} ${unit}${n === 1 ? "" : "s"} ago`;
    }
    value /= size;
  }
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

/**
 * Where a README's link goes: an absolute http(s) or mailto URL as it is,
 * an in-page anchor as it is, a path relative to the README's directory as
 * `{ path }` in the repo; anything else (javascript:, data:) is dropped.
 */
export function linkTarget(target, dir) {
  if (/^(https?:|mailto:)/i.test(target)) return { url: target };
  if (target.startsWith("#")) return { anchor: target };
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) return undefined;
  const [path] = target.split(/[?#]/);
  const parts = (path.startsWith("/") ? [] : dir.split("/").filter(Boolean));
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return { path: parts.join("/") };
}

const IMAGES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", ico: "image/x-icon" };
/** An image file's media type, by its name, or undefined. */
export const imageType = (name) => IMAGES[name.split(".").pop().toLowerCase()];

/** A commit message's first line, and the rest. */
export function subject(message) {
  const [first, ...rest] = message.split("\n");
  return { subject: first, body: rest.join("\n").trim() };
}
