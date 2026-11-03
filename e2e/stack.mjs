// A private Lattice stack for Trellis's tests: a host mining Nexus and
// Nexus/trellis (chain/trellis_policy.wasm, a fast test spec, a fee of 1 as
// on testnet) and a sponsor (lattice-sponsor) that pays fees and keeps files
// for work, its coins funded by the miner.
//
//   LATTICE=<lattice-node>/.build/debug/lattice
//   LATTICE_SPONSOR=<lattice-sponsor>/.build/debug/lattice-sponsor (default: beside lattice)
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as sdk from "../vendor/lattice-sdk.js";
import { tip, view, volumeLoader } from "../client/state.mjs";

export const here = (path) => fileURLToPath(new URL(path, import.meta.url));
export const CHAIN = ["Nexus", "trellis"];
export const LATTICE = process.env.LATTICE;
const LATTICE_SPONSOR = process.env.LATTICE_SPONSOR || join(dirname(LATTICE ?? "."), "lattice-sponsor");

/** A node's root directory and its `lattice` command. */
export const host = (root) => ({
  root,
  lattice: (...args) => execFileSync(LATTICE, [...args, "--root", root], { encoding: "utf8" }),
  configure(edit) {
    const file = `${root}/lattice.json`;
    const topology = JSON.parse(readFileSync(file, "utf8"));
    edit(topology);
    writeFileSync(file, JSON.stringify(topology, null, 2));
  },
  cookie: () => readFileSync(`${root}/chains/Nexus/.cookie`, "utf8"),
});

export async function until(label, condition, seconds = Number(process.env.E2E_SECONDS ?? 300)) {
  const deadline = Date.now() + seconds * 1000;
  let failure;
  for (;;) {
    const value = await condition().catch((error) => void (failure = error));
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`, { cause: failure });
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export async function account(at, address) {
  const response = await fetch(`${at}/api/state/account/${address}?chainPath=${CHAIN.join("/")}`);
  return response.ok ? response.json() : {};
}

/** The chain's state at a node's tip, as a view. */
export async function state(at) {
  const volumes = new sdk.VolumeClient(new sdk.HTTPVolumeTransport(`${at}/volumes`, { chainPath: CHAIN }));
  const { generalStateCID } = await tip(sdk, at, CHAIN, volumes);
  return view(volumeLoader(volumes, sdk.decodeDagCbor), generalStateCID);
}

/** Relaxed public-read limits, for a test's many reads. */
export function openReads(t) {
  t.publicReadExpensiveRate = 10000;
  t.publicReadRate = 10000;
  t.publicReadMaxRate = 100000;
}

/**
 * Starts the host and the sponsor on ports from `base` (listen base+1, RPC
 * base+80, public reads base+81, sponsor base+95). Resolves to
 * `{ authors, ports, authorNode, sponsorURL, stop }`.
 */
export async function start(base = 27000, { log = console.log } = {}) {
  const ports = { listen: base + 1, rpc: base + 80, publicRead: base + 81 };
  const authorNode = `http://127.0.0.1:${ports.publicRead}`;
  const sponsorURL = `http://127.0.0.1:${base + 95}`;
  const authors = host(mkdtempSync(`${tmpdir()}/trellis-e2e-`));
  let sponsor;
  const stop = () => {
    sponsor?.kill();
    try { authors.lattice("mine", "stop"); } catch {}
    try { authors.lattice("down"); } catch {}
  };
  try {
    const minerKey = sdk.generatePrivateKey();
    const miner = sdk.accountFromPrivateKey(minerKey);
    authors.lattice("init");
    authors.configure((t) => {
      Object.assign(t, { ...ports, webSocket: 0, publicSubmit: true, minRelayFee: 1 });
      openReads(t);
      t.peers = [];
      t.mine = { worker: "cpu", workers: 1, batchSize: 100000 };
    });
    authors.lattice("up");
    authors.lattice("child", "create", CHAIN.join("/"), "--spec", here("./spec.json"), "--policy-module", here("../chain/trellis_policy.wasm"));
    authors.configure((t) => (t.mine.recipients = { [CHAIN.join("/")]: miner.address }));
    authors.lattice("mine", "start");
    await until("Nexus/trellis pays the miner", async () => BigInt((await account(authorNode, miner.address)).balance ?? 0) > 1000n);
    log("Nexus/trellis is mined");

    const sponsorKey = `${authors.root}/sponsor-key.json`;
    execFileSync(LATTICE, ["key", "generate", "--out", sponsorKey]);
    const sponsorAddress = JSON.parse(readFileSync(sponsorKey, "utf8")).address;
    const nonce = BigInt((await account(authorNode, miner.address)).nonce ?? 0);
    const body = sdk.buildTransfer({ from: miner.address, to: sponsorAddress, amount: 500n, fee: 1n, nonce, chainPath: CHAIN });
    const { publicKey, signature } = sdk.signTransactionBody(body, minerKey);
    const funded = await fetch(`${authorNode}/transactions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sdk.transactionPayload({ [publicKey]: signature }, body)) });
    assert.ok(funded.ok, `fund the sponsor: ${funded.status} ${await funded.text()}`);
    await until("the sponsor is funded", async () => BigInt((await account(authorNode, sponsorAddress)).balance ?? 0) >= 500n);
    const out = openSync(`${authors.root}/sponsor.log`, "a");
    sponsor = spawn(LATTICE_SPONSOR, [
      "--node", `http://127.0.0.1:${ports.rpc}`, "--cookie-file", `${authors.root}/chains/Nexus/.cookie`, "--key", sponsorKey,
      "--share-work", "2^12", "--fee", "1", "--most-pay", "0", "--port", String(base + 95),
      "--sell-storage", "--storage-rate", `${CHAIN.join("/")}=1000000`, "--storage-file", `${authors.root}/sponsor-storage.json`,
    ], { stdio: ["ignore", out, out] });
    await until("the sponsor takes work on Nexus/trellis", async () =>
      (await fetch(`${sponsorURL}/work`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chain: CHAIN.join("/") }) })).ok, 180);
    log("the sponsor takes work");
  } catch (error) {
    stop();
    throw error;
  }
  return { authors, ports, authorNode, sponsorURL, stop };
}
