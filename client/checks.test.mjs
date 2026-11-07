import assert from "node:assert/strict";
import { test } from "node:test";
import { check, checks, overall } from "./checks.mjs";

const memory = (writes) => {
  const map = new Map(writes);
  return { get: async (k) => map.get(k), async *list(p) { for (const k of [...map.keys()].sort()) if (k.startsWith(p)) yield [k, map.get(k)]; } };
};
const id = "a".repeat(64);

test("a commit's checks: the latest per name, from the repo's maintainers and runners", async () => {
  const card = { delegates: ["dana"], runners: ["bot"] };
  const state = memory([
    ...check("bot", "olga", "r", id, "test", { state: "pending", time: 1 }),
    ...check("bot", "olga", "r", id, "test", { state: "pass", time: 2, summary: "42 passed", url: "https://ci.example/1" }),
    ...check("dana", "olga", "r", id, "lint", { state: "fail", time: 3, url: "javascript:alert(1)" }),
    ...check("mallory", "olga", "r", id, "test", { state: "fail", time: 9 }),
  ]);
  const got = await checks(state, "olga", "r", card, id);
  assert.deepEqual(got.map((c) => [c.check, c.by, c.state]), [["lint", "dana", "fail"], ["test", "bot", "pass"]]);
  assert.equal(overall(got), "fail");
  assert.equal(got.find((c) => c.check === "lint").url, undefined, "only http(s) links");
  assert.deepEqual(await checks(state, "olga", "r", {}, id), [], "without the card naming them, nobody's");
  assert.throws(() => check("bot", "olga", "r", id, "x", { state: "great", time: 1 }));
  assert.throws(() => check("bot", "olga", "r", "abc", "x", { state: "pass", time: 1 }));
});

test("a check dated ahead of now doesn't outrank later ones", async () => {
  const state = memory([
    ...check("olga", "olga", "r", id, "test", { state: "fail", time: 100 }),
    ...check("bot", "olga", "r", id, "test", { state: "pass", time: 99_999_999 }),
  ]);
  const got = await checks(state, "olga", "r", { runners: ["bot"] }, id, { now: 200 });
  assert.deepEqual(got.map((c) => [c.by, c.state]), [["olga", "fail"]]);
});
