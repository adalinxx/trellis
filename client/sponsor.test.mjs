import assert from "node:assert/strict";
import { test } from "node:test";
import { keep } from "./sponsor.mjs";

// A sponsor that has forgotten every token it issued (a restart, or one that
// can't read its own tokens back): work requested with one is refused.
function forgetfulSponsor() {
  const credit = new Map();
  const requests = [];
  class SponsorClient {
    async requestWork(request) {
      requests.push(request);
      if (request.client) throw Object.assign(new Error('draft("unknown client token")'), { status: 400, refusal: 'draft("unknown client token")' });
      return { client: `token-${requests.length}`, assignment: request.store };
    }
    async submitShare(root) {
      credit.set(root, (credit.get(root) ?? 0) + 1);
      return { credit: credit.get(root) };
    }
    async store(root) {
      return { stored: false, credit: 0, bytes: 1 };
    }
    async storeStatus(root) {
      const paid = (credit.get(root) ?? 0) >= 1;
      return { stored: paid, credit: credit.get(root) ?? 0, bytes: 1 };
    }
  }
  async function* grind() {
    yield 1n;
  }
  return { sdk: { SponsorClient, grind }, requests };
}

test("keep asks for fresh work when the sponsor no longer knows its token", async () => {
  const { sdk, requests } = forgetfulSponsor();
  const volume = (cid) => ({ cid, entries: { [cid]: "AAAA" } });
  // One Volume per upload, so the token from the first is offered on the second.
  await keep(sdk, "http://sponsor", "Nexus/trellis", [volume("a"), volume("b"), volume("c")], { batchBytes: 1, pinWait: 1000 });
  assert.deepEqual(requests.filter((r) => !r.client).map((r) => r.store), ["a", "b", "c"]);
  assert.equal(requests.filter((r) => r.client).length, 2, "the second and third uploads first offered the old token");
});

// A sponsor behind a proxy that takes bodies of at most two Volumes, cuts the
// connection on four or more, and answers 429 to every third request.
function limitedSponsor() {
  const kept = new Set();
  const uploads = [];
  let requests = 0;
  const slowDown = () => {
    if (++requests % 3 === 0) throw Object.assign(new Error("sponsor request failed with HTTP 429"), { status: 429 });
  };
  class SponsorClient {
    async requestWork(request) {
      return { client: "t", assignment: request.store };
    }
    async submitShare(root) {
      kept.add(root);
      return { credit: 1 };
    }
    async store(root, volumes) {
      slowDown();
      if (volumes.length >= 4) throw new TypeError("fetch failed");
      if (volumes.length > 2) throw Object.assign(new Error("sponsor request failed with HTTP 413"), { status: 413 });
      uploads.push(volumes.map((v) => v.cid));
      return { stored: false, credit: 0, bytes: 1 };
    }
    async storeStatus(root) {
      slowDown();
      return { stored: kept.has(root), credit: kept.has(root) ? 1 : 0, bytes: 1 };
    }
  }
  async function* grind() {
    yield 1n;
  }
  return { sdk: { SponsorClient, grind }, uploads };
}

test("keep fits a sponsor's limits: halves an upload it refuses, waits when told to", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sdk, uploads } = limitedSponsor();
  const volume = (cid) => ({ cid, entries: { [cid]: "AAAA" } });
  const cids = ["a", "b", "c", "d", "e", "f", "g"];
  const done = keep(sdk, "http://sponsor", "Nexus/trellis", cids.map(volume), { pinWait: 1000 });
  // Run the backoff timers until it finishes.
  let finished = false;
  done.then(() => (finished = true), () => (finished = true));
  for (let i = 0; i < 1000 && !finished; i++) {
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(30_000);
  }
  await done;
  assert.ok(uploads.every((u) => u.length <= 2), "no upload over the limit");
  assert.deepEqual(uploads.flat().sort(), cids, "every Volume uploaded once");
});
