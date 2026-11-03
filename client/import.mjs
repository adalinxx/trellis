// `trellis import`: a SHA-1 repository (a GitHub URL, or any path or URL git
// clones) as a new SHA-256 repository, by git's own fast-export and
// fast-import. Authors, dates, messages, trees and files are kept byte for
// byte; only the object ids change. So signatures made over the old ids no
// longer verify: each is kept as text, with the commit's or tag's old id, in
// a git note (refs/notes/commits, which `git log` shows), so an old id in a
// message or a link can still be found. Branches and tags are imported, and
// HEAD names the source's default branch. Node only.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { git, objectReader } from "./git.mjs";

const SIGNATURE = /\n-----BEGIN (PGP|SSH) SIGNATURE-----\n[\s\S]*$/;

/** A commit's signature headers (`gpgsig`, `gpgsig-sha256`), as text, or "". */
export function commitSignature(raw) {
  const text = Buffer.from(raw).toString("latin1");
  const headers = text.slice(0, text.indexOf("\n\n") + 1).split("\n");
  const out = [];
  for (let i = 0; i < headers.length; i++) {
    if (!/^gpgsig(-sha256)? /.test(headers[i])) continue;
    out.push(headers[i].replace(/^gpgsig(-sha256)? /, ""));
    while (headers[i + 1]?.startsWith(" ")) out.push(headers[++i].slice(1));
  }
  return out.join("\n");
}

/** An annotated tag's signature (the armored block its message ends with), or "". */
export const tagSignature = (raw) => Buffer.from(raw).toString("latin1").match(SIGNATURE)?.[0].slice(1) ?? "";

/** Whether any commit's tree holds a submodule (a gitlink, mode 160000). */
function hasGitlink(bare) {
  const listed = spawnSync("bash", ["-c", 'git -C "$1" rev-list --branches --tags | git -C "$1" diff-tree --stdin -r --root --no-commit-id --raw | grep -q "^:[0-7]* 160000 \\|^:160000 "', "gitlinks", bare]);
  return listed.status === 0;
}

/** `:mark id` lines → Map mark → id. */
const marks = (file) => new Map(readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => line.split(" ")));

/**
 * How a note names the source: a URL without its credentials, or a local
 * path's last segment only (a path can name the machine's user).
 */
export function sourceLabel(source) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
    const url = new URL(source);
    if (url.protocol === "file:") return sourceLabel(decodeURIComponent(url.pathname));
    url.username = url.password = "";
    return url.toString().replace(/\/$/, "");
  }
  if (/^[^/\s]+@[^:/\s]+:/.test(source)) return source.replace(/^[^@]+@/, "");
  return basename(source.replace(/\/+$/, "")).replace(/\.git$/, "");
}

/** The note an imported object carries. */
export function note(source, oldId, signature) {
  let text = `Imported from ${source} as ${oldId}.\n`;
  if (signature) text += `\nSigned before import (the signature was made over the old ids, so it no longer verifies):\n\n${signature.trimEnd()}\n`;
  return text;
}

/**
 * Imports `source` into a new SHA-256 repository at `dest` (which must not
 * exist). Resolves to `{ head, branches, tags, commits, signed }`.
 */
export async function importRepository(source, dest, { now = Math.floor(Date.now() / 1000) } = {}) {
  const work = mkdtempSync(join(tmpdir(), "trellis-import-"));
  try {
    const bare = join(work, "source.git");
    const label = sourceLabel(source);
    execFileSync("git", ["clone", "--bare", "--quiet", source, bare], { stdio: ["ignore", "ignore", "inherit"] });
    if (git(bare, "rev-parse", "--show-object-format") !== "sha1") throw new Error(`${label} already uses SHA-256 ids: push it as it is`);
    const head = git(bare, "symbolic-ref", "--short", "HEAD");
    const branches = git(bare, "for-each-ref", "--format=%(refname)", "refs/heads").split("\n").filter(Boolean);
    const tags = git(bare, "for-each-ref", "--format=%(refname)", "refs/tags").split("\n").filter(Boolean);
    if (branches.length === 0) throw new Error(`${label} has no branches`);

    // The signatures, read before fast-export strips them.
    const commitIds = git(bare, "rev-list", "--branches", "--tags").split("\n").filter(Boolean);
    const annotated = git(bare, "for-each-ref", "--format=%(objecttype) %(objectname) %(refname)", "refs/tags")
      .split("\n").filter((line) => line.startsWith("tag ")).map((line) => line.split(" ").slice(1));
    const tagIds = annotated.map(([id]) => id);
    const signatures = new Map();
    const reader = objectReader(bare);
    try {
      for (const id of commitIds) signatures.set(id, commitSignature((await reader.read(id)).raw));
      for (const id of tagIds) signatures.set(id, tagSignature((await reader.read(id)).raw));
    } finally {
      reader.close();
    }

    const oldMarks = join(work, "old.marks");
    const newMarks = join(work, "new.marks");
    const strip = /signed-commits/.test(spawnSync("git", ["fast-export", "-h"], { encoding: "utf8" }).stdout) ? ["--signed-commits=strip"] : [];
    execFileSync("git", ["init", "--quiet", "--object-format=sha256", "-b", head, dest]);
    // Streamed: fast-export's output can be as large as the repository.
    const imported = spawnSync("bash", ["-c", 'set -o pipefail; git -C "$1" fast-export --branches --tags --reencode=no --signed-tags=strip $4 --mark-tags --export-marks="$2" | git -C "$3" fast-import --quiet --export-marks="$5"',
      "import", bare, oldMarks, dest, strip.join(" "), newMarks], { encoding: "utf8" });
    if (imported.status !== 0) {
      const why = imported.stderr.trim();
      if (hasGitlink(bare))
        throw new Error("the repository has submodules: their ids are SHA-1, so it can't be converted as it is");
      throw new Error(`git fast-export | fast-import: ${why}`);
    }

    // Old id → new id, for every commit.
    const before = marks(oldMarks);
    const after = marks(newMarks);
    const renamed = new Map();
    for (const [mark, oldId] of before) if (signatures.has(oldId) && after.has(mark)) renamed.set(oldId, after.get(mark));

    // One notes commit carrying a note for each.
    const data = (text) => `data ${Buffer.byteLength(text)}\n${text}\n`;
    let notes = `commit refs/notes/commits\ncommitter Trellis import <> ${now} +0000\n${data(`Imported from ${label}\n`)}`;
    for (const [oldId, newId] of renamed) notes += `N inline ${newId}\n${data(note(label, oldId, signatures.get(oldId)))}`;
    execFileSync("git", ["-C", dest, "fast-import", "--quiet"], { input: notes });
    // A tag's note: fast-import writes no marks for tags, and its N command
    // would put the note on the tagged commit. A tag keeps its name. The
    // identity is set, or git would use this machine's user's.
    const as = { ...process.env, GIT_AUTHOR_NAME: "Trellis import", GIT_AUTHOR_EMAIL: "", GIT_COMMITTER_NAME: "Trellis import", GIT_COMMITTER_EMAIL: "", GIT_AUTHOR_DATE: `${now} +0000`, GIT_COMMITTER_DATE: `${now} +0000` };
    for (const [oldId, ref] of annotated)
      execFileSync("git", ["-C", dest, "notes", "add", "-f", "-F", "-", git(dest, "rev-parse", ref)], { input: note(label, oldId, signatures.get(oldId)), env: as });
    git(dest, "reset", "--quiet", "--hard");

    return { head, branches, tags, commits: commitIds.length, signed: [...signatures.values()].filter(Boolean).length };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
