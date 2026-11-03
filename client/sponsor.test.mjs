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
