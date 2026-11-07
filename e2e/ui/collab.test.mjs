// Collaboration in the page (app/) through Selfhold's window, against a
// private stack (../stack.mjs): Bob, who holds no coins, signs in with a
// passkey, forks Carol's repo, opens an issue and a pull request from Dave's
// fork, and comments on a line of its changes; Carol, a maintainer who signs
// with a key file, labels and closes the issue and merges by pushing; the page
// shows each. Every fee is paid by the sponsor for work.
//
//   LATTICE=<lattice-node>/.build/debug/lattice \
//   LATTICE_WALLET_WEB=<selfhold-wallet>/dist-web node --test e2e/ui/collab.test.mjs
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createReadStream, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { after, before, test as nodeTest } from "node:test";
import { chromium, expect as baseExpect } from "@playwright/test";
import * as sdk from "../../vendor/lattice-sdk.js";
import * as collab from "../../client/collab.mjs";
import * as records from "../../client/records.mjs";
import { delegation } from "../../client/team.mjs";
import { sponsored } from "../../client/sponsor.mjs";
import { changes, transaction } from "../../client/write.mjs";
import { CHAIN, account, here, start, state, until } from "../stack.mjs";

const expect = baseExpect.configure({ timeout: 120_000 });
const walletWeb = process.env.LATTICE_WALLET_WEB && resolve(process.env.LATTICE_WALLET_WEB);
if (!walletWeb) throw new Error("LATTICE_WALLET_WEB: Selfhold's window, built (selfhold-wallet's dist-web/)");

const running = await start(29000);
const { authorNode, sponsorURL } = running;

// The page and Selfhold's window, each served from its own port, as static hosts would.
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".wasm": "application/wasm", ".json": "application/json" };
function serve(port, root) {
  return createServer((request, response) => {
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
  }).listen(port, "127.0.0.1");
}
const app = serve(29200, here(".."));
const walletServer = serve(29292, walletWeb);
const walletPage = "http://localhost:29292/";
const walletOrigin = new URL(walletPage).origin;
const appURL = (hash) => `http://localhost:29200/app/?node=${encodeURIComponent(authorNode)}&chain=${CHAIN.join("/")}&sponsor=${encodeURIComponent(sponsorURL)}&wallet=${encodeURIComponent(walletPage)}#${hash}`;

// Accounts that sign with key files: Carol owns the repo, Dave has a fork.
const work = mkdtempSync(join(tmpdir(), "trellis-collab-"));
function keyed(name) {
  const key = sdk.generatePrivateKey();
  const who = sdk.accountFromPrivateKey(key);
  const file = join(work, `${name}.json`);
  writeFileSync(file, JSON.stringify({ address: who.address, privateKey: Buffer.from(key).toString("hex") }));
  return { ...who, privateKey: key, file };
}
const carol = keyed("carol");
const dave = keyed("dave");
const gitEnv = (who) => ({ ...process.env, PATH: `${here("../bin")}:${process.env.PATH}`, TRELLIS_NODE: authorNode, TRELLIS_SPONSOR: sponsorURL, TRELLIS_KEY: who.file, TRELLIS_CHAIN: CHAIN.join("/"), GIT_TERMINAL_PROMPT: "0" });
const git = (who, repo, ...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: gitEnv(who) }).trim();

