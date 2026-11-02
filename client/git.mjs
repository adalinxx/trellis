// A local git repository, through the git command: objects read with
// `git cat-file --batch`, history listed with `git rev-list`, and objects
// written as one pack that `git index-pack` checks and stores. Node only.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

/** `git -C repo args...`, its output as text. */
export const git = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 1 << 30 }).trim();

/** Throws unless `repo` keeps SHA-256 object ids: Trellis has no SHA-1 objects. */
export function requireSha256(repo) {
  const format = git(repo, "rev-parse", "--show-object-format");
  if (format !== "sha256") throw new Error(`${repo} uses ${format} object ids; Trellis takes SHA-256 repositories (git init --object-format=sha256)`);
}

/**
 * The ids of every object reachable from `include` and not from `exclude`
 * (commit ids), as `git rev-list --objects` lists them.
 */
export function objectsBetween(repo, include, exclude = []) {
  if (include.length === 0) return [];
  const out = git(repo, "rev-list", "--objects", "--no-object-names", ...include, ...exclude.map((id) => `^${id}`));
  return out ? out.split("\n") : [];
}

/**
 * A reader of objects by id: `read(id)` resolves to `{ type, raw }`. One
 * `git cat-file --batch` process answers in order; `close()` ends it.
 */
export function objectReader(repo) {
  const child = spawn("git", ["-C", repo, "cat-file", "--batch"], { stdio: ["pipe", "pipe", "inherit"] });
  const waiting = [];
  let buffer = Buffer.alloc(0);
  child.stdout.on("data", (data) => {
    buffer = Buffer.concat([buffer, data]);
    for (;;) {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0 || waiting.length === 0) return;
      const header = buffer.subarray(0, newline).toString("latin1");
      const [id, type, size] = header.split(" ");
      if (type === "missing") {
        buffer = buffer.subarray(newline + 1);
        waiting.shift().reject(new Error(`no object ${id} in ${repo}`));
        continue;
      }
      const length = Number(size);
      if (buffer.length < newline + 1 + length + 1) return;
      const raw = new Uint8Array(buffer.subarray(newline + 1, newline + 1 + length));
      buffer = buffer.subarray(newline + 1 + length + 1);
      waiting.shift().resolve({ type, raw });
    }
  });
  child.on("exit", () => waiting.splice(0).forEach((w) => w.reject(new Error("git cat-file stopped"))));
  return {
    read: (id) =>
      new Promise((resolve, reject) => {
        waiting.push({ resolve, reject });
        child.stdin.write(`${id}\n`);
      }),
    close: () => child.stdin.end(),
  };
}

const TYPES = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** A pack (version 2, no deltas) of `objects` = [{ type, raw }], its trailer SHA-256. */
export function pack(objects) {
  const parts = [Buffer.from("PACK"), Buffer.from([0, 0, 0, 2]), Buffer.alloc(4)];
  parts[2].writeUInt32BE(objects.length);
  for (const { type, raw } of objects) {
    let size = raw.length;
    const header = [(TYPES[type] << 4) | (size & 0x0f)];
    size = Math.floor(size / 16);
    while (size > 0) {
      header[header.length - 1] |= 0x80;
      header.push(size & 0x7f);
      size = Math.floor(size / 128);
    }
    parts.push(Buffer.from(header), deflateSync(raw));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash("sha256").update(body).digest()]);
}

/** Stores `objects` in `repo`; git checks each and computes its id. */
export function store(repo, objects) {
  if (objects.length === 0) return;
  execFileSync("git", ["-C", repo, "index-pack", "--stdin"], { input: pack(objects), stdio: ["pipe", "ignore", "inherit"], maxBuffer: 1 << 30 });
}
