// Checks: CI results on commits, as signed records (GitHub's commit statuses).
//
//   user/<r>/check/<owner>/<name>/<commit id>/<check>   { state, summary?, url?, time }
//
// <commit id> is the commit's git id; state is "pending", "pass" or "fail".
// Anyone can write one under their own key; a repo counts those of its
// maintainers and of the runners its card names (`runners: [<address>]`).
// `trellis check` posts one from any CI; `trellis ci` runs a repo's
// `.trellis/ci` on each new commit of its branches and posts its result.
import { maintainers } from "./records.mjs";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/;
const STATES = new Set(["pending", "pass", "fail"]);
const json = (value) => JSON.stringify(value);
const isId = (id) => /^[0-9a-f]{64}$/.test(id);

export const checkKey = (r, owner, name, commit, check) => {
  if (!isId(commit)) throw new Error(`not a git commit id: ${commit}`);
  if (!NAME.test(check)) throw new Error(`a check's name is letters, digits, space, . _ - (at most 64): ${check}`);
  return `user/${r}/check/${owner}/${name}/${commit}/${check}`;
};

/** Runner `r`'s result `record` for `check` on `commit` of `<owner>/<name>`. */
export function check(r, owner, name, commit, checkName, record) {
  if (!STATES.has(record.state)) throw new Error(`a check is pending, pass or fail, not ${record.state}`);
  const clean = { state: record.state, time: record.time, ...(record.summary && { summary: String(record.summary).slice(0, 2000) }), ...(record.url && /^https?:\/\//.test(record.url) && { url: String(record.url).slice(0, 500) }) };
  return [[checkKey(r, owner, name, commit, checkName), json(clean)]];
}

/** Who counts for `<owner>/<name>`'s checks: its maintainers and runners. */
export const runners = (owner, card) => [...new Set([...maintainers(owner, card), ...(Array.isArray(card?.runners) ? card.runners.filter((r) => typeof r === "string" && !r.includes("/")) : [])])];

/**
 * The checks on `commit`, by check name: `[{ check, by, state, summary?, url?, time }]`,
 * the latest per name among the repo's runners.
 */
export async function checks(state, owner, name, card, commit) {
  if (!isId(commit)) return [];
  const latest = new Map();
  await Promise.all(runners(owner, card).map(async (r) => {
    const prefix = `user/${r}/check/${owner}/${name}/${commit}/`;
    for await (const [key, value] of state.list(prefix)) {
      const checkName = key.slice(prefix.length);
      let record;
      try {
        record = JSON.parse(value);
      } catch {
        continue;
      }
      if (!NAME.test(checkName) || !STATES.has(record?.state) || !Number.isSafeInteger(record.time)) continue;
      const found = { check: checkName, by: r, state: record.state, time: record.time, ...(typeof record.summary === "string" && { summary: record.summary }), ...(typeof record.url === "string" && /^https?:\/\//.test(record.url) && { url: record.url }) };
      const held = latest.get(checkName);
      if (!held || found.time > held.time || (found.time === held.time && found.by < held.by)) latest.set(checkName, found);
    }
  }));
  return [...latest.values()].sort((a, b) => (a.check < b.check ? -1 : 1));
}

/** One word for many checks: "fail" if any failed, else "pending" if any is, else "pass"; undefined for none. */
export const overall = (list) => (!list.length ? undefined : list.some((c) => c.state === "fail") ? "fail" : list.some((c) => c.state === "pending") ? "pending" : "pass");