/** `who` writes records with no coins, as another client would; resolves once they read back. */
async function writeAs(who, writes) {
  await until("a keyed write is accepted", async () => {
    const actions = await changes(await state(authorNode), writes);
    const nonce = BigInt((await account(authorNode, who.address)).nonce ?? 0);
    const payload = await sponsored(sdk, sponsorURL, transaction({ owner: who.address, actions, nonce, chainPath: CHAIN }), who.privateKey);
    return (await fetch(`${authorNode}/transactions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })).ok;
  });
  await until("a keyed write lands", async () => {
    const now = await state(authorNode);
    for (const [key, value] of writes) if ((await now.get(key)) !== value) return false;
    return true;
  });
}

const repo = join(work, "garden");
let ids;
try {
  mkdirSync(join(repo, "src"), { recursive: true });
  git(carol, repo, "init", "-q", "--object-format=sha256", "-b", "main");
  git(carol, repo, "config", "user.name", "Carol");
  git(carol, repo, "config", "user.email", "carol@example.com");
  writeFileSync(join(repo, "README.md"), "# Garden\n");
  writeFileSync(join(repo, "src/main.c"), "int main(void) {\n\treturn 0;\n}\n");
  git(carol, repo, "add", "-A");
  git(carol, repo, "commit", "-q", "-m", "plant the garden");
  git(carol, repo, "tag", "-a", "-m", "first", "v1.0");
  git(carol, repo, "remote", "add", "origin", `trellis::${carol.address}/garden`);
  git(carol, repo, "push", "-q", "origin", "main", "v1.0");
  // Dave clones it, fixes something on a branch, and pushes it to his copy.
  const fork = join(work, "dave-garden");
  execFileSync("git", ["clone", "-q", `trellis::${carol.address}/garden`, fork], { env: gitEnv(dave) });
  git(dave, fork, "config", "user.name", "Dave");
  git(dave, fork, "config", "user.email", "dave@example.com");
  git(dave, fork, "checkout", "-q", "-b", "fix");
  writeFileSync(join(fork, "src/main.c"), "int main(void) {\n\treturn 1;\n}\n");
  git(dave, fork, "commit", "-q", "-am", "return one");
  git(dave, fork, "push", "-q", `trellis::${dave.address}/garden`, "fix");
  ids = { fix: git(dave, fork, "rev-parse", "fix") };
} catch (error) {
  for (const s of [app, walletServer]) s.close();
  running.stop();
  throw error;
}

// Bob: one person, in one browser context, with a passkey in Selfhold's window.
let browser;
let context;
let page;
let walletWindow;
const errors = [];
before(async () => {
  // Selfhold's window does the fee's work on the graphics chip; a machine
  // without one (CI's) gets Chromium's own, SwiftShader, in software.
  const gpuArgs = process.platform === "linux" ? ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan=swiftshader", "--use-webgpu-adapter=swiftshader", "--use-angle=swiftshader"] : [];
  // Pop-ups blocked as for anyone: Selfhold's window opens only from a click.
  browser = await chromium.launch({ args: gpuArgs, ignoreDefaultArgs: ["--disable-popup-blocking"] });
  context = await browser.newContext();
  // Selfhold's window stays open, and every request reuses it, numbered, so
  // the passkey the virtual authenticator holds there is the same each time.
  await context.addInitScript((origin) => {
    if (location.origin === origin) window.close = () => {};
  }, walletOrigin);
  await context.addInitScript(() => {
    if (location.port !== "29200" && location.port !== "29271") return; // the page, and trellis's signing page
    const open = window.open.bind(window);
    window.open = (url, _name, features) => {
      const to = new URL(url);
      const n = Number(sessionStorage.getItem("requests") ?? 0) + 1;
      sessionStorage.setItem("requests", String(n));
      to.searchParams.set("n", String(n));
      return open(to.href, "selfhold-test", features);
    };
  });
  context.on("page", async (popup) => {
    if (!(await popup.opener().catch(() => null))) return;
    if (walletWindow) return console.log(`another popup, not the Selfhold window the test drives: ${popup.url()}`);
    walletWindow = popup;
    const cdp = await context.newCDPSession(popup);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
    });
  });
  page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
});
after(async () => {
  await browser?.close();
  for (const s of [app, walletServer]) s.close();
  running.stop();
});

const test = (name, body) =>
  nodeTest(name, { timeout: 600_000 }, async () => {
    try {
      await body();
      assert.deepEqual(errors, [], "no page errors");
    } catch (error) {
      error.message += `\n--- page at ${page.url()}:\n${(await page.locator("main").innerText().catch(() => "")).slice(0, 1200)}`;
      if (walletWindow) error.message += `\n--- Selfhold's window:\n${(await walletWindow.locator("body").innerText({ timeout: 2000 }).catch(() => "(closed)")).slice(0, 800)}`;
      throw error;
    }
  });

/** Presses `button`, then waits for Selfhold's window to show that request. */
async function inSelfhold(button) {
  const n = Number(await page.evaluate(() => sessionStorage.getItem("requests") ?? 0)) + 1;
  await button.click();
  await until(`Selfhold's window, request ${n}`, async () => walletWindow && new URL(walletWindow.url()).searchParams.get("n") === String(n), 30);
  await walletWindow.bringToFront();
  return walletWindow;
}
const approve = async (button) => {
  const opened = await inSelfhold(button);
  await opened.getByRole("button", { name: "Approve with your passkey" }).click();
  await page.bringToFront();
};
const settled = () => expect(page.locator("main")).not.toHaveAttribute("aria-busy", /.*/);
let bob;
const garden = () => `/${carol.address}/garden`;

test("Bob signs in with a passkey and forks Carol's garden, coinless", async () => {
  await page.goto(appURL(garden()));
  await expect(page.locator(".entry")).toHaveText(["src", "README.md"]);
  const opened = await inSelfhold(page.locator("#who").getByRole("button", { name: "Sign in" }));
  await opened.getByRole("button", { name: "Create an account" }).click();
  await opened.getByRole("button", { name: "Connect", exact: true }).click();
  await page.bringToFront();
  await expect(page.locator("#who .me")).toBeVisible();
  bob = await page.locator("#who .me").getAttribute("title");
  await approve(page.getByRole("button", { name: "Fork" }));
  await expect(page).toHaveURL(new RegExp(`#/${bob}/garden$`), { timeout: 300_000 });
  await expect(page.locator(".fork-of")).toContainText("Forked from");
  await expect(page.locator(".entry")).toHaveText(["src", "README.md"]);
  assert.equal(BigInt((await account(authorNode, bob)).balance ?? 0), 0n, "Bob holds no coins");
});

test("an issue: opened by Bob, labelled and closed by Carol, commented on and reopened", async () => {
  await page.goto(appURL(`${garden()}/issues`));
  await page.getByRole("link", { name: "New issue" }).click();
  await page.getByLabel("Title").fill("Weeds in the beds");
  await page.getByLabel("Description").fill("They are **everywhere**.");
  await approve(page.getByRole("button", { name: "Open the issue" }));
  await expect(page.locator(".issue-head h2")).toContainText("Weeds in the beds", { timeout: 300_000 });
  await expect(page.locator(".comment").first()).toContainText("They are everywhere.");
  await expect(page.locator(".comment strong")).toHaveText("everywhere");
  await expect(page.locator(".issue-head .state")).toHaveText("Open");
  const [, author, id] = /issue\/([^/]+)\/([^/?]+)/.exec(page.url());
  assert.equal(author, bob);

  // Carol, the owner, labels and closes it; Bob sees both.
  await writeAs(carol, collab.triage(carol.address, carol.address, "garden", bob, id, { state: "closed", labels: ["bug", "beds"], time: Math.floor(Date.now() / 1000) }));
  await page.reload();
  await expect(page.locator(".issue-head .state")).toHaveText("Closed");
  await expect(page.locator(".issue-head .label")).toHaveText(["bug", "beds"]);
  await expect(page.locator(".event")).toContainText("closed this");
  // Bob, not a maintainer, can't label it.
  await expect(page.locator(".edit-labels")).toHaveCount(0);

  await page.getByPlaceholder("Leave a comment").fill("Still there this morning.");
  await approve(page.getByRole("button", { name: "Comment", exact: true }));
  await expect(page.locator(".comment").nth(1)).toContainText("Still there this morning.", { timeout: 300_000 });
  await settled();
  await approve(page.getByRole("button", { name: "Reopen" }));
  await expect(page.locator(".issue-head .state")).toHaveText("Open", { timeout: 300_000 });
  await page.goto(appURL(`${garden()}/issues`));
  await expect(page.locator(".issue-row .issue-title")).toHaveText(["Weeds in the beds"]);
  await expect(page.locator(".issue-row .label")).toHaveText(["bug", "beds"]);
});

test("the inbox: Carol hears of Bob's issue and comment; Bob of Carol's reply", async () => {
  const notes = await collab.inbox(await state(authorNode), carol.address);
  assert.deepEqual(notes.map((n) => [n.kind, n.from, n.title]), [["comment", bob, "Weeds in the beds"], ["issue", bob, "Weeds in the beds"]]);
  const id = collab.newId();
  const time = Math.floor(Date.now() / 1000) + 1;
  const post = { on: notes[0].thread, body: "Pulling them today.", time };
  await writeAs(carol, [...collab.post(carol.address, id, post), ...collab.notify(carol.address, [bob, carol.address], time, id, { kind: "comment", repo: notes[0].repo, thread: post.on })]);
  assert.deepEqual((await collab.inbox(await state(authorNode), bob)).map((n) => [n.kind, n.from]), [["comment", carol.address]], "Bob's inbox, as the chain has it");
  const logged = [];
  page.on("console", (m) => logged.push(m.text()));
  await page.goto(appURL("/"));
  try {
    await expect(page.locator("#unread")).toHaveText(" 1");
  } catch (error) {
    error.message += `\n--- console: ${logged.join(" | ")}`;
    throw error;
  }
  await page.getByRole("link", { name: /^Inbox/ }).click();
  await expect(page.locator(".inbox-list li.unread")).toHaveCount(1);
  await expect(page.locator(".inbox-list li")).toContainText(["commented on Weeds in the beds"]);
  await expect(page.locator("#unread")).toHaveText("");
  await page.locator(".inbox-list li a").first().click();
  await expect(page.locator(".comment").last()).toContainText("Pulling them today.");
});

test("a write declined in Selfhold is not sent", async () => {
  await page.goto(appURL(`${garden()}/issues`));
  await page.locator(".issue-title").first().click();
  await page.getByPlaceholder("Leave a comment").fill("Never mind.");
  const opened = await inSelfhold(page.getByRole("button", { name: "Comment", exact: true }));
  await opened.getByRole("button", { name: "Decline" }).click();
  await page.bringToFront();
  await expect(page.locator(".comment-form .status")).toHaveText("You declined it in Selfhold. Nothing was sent.");
  await page.reload();
  await expect(page.locator(".comment")).toHaveCount(3);
});

test("a pull request from Dave's fork: a line reviewed, merged by Carol's push, shown as merged", async () => {
  await page.goto(appURL(`${garden()}/pulls`));
  await page.getByRole("link", { name: "New pull request" }).click();
  await page.getByLabel("Merge").selectOption(`${dave.address}/garden:fix`);
  await page.getByLabel("into").selectOption("main");
  await page.getByLabel("Title").fill("Return one");
  await approve(page.getByRole("button", { name: "Open the pull request" }));
  await expect(page.locator(".issue-head h2")).toContainText("Return one", { timeout: 300_000 });
  await expect(page.locator(".issue-head .state")).toHaveText("Open");
  await expect(page.locator(".issue-head")).toContainText("wants to merge 1 commit into main");

  await page.locator(".tabs.sub").getByRole("link", { name: /Commits/ }).click();
  await expect(page.locator(".commit-row .subject")).toHaveText(["return one"]);
  await expect(page.locator(".commit-row .id")).toHaveText(ids.fix.slice(0, 10));

  // Bob comments on the new line.
  await page.getByRole("link", { name: "Files changed" }).click();
  const added = page.locator('.diff[data-path="src/main.c"] tr.add');
  await expect(added.locator(".src")).toHaveText(["+\treturn 1;"]);
  await added.hover();
  await added.getByRole("button", { name: "Comment on line 2" }).click();
  await page.getByPlaceholder("Comment on line 2").fill("Why one?");
  await approve(page.getByRole("button", { name: "Comment on this line" }));
  await expect(page.locator('.diff[data-path="src/main.c"] tr.inline-comment')).toContainText("Why one?", { timeout: 300_000 });
  await page.getByRole("link", { name: "Conversation" }).click();
  await expect(page.locator(".comment").nth(1)).toContainText("on src/main.c line 2");

  // Not a maintainer, Bob sees no merge button. Carol makes him one; he
  // merges in the page (a fast-forward, his own push); Carol drops him, and
  // main stays where he put it.
  await expect(page.locator('form[data-form="merge"]')).toHaveCount(0);
  await writeAs(carol, records.repo(carol.address, "garden", { delegates: [bob] }));
  await page.reload();
  await approve(page.getByRole("button", { name: "Merge into main" }));
  await expect(page.locator(".issue-head .state")).toHaveText("Merged", { timeout: 300_000 });
  const now = await state(authorNode);
  assert.equal((await records.words(sdk, now, carol.address, "garden")).get("refs/heads/main").by, bob);
  await writeAs(carol, delegation(carol.address, "garden", { delegates: [bob] }, await records.words(sdk, now, carol.address, "garden"), []));
  await page.reload();
  await expect(page.locator(".issue-head .state")).toHaveText("Merged");
  await expect(page.locator(".event.merged")).toBeVisible();
  await page.goto(appURL(`${garden()}/pulls`));
  await expect(page.locator(".seg")).toContainText("0 open");
  await page.getByRole("link", { name: "1 closed or merged" }).click();
  await expect(page.locator(".issue-row .state")).toHaveText(["Merged"]);
});

test("releases: Carol's shown on her tags; Bob writes one on his fork", async () => {
  await writeAs(carol, collab.release(carol.address, "garden", "v1.0", { title: "First harvest", notes: "Carrots and *beans*.", time: Math.floor(Date.now() / 1000) }));
  await page.goto(appURL(`${garden()}/tags`));
  await page.reload();
  await expect(page.locator(".release h3")).toHaveText("First harvest");
  await expect(page.locator(".release em")).toHaveText("beans");
  await expect(page.locator(".write-release")).toHaveCount(0);
  await page.goto(appURL(`/${bob}/garden/tags`));
  await page.locator(".write-release summary").click();
  await page.locator(".write-release").getByLabel("Notes").fill("My own harvest.");
  await page.locator(".write-release").getByLabel("Files").setInputFiles({ name: "seeds.txt", mimeType: "text/plain", buffer: Buffer.from("carrot, bean\n") });
  await approve(page.getByRole("button", { name: "Save the release" }));
  await expect(page.locator(".release")).toContainText("My own harvest.", { timeout: 300_000 });
  await expect(page.locator(".release .assets a")).toHaveText(["seeds.txt"]);
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator(".release .assets a").click()]);
  assert.equal(download.suggestedFilename(), "seeds.txt");
  assert.equal(readFileSync(await download.path(), "utf8"), "carrot, bean\n");
  assert.equal(BigInt((await account(authorNode, bob)).balance ?? 0), 0n, "Bob still holds no coins");
});

