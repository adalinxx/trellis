// The web viewer (app/) in headless Chromium, against a private stack
// (../stack.mjs): a repo pushed by stock git, coinless, then browsed from the
// host's public reads. Run with node --test; see README.
//
//   LATTICE=<lattice-node>/.build/debug/lattice node --test e2e/ui/
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createReadStream, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { after, before, test as nodeTest } from "node:test";
import { chromium, expect as baseExpect } from "@playwright/test";
import * as sdk from "../../vendor/lattice-sdk.js";
import { CHAIN, here, start } from "../stack.mjs";

const expect = baseExpect.configure({ timeout: 60_000 });
const running = await start(28000);
const { authorNode, sponsorURL } = running;

// The page, served from the repository root as any static host would.
const root = here("..");
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
const server = createServer((request, response) => {
  const path = normalize(decodeURIComponent(new URL(request.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(root, path);
  try {
    if (statSync(file).isDirectory()) file = join(file, "index.html");
    statSync(file);
  } catch {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(response);
}).listen(28200, "127.0.0.1");
const appURL = (hash = "", node = authorNode) => `http://127.0.0.1:28200/app/?node=${encodeURIComponent(node)}&chain=${CHAIN.join("/")}#${hash}`;

// Carol's repo, pushed through git-remote-trellis with no coins.
const work = mkdtempSync(join(tmpdir(), "trellis-ui-"));
const key = sdk.generatePrivateKey();
const carol = sdk.accountFromPrivateKey(key);
const keyFile = join(work, "carol.json");
writeFileSync(keyFile, JSON.stringify({ address: carol.address, privateKey: Buffer.from(key).toString("hex") }));
const env = { ...process.env, PATH: `${here("../bin")}:${process.env.PATH}`, TRELLIS_NODE: authorNode, TRELLIS_SPONSOR: sponsorURL, TRELLIS_KEY: keyFile, TRELLIS_CHAIN: CHAIN.join("/"), GIT_TERMINAL_PROMPT: "0" };
const repo = join(work, "garden");
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env }).trim();
mkdirSync(join(repo, "src"), { recursive: true });
git("init", "-q", "--object-format=sha256", "-b", "main");
git("config", "user.name", "Carol");
git("config", "user.email", "carol@example.com");
// A 1x1 PNG.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
writeFileSync(join(repo, "logo.png"), png);
writeFileSync(join(repo, "README.md"), [
  "# Garden", "", "Plants and **paths**.", "", "![logo](logo.png)", "",
  "[the code](src/main.c) · [bad](javascript:alert(1)) · [site](https://example.com)", "",
  "<script>window.hacked = true</script>", "",
].join("\n"));
writeFileSync(join(repo, "src/main.c"), "int main(void) {\n\treturn 0;\n}\n");
// Over the size the page reads without asking, and chunked.
const big = Buffer.alloc(2.5 * (1 << 20));
for (let i = 0; i < big.length; i++) big[i] = (Math.imul(i, 2654435761) >>> 24) | 1;
big[0] = 0;
writeFileSync(join(repo, "seeds.bin"), big);
git("add", "-A");
git("commit", "-q", "-m", "plant the garden");
writeFileSync(join(repo, "src/main.c"), "int main(void) {\n\treturn 1;\n}\n");
writeFileSync(join(repo, "src/water.c"), "void water(void) {}\n");
git("add", "-A");
git("commit", "-q", "-m", "water it\n\nAnd return one.");
git("tag", "-a", "-m", "first harvest", "v1.0");
git("checkout", "-q", "-b", "feature/shade");
writeFileSync(join(repo, "shade.txt"), "a tree\n");
git("add", "-A");
git("commit", "-q", "-m", "shade");
git("checkout", "-q", "main");
git("remote", "add", "origin", `trellis::${carol.address}/garden`);
try {
  git("push", "-q", "origin", "main", "feature/shade", "v1.0");
} catch (error) {
  server.close();
  running.stop();
  throw error;
}
const ids = { first: git("rev-parse", "main~1"), second: git("rev-parse", "main") };
const garden = `/${carol.address}/garden`;

let browser;
before(async () => (browser = await chromium.launch()));
after(async () => {
  await browser?.close();
  server.close();
  running.stop();
});

/** A test with a fresh page; what it fetched from the node is in `fetched`. */
const test = (name, body) =>
  nodeTest(name, { timeout: 300_000 }, async () => {
    const page = await browser.newPage();
    const errors = [];
    const fetched = { bytes: 0, requests: 0 };
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", async (response) => {
      if (!response.url().includes("/volumes")) return;
      fetched.requests++;
      fetched.bytes += (await response.body().catch(() => Buffer.alloc(0))).length;
    });
    try {
      await body({ page, fetched });
      assert.deepEqual(errors, [], "no page errors");
    } catch (error) {
      error.message += `\n--- page at ${page.url()}:\n${(await page.locator("main").innerText().catch(() => "")).slice(0, 1000)}`;
      throw error;
    } finally {
      await page.close();
    }
  });
const settled = (page) => expect(page.locator("main")).not.toHaveAttribute("aria-busy", /.*/);

