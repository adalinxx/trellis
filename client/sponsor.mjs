// No coins needed: a sponsor (0xLattice/lattice-sponsor) pays each write's
// fee and keeps each push's objects for good, both for this machine's work on
// its mining template. The sponsor is trusted only to keep what it was paid
// for; every block is checked against its CID by whoever reads it, and every
// write is signed by its author. Browser-safe (the SDK's grind is plain
// JavaScript; a page may grind on its GPU instead).

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Work from `client`, under `token` if it has one. A sponsor that no longer
 * knows the token (it restarted) gets a request without one. Undefined when
 * it is busy: try again in a moment.
 */
async function requestWork(client, token, request, signal) {
  try {
    return await client.requestWork({ ...(token && { client: token }), ...request }, signal);
  } catch (error) {
    if (error?.status === 503) return undefined;
    if (token && /unknown client token/.test(error?.refusal ?? error?.message ?? "")) return requestWork(client, undefined, request, signal);
    throw error;
  }
}

/** Grinds `work`, posting each share, until `paid(credit)` or the range ends. */
async function earn(sdk, client, work, paid, signal) {
  for await (const nonce of sdk.grind(work, signal)) {
    let credit;
    try {
      ({ credit } = await client.submitShare(work.assignment, nonce, signal));
    } catch (error) {
      if (/duplicateShare|missesShareTarget/.test(error?.refusal ?? "")) continue;
      return false; // expired, or the block it was for is gone: new work
    }
    if (await paid(credit)) return true;
  }
  return false;
}

/**
 * `draft` (one signer, no fee) with its fee paid by `sponsor` for work, signed
 * with `privateKey`: the payload `POST /transactions` takes.
 */
export async function sponsored(sdk, sponsor, draft, privateKey, { signal } = {}) {
  const client = new sdk.SponsorClient(sponsor);
  const chain = draft.chainPath.join("/");
  let token;
  for (;;) {
    const work = await requestWork(client, token, { chain }, signal);
    if (!work) {
      await pause(2000); // busy: a block from now it has work again
      continue;
    }
    token = work.client;
    if (await earn(sdk, client, work, (credit) => credit >= work.fee, signal)) break;
  }
  const { body, signatures } = await client.sponsorTransaction(token, draft, 0n, signal);
  const { publicKey, signature } = sdk.signTransactionBody(body, privateKey);
  return sdk.transactionPayload({ ...signatures, [publicKey]: signature }, body);
}

/**
 * The chain whose work pays `sponsor` for storage: `preferred` if it sets a
 * rate there, else any chain it does (work is work), else null. From the
 * sponsor's `GET /terms`.
 */
export async function storageChain(sponsor, preferred) {
  try {
    const response = await fetch(`${sponsor.replace(/\/+$/, "")}/terms`, { signal: AbortSignal.timeout(15_000) });
    const rates = Object.entries((await response.json())?.storageRates ?? {}).filter(([, rate]) => Number(rate) > 0).map(([chain]) => chain);
    return rates.includes(preferred) ? preferred : (rates[0] ?? null);
  } catch {
    return null;
  }
}

/** A Volume's share of an upload's body: its base64 entries. */
const volumeBytes = (volume) => Object.values(volume.entries).reduce((n, b64) => n + b64.length, 0);

/**
 * Has `sponsor` keep `volumes` for good, paid with work on `chain`, in
 * uploads of at most about `batchBytes` of body. Resolves once every one is
 * pinned. `progress({ stored, total })` after each upload.
 *
 * A sponsor (or the proxy in front of it) sets its own limits: an upload it
 * finds too large (413, or the connection cut) is sent again in halves, and
 * one sent too soon (429) again a little later.
 */
export async function keep(sdk, sponsor, chain, volumes, { batchBytes = 1536 << 10, signal, progress = () => {}, pinWait = 120_000 } = {}) {
  const client = new sdk.SponsorClient(sponsor);
  const batches = [];
  for (const volume of volumes) {
    const last = batches.at(-1);
    if (last && last.bytes + volumeBytes(volume) <= batchBytes) {
      last.volumes.push(volume);
      last.bytes += volumeBytes(volume);
    } else batches.push({ volumes: [volume], bytes: volumeBytes(volume) });
  }
  let stored = 0;
  let token;
  const queue = batches.map((b) => b.volumes);
  for (let wait = 1000; queue.length > 0; ) {
    const batch = queue.shift();
    const root = batch[0].cid;
    let status;
    try {
      status = await client.store(root, batch, signal);
      wait = 1000;
    } catch (error) {
      if (/already uploaded/.test(error?.refusal ?? "")) {
        // Someone uploaded this one before (the same file, the same tree):
        // see it kept, and send the rest under another root.
        await pay(root, await statusOf(root));
        stored += 1;
        if (batch.length > 1) queue.unshift(batch.slice(1));
        continue;
      }
      const tooLarge = error?.status === 413 || (error?.status === undefined && error instanceof TypeError); // fetch failed: cut off
      if (tooLarge && batch.length > 1) {
        const half = Math.ceil(batch.length / 2);
        queue.unshift(batch.slice(0, half), batch.slice(half));
        continue;
      }
      if (error?.status === 429 || error?.status === 503) {
        queue.unshift(batch);
        await pause(wait);
        wait = Math.min(wait * 2, 30_000);
        continue;
      }
      throw error;
    }
    await pay(root, status);
    stored += batch.length;
    progress({ stored, total: volumes.length });
  }

  /** Where an upload stands, asked again while the sponsor says "slow down". */
  async function statusOf(root) {
    for (let wait = 1000; ; wait = Math.min(wait * 2, 30_000)) {
      try {
        return await client.storeStatus(root, signal);
      } catch (error) {
        if (error?.status !== 429 && error?.status !== 503) throw error;
        await pause(wait);
      }
    }
  }

  async function pay(root, status) {
    while (!status.stored && status.credit < status.bytes) {
      const work = await requestWork(client, token, { chain, store: root }, signal);
      if (!work) {
        await pause(2000);
        continue;
      }
      token = work.client;
      await earn(sdk, client, work, async () => {
        status = await statusOf(root);
        return status.stored || status.credit >= status.bytes;
      }, signal);
    }
    const deadline = Date.now() + pinWait;
    while (!status.stored) {
      if (Date.now() > deadline) throw new Error(`the sponsor was paid for ${root} but hasn't kept it`);
      await pause(1000);
      status = await statusOf(root);
    }
  }
}