test("Bob pushes from the command line with Selfhold: one account in git and the page", async () => {
  const home = mkdtempSync(join(tmpdir(), "trellis-home-"));
  const env = { ...process.env, HOME: home, PATH: `${here("../bin")}:${process.env.PATH}`, TRELLIS_NODE: authorNode, TRELLIS_SPONSOR: sponsorURL, TRELLIS_CHAIN: CHAIN.join("/"), TRELLIS_WALLET: walletPage, TRELLIS_NO_BROWSER: "1", TRELLIS_SIGN_PORT: "29271", GIT_TERMINAL_PROMPT: "0" };
  // trellis's signing page, opened as localhost (the page's own site), so
  // Selfhold's one window, and its passkey, serve it too.
  const sameSite = (url) => url.replace("://127.0.0.1:", "://localhost:");
  // Each step named, and given at most `seconds`, so a hang says where.
  const step = async (what, promise, seconds = 120, more = () => "") => {
    console.log(`cli: ${what}`);
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`cli: ${what}: no end in ${seconds} s${more()}`)), seconds * 1000)))]);
    } finally {
      clearTimeout(timer);
    }
  };
  // A command that stops to ask Selfhold: the URL it prints, and its end.
  const cli = (command, args, cwd = home) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    const url = new Promise((resolve) => child.stderr.on("data", (d) => {
      err += d;
      const found = /approve in Selfhold: (http:\/\/\S+)/.exec(err);
      if (found) resolve(found[1]);
    }));
    const done = new Promise((resolve, reject) => child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`${command} ${args.join(" ")} exited ${code}: ${err}`)))));
    return { url, done, said: () => `\n--- its stderr: ${err}\n--- its stdout: ${out}`, stop: () => child.kill() };
  };
  const login = cli(here("../bin/trellis"), ["login"]);
  try {
    await page.goto(sameSite(await step("trellis login prints its URL", login.url, 60, login.said)));
    const opened = await step("Selfhold's window opens for the login", inSelfhold(page.getByRole("button", { name: "Approve in Selfhold" })), 60);
    await opened.getByRole("button", { name: "Connect", exact: true }).click();
    await page.bringToFront();
    assert.match(await step("trellis login ends", login.done, 60, login.said), new RegExp(`signed in as ${bob}`));
  } finally {
    login.stop();
  }

  const clone = join(home, "garden");
  execFileSync("git", ["clone", "-q", `trellis::${bob}/garden`, clone], { env, timeout: 300_000 });
  execFileSync("git", ["-C", clone, "-c", "user.name=Bob", "-c", "user.email=bob@example.com", "commit", "-q", "--allow-empty", "-m", "from Bob's terminal"], { env });
  const push = cli("git", ["-C", clone, "push", "-q", "origin", "main"]);
  try {
    await page.goto(sameSite(await step("git push prints its URL", push.url, 120, push.said)));
    await step("Selfhold approves the push", approve(page.getByRole("button", { name: "Approve in Selfhold" })), 60);
    await step("git push ends", push.done, 400, push.said);
  } finally {
    push.stop();
  }
  const head = execFileSync("git", ["-C", clone, "rev-parse", "main"], { encoding: "utf8" }).trim();
  await page.goto(appURL(`/${bob}/garden/commits/main`));
  await expect(page.locator(".commit-row .subject").first()).toHaveText("from Bob's terminal", { timeout: 120_000 });
  await expect(page.locator(".commit-row .id").first()).toHaveText(head.slice(0, 10));
  assert.equal(BigInt((await account(authorNode, bob)).balance ?? 0), 0n, "Bob still holds no coins");
});
