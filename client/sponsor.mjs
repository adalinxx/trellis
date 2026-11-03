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

const volumeBytes = (volume) => Object.values(volume.entries).reduce((n, b64) => n + Math.ceil((b64.length * 3) / 4), 0);

/**
 * Has `sponsor` keep `volumes` for good, paid with work on `chain`, in
 * uploads of about `batchBytes`. Resolves once every one is pinned.
 * `progress({ stored, total })` after each upload.
 */
export async function keep(sdk, sponsor, chain, volumes, { batchBytes = 16 << 20, signal, progress = () => {}, pinWait = 120_000 } = {}) {
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
  for (let { volumes: batch } of batches) {
    while (batch.length > 0) {
      const root = batch[0].cid;
      let status;
      try {
        status = await client.store(root, batch, signal);
      } catch (error) {
        if (!/already uploaded/.test(error?.refusal ?? "")) throw error;
        // Someone uploaded this one before (the same file, the same tree):
        // see it kept, and send the rest under another root.
        status = await client.storeStatus(root, signal);
        await pay(root, status);
        batch = batch.slice(1);
        stored += 1;
        continue;
      }
      await pay(root, status);
      stored += batch.length;
      batch = [];
    }
    progress({ stored, total: volumes.length });
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
        status = await client.storeStatus(root, signal);
        return status.stored || status.credit >= status.bytes;
      }, signal);
    }
    const deadline = Date.now() + pinWait;
    while (!status.stored) {
      if (Date.now() > deadline) throw new Error(`the sponsor was paid for ${root} but hasn't kept it`);
      await pause(1000);
      status = await client.storeStatus(root, signal);
    }
  }
}
