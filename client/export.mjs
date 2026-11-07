// `trellis export <git url>`, in a Trellis clone: its branches and tags,
// converted to SHA-1 by git's own fast-export and fast-import (the reverse
// of `trellis import`), pushed to any git host: GitHub, say, as a mirror
// while a team moves, so tools that only know SHA-1 keep working. History
// imported from SHA-1 comes back with its old ids, signatures aside (they
// were stripped on import). Marks and the SHA-1 copy are kept in
// $GIT_DIR/trellis/export, so each run converts only what is new. Node only.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { git, requireSha256 } from "./git.mjs";

/** Converts `repo`'s branches and tags into its SHA-1 copy; resolves to the copy's path and refs. */
export function toSha1(repo) {
  requireSha256(repo);
  const gitDir = git(repo, "rev-parse", "--absolute-git-dir");
  const dir = join(gitDir, "trellis", "export");
  const copy = join(dir, "sha1.git");
  const ours = join(dir, "sha256.marks");
  const theirs = join(dir, "sha1.marks");
  mkdirSync(dir, { recursive: true });
  if (!existsSync(copy)) execFileSync("git", ["init", "--quiet", "--bare", "--object-format=sha1", copy]);
  for (const file of [ours, theirs]) if (!existsSync(file)) execFileSync("touch", [file]);
  const strip = /signed-commits/.test(spawnSync("git", ["fast-export", "-h"], { encoding: "utf8" }).stdout) ? "--signed-commits=strip" : "";
  const converted = spawnSync("bash", ["-c",
    'set -o pipefail; git -C "$1" fast-export --branches --tags --reencode=no --signed-tags=strip $6 --mark-tags --import-marks="$2" --export-marks="$2" | git -C "$3" fast-import --quiet --force --import-marks="$4" --export-marks="$4"',
    "export", repo, ours, copy, theirs, strip], { encoding: "utf8" });
  if (converted.status !== 0) {
    // Older git has no --signed-commits; a signed commit then fails the export, saying so.
    throw new Error(`git fast-export | fast-import: ${converted.stderr.trim()}`);
  }
  // Branches and tags deleted here are deleted in the copy too.
  const wanted = new Set(git(repo, "for-each-ref", "--format=%(refname)", "refs/heads", "refs/tags").split("\n").filter(Boolean));
  for (const ref of git(copy, "for-each-ref", "--format=%(refname)", "refs/heads", "refs/tags").split("\n").filter(Boolean)) {
    if (!wanted.has(ref)) execFileSync("git", ["-C", copy, "update-ref", "-d", ref]);
  }
  return { copy, refs: [...wanted] };
}

/** `trellis export <url>`: converts, then pushes every branch and tag there, as they are here. */
export function exportTo(repo, url, { say = () => {} } = {}) {
  const { copy, refs } = toSha1(repo);
  say(`converted ${refs.length} branches and tags to SHA-1; pushing to ${url.replace(/\/\/[^@/]*@/, "//")}`);
  execFileSync("git", ["-C", copy, "push", "--quiet", "--force", "--prune", url, "refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"], { stdio: ["ignore", "inherit", "inherit"] });
  return refs.length;
}
