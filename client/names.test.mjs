import assert from "node:assert/strict";
import { test } from "node:test";
import { accountOf, addressOf, handleOf } from "./names.mjs";

const state = (entries) => ({ get: async (key) => new Map(entries).get(key) });

test("a handle stands for the account that shows it, only while it points there", async () => {
  const moniker = state([
    ["name/alice", "owner-a"],
    ["points/alice", "acct-a"],
    ["user/acct-a/name", "alice"],
    ["name/bob", "owner-b"],
    ["points/bob", "acct-b"], // acct-b doesn't name bob
    ["points/gone", "acct-g"], // released: no name/gone
    ["user/acct-g/name", "gone"],
  ]);
  assert.equal(await accountOf(moniker, "@alice"), "acct-a");
  assert.equal(await handleOf(moniker, "acct-a"), "alice");
  assert.equal(await accountOf(moniker, "@bob"), undefined);
  assert.equal(await accountOf(moniker, "@gone"), undefined);
  assert.equal(await handleOf(moniker, "acct-g"), undefined);
  assert.equal(await accountOf(moniker, "@Not-A-Handle"), undefined);
  assert.equal(await addressOf(async () => moniker, "bafyplain"), "bafyplain");
  assert.equal(await addressOf(async () => moniker, "@alice"), "acct-a");
  await assert.rejects(addressOf(async () => moniker, "@bob"), /no account shows @bob/);
});
