// Nothing in the repository names the machine it was built on or the person
// at it: no home path, user name, full name, or the identity git would use.
// They are worked out here, at test time, and never printed, so the test
// itself can't leak them either. Covers every file git would commit, the
// built policy module, and every commit's author and committer.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const quiet = (command, args, options = {}) => {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], ...options }).trim();
  } catch {
    return "";
  }
};

/** What would identify this machine's user, each at least 4 characters. */
function identifying() {
  const found = new Set([homedir(), userInfo().username]);
  // The full name: macOS, then the passwd entry's GECOS field.
  found.add(quiet("id", ["-F"]));
  found.add(quiet("getent", ["passwd", userInfo().username]).split(":")[4]?.split(",")[0] ?? "");
  // The identity git falls back to outside this repository (global config, or the account's name).
  const ident = quiet("git", ["var", "GIT_COMMITTER_IDENT"], { cwd: mkdtempSync(join(tmpdir(), "ident-")) });
  const match = ident.match(/^(.*) <(.*)> /);
  if (match) {
    found.add(match[1]);
    found.add(match[2]);
  }
  return [...found].filter((value) => value && value.length >= 4).map((value) => value.toLowerCase());
}

// On a CI runner the machine's user is the runner's, which names no one (and
// "runner" is in the workflow). The pre-commit hook runs this where it counts.
const ci = process.env.GITHUB_ACTIONS === "true" ? "a CI runner's identity names no one" : false;
const tokens = ci ? [] : identifying();
const leaks = (text) => tokens.some((token) => text.toLowerCase().includes(token));

test("no file names this machine or its user", { skip: ci }, () => {
  const files = quiet("git", ["-C", repo, "ls-files", "--cached", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
  const built = "policy/target/wasm32-unknown-unknown/release/trellis_policy.wasm";
  if (existsSync(join(repo, built))) files.push(built);
  const named = files.filter((file) => existsSync(join(repo, file)) && leaks(readFileSync(join(repo, file)).toString("latin1")));
  assert.deepEqual(named, [], "these files name this machine or its user");
});

test("no commit names this machine's user", { skip: ci }, () => {
  const people = quiet("git", ["-C", repo, "log", "--all", "--format=%an <%ae>%n%cn <%ce>"]);
  assert.ok(!leaks(people), "a commit's author or committer names this machine's user");
});

test("the committed policy module is the one the policy builds to", () => {
  const built = join(repo, "policy/target/wasm32-unknown-unknown/release/trellis_policy.wasm");
  if (!existsSync(built)) return;
  assert.ok(readFileSync(built).equals(readFileSync(join(repo, "chain/trellis_policy.wasm"))));
});