test("the list of repositories names Carol's garden", async ({ page }) => {
  await page.goto(appURL("/"));
  await expect(page.locator(".repo-row", { hasText: "garden" })).toBeVisible();
  await page.locator(".repo-row a", { hasText: "garden" }).click();
  await expect(page.locator(".entry")).toHaveText(["src", "README.md", "logo.png", "seeds.bin"]);
});

test("a repo: its files, latest commit and README, without reading the large file", async ({ page, fetched }) => {
  await page.goto(appURL(garden));
  await expect(page.locator(".readme h1")).toHaveText("Garden");
  await settled(page);
  await expect(page.locator(".latest")).toContainText("water it");
  await expect(page.locator(".latest")).toContainText(ids.second.slice(0, 10));
  // The image beside the README, read from the repo; links only where safe.
  await expect.poll(() => page.locator(".readme img").evaluate((img) => img.naturalWidth)).toBe(1);
  await expect(page.locator(".readme a", { hasText: "the code" })).toHaveAttribute("href", `#${garden}/blob/main/src/main.c`);
  await expect(page.locator(".readme a", { hasText: "bad" })).toHaveCount(0);
  await expect(page.locator(".readme a", { hasText: "site" })).toHaveAttribute("rel", /noopener/);
  await expect(page.locator(".readme script")).toHaveCount(0);
  assert.equal(await page.evaluate(() => window.hacked), undefined);
  assert.ok(fetched.bytes < 1 << 20, `read ${fetched.bytes} bytes; the 2.5 MiB file is not among them`);
  // The clone command names the repo.
  await page.locator("details.clone summary").click();
  await expect(page.locator("details.clone pre").first()).toHaveText(`git clone trellis::${carol.address}/garden`);
});

test("a file: its lines; a large file only when asked", async ({ page, fetched }) => {
  await page.goto(appURL(`${garden}/tree/main/src`));
  await page.locator(".entry a", { hasText: "main.c" }).click();
  await expect(page.locator(".crumbs")).toHaveText(/garden\s*\/\s*src\s*\/\s*main\.c/);
  await expect(page.locator(".code .src")).toHaveText(["int main(void) {", "\treturn 1;", "}"]);
  await page.goto(appURL(`${garden}/blob/main/seeds.bin`));
  await expect(page.locator(".panel")).toContainText("isn't read until you ask");
  await settled(page);
  assert.ok(fetched.bytes < 1 << 20, `read ${fetched.bytes} bytes before asking`);
  const asked = fetched.bytes;
  await page.getByRole("link", { name: "Show it anyway" }).click();
  await expect(page.locator(".empty")).toHaveText("A binary file.");
  await expect.poll(() => fetched.bytes, { message: "then all of it" }).toBeGreaterThan(asked + (1 << 20));
});

test("history, a commit's changes, branches and tags", async ({ page }) => {
  await page.goto(appURL(`${garden}/commits/main`));
  await expect(page.locator(".commit-row .subject")).toHaveText(["water it", "plant the garden"]);
  await page.locator(".commit-row .subject", { hasText: "water it" }).click();
  await expect(page.locator(".commit h2")).toHaveText("water it");
  await expect(page.locator(".commit .message")).toHaveText("And return one.");
  await expect(page.locator(".commit")).toContainText(ids.second);
  await expect(page.locator(".summary")).toContainText("2 files changed");
  const main = page.locator('.diff[data-path="src/main.c"]');
  await expect(main.locator("tr.del .src")).toHaveText(["-\treturn 0;"]);
  await expect(main.locator("tr.add .src")).toHaveText(["+\treturn 1;"]);
  await expect(page.locator('.diff[data-path="src/water.c"] .badge')).toHaveText("added");
  // Its parent, the first commit: everything added.
  await page.locator(".kv a.mono").click();
  await expect(page.locator(".commit")).toContainText(ids.first);
  await expect(page.locator(".summary")).toContainText("4 files changed (the first commit)");
  await expect(page.locator('.diff[data-path="seeds.bin"] .note')).toHaveText("Binary or large: not shown.");

  await page.goto(appURL(`${garden}/branches`));
  await expect(page.locator(".ref-name")).toHaveText(["feature/shade", "main"]);
  await page.goto(appURL(`${garden}/tags`));
  await expect(page.locator(".ref-name")).toHaveText(["v1.0"]);
  await expect(page.locator(".ref-row")).toContainText("first harvest");
  // A branch with a slash in its name, from the picker.
  await page.goto(appURL(garden));
  await page.locator("#ref").selectOption("feature/shade");
  await expect(page.locator(".entry", { hasText: "shade.txt" })).toBeVisible();
});

test("a node that can't serve the chain is said so, with a way out", async ({ page }) => {
  await page.goto(appURL("/", "http://127.0.0.1:1"));
  await expect(page.locator(".panel.bad h2")).toHaveText("This page couldn't be read");
  await page.getByRole("link", { name: "Choose another node" }).click();
  await expect(page.locator("#node")).toHaveValue("http://127.0.0.1:1");
});
