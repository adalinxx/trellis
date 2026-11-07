// Signing from the command line with Selfhold, the account the page signs
// with, instead of a key file: a page on 127.0.0.1 asks Selfhold's window to
// approve, as `gh auth login --web` opens a browser. Set trellis.key to
// `selfhold` and run `trellis login` once; the account's address is kept in
// trellis.account (git config --global). Node only.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const WALLET = "https://wallet.selfhold.app/";
const client = new URL("../app/vendor/selfhold.mjs", import.meta.url);

const page = (title) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Trellis: ${title}</title><style>
:root { color-scheme: light dark; --bg: #fbfaf7; --fg: #1d2421; --muted: #5e6a65; --accent: #2f7d6d; --on-accent: #fff; }
@media (prefers-color-scheme: dark) { :root { --bg: #121614; --fg: #e5ebe8; --muted: #9aa6a1; --accent: #5fb8a3; --on-accent: #0b1714; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; }
main { max-width: 34rem; padding: 24px 16px; } h1 { font-size: 1.3rem; } p { color: var(--muted); }
pre { white-space: pre-wrap; font-size: 13px; } button { font: inherit; padding: 10px 18px; border-radius: 8px; border: 0; background: var(--accent); color: var(--on-accent); cursor: pointer; }
</style></head><body><main><h1>${title}</h1><p id="what"></p><pre id="detail"></pre><button id="go">Approve in Selfhold</button><p id="status" role="status"></p></main>
<script type="module">
import { selfhold } from "./selfhold.mjs";
const task = await (await fetch("./task")).json();
const say = (text) => (document.getElementById("status").textContent = text);
document.getElementById("what").textContent = task.what;
document.getElementById("detail").textContent = task.detail ?? "";
const wallet = selfhold({ use: "window", wallet: task.wallet, hosts: () => task.hosts, sponsor: () => task.sponsor || undefined });
const done = (body) => fetch("./done", { method: "POST", body: JSON.stringify(body) });
document.getElementById("go").onclick = async (event) => {
  event.target.disabled = true;
  try {
    if (!task.request) {
      await done({ address: await wallet.connect() });
    } else {
      // Connected once, this page's origin (one fixed port) stays connected.
      const account = (await wallet.address().catch(() => null)) ?? (await wallet.connect());
      if (account !== task.account) throw new Error("Selfhold is signed in as " + account + ", not " + task.account + ": switch accounts there, or run trellis login again");
      const sent = await wallet.writeRecords(task.request, { account, progress: (text) => say(text) });
      await done({ sent: Boolean(sent) });
    }
    say("Done. You can close this tab and go back to the terminal.");
  } catch (error) {
    await done({ error: String(error?.message ?? error) });
    say(String(error?.message ?? error));
    event.target.disabled = false;
  }
};
</script></body></html>`;

/**
 * Opens the browser on a page that asks Selfhold to do `task` (`{ title,
 * what, detail?, request?, account?, hosts, sponsor? }`; no `request`: sign
 * in), and resolves to what the page reported: `{ address }` or `{ sent }`.
 */
export function inSelfhold(task, { say = () => {}, wallet = process.env.TRELLIS_WALLET ?? WALLET, open = openBrowser } = {}) {
  const token = randomBytes(16).toString("hex");
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const [, at, path] = /^\/([0-9a-f]+)\/(.*)$/.exec(req.url ?? "") ?? [];
      if (at !== token) return res.writeHead(404).end();
      if (req.method === "GET" && path === "") return res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(page(task.title));
      if (req.method === "GET" && path === "selfhold.mjs") return res.writeHead(200, { "Content-Type": "text/javascript" }).end(readFileSync(client));
      if (req.method === "GET" && path === "task") return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ...task, wallet }));
      if (req.method === "POST" && path === "done") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          res.writeHead(204).end();
          let answer;
          try {
            answer = JSON.parse(body);
          } catch {
            return;
          }
          if (answer.error) return say(`Selfhold: ${answer.error}`);
          server.close();
          resolve(answer);
        });
        return;
      }
      res.writeHead(404).end();
    });
    // One port, so Selfhold knows this page as one site and asks to connect only once.
    const port = Number(process.env.TRELLIS_SIGN_PORT ?? 47471);
    server.once("error", (error) => (error.code === "EADDRINUSE" ? reject(new Error(`port ${port} is taken (another trellis waiting for Selfhold?); set TRELLIS_SIGN_PORT`)) : reject(error)));
    server.listen(port, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${server.address().port}/${token}/`;
      say(`approve in Selfhold: ${url}`);
      open(url);
    });
  });
}

function openBrowser(url) {
  if (process.env.TRELLIS_NO_BROWSER) return;
  const [command, ...args] = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  execFile(command, args, () => {});
}
