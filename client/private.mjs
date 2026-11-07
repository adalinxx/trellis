// Private repos' membership, on the repo's card (records.mjs):
//
//   private: { keys: [{ v, to: { <member>: <repo key v sealed to their box key> } }] }
//   readers: [<address>]                      members who read but don't push
//   user/<a>/box                              <a>'s box public key, base64 (seal.mjs)
//
// Members are the maintainers and readers. A new member gets every key
// version, so they read all history; a removed one is left out of a new
// version, which pushes seal with from then on. Node only.
import { boxKeys, newRepoKey, openKey, sealer, sealKeyTo } from "./seal.mjs";
import { maintainers } from "./records.mjs";

export const boxKey = (a) => `user/${a}/box`;
const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const unb64 = (text) => new Uint8Array(Buffer.from(text, "base64"));

/** Whether `card` is a private repo's. */
export const isPrivate = (card) => Array.isArray(card?.private?.keys) && card.private.keys.length > 0;

/** The repo's members: maintainers, then readers. */
export const members = (owner, card) => [...new Set([...maintainers(owner, card), ...(Array.isArray(card?.readers) ? card.readers.filter((r) => typeof r === "string" && !r.includes("/")) : [])])];

/** The write that publishes account key `privateKey`'s box key, for `address`. */
export const publishBox = (address, privateKey) => [[boxKey(address), b64(boxKeys(privateKey).publicKey)]];

/** `a`'s published box public key, or undefined. */
export async function boxOf(state, a) {
  const value = await state.get(boxKey(a));
  const bytes = typeof value === "string" ? unb64(value) : undefined;
  return bytes?.length === 32 ? bytes : undefined;
}

/**
 * The sealer for `<owner>/<name>` as `privateKey`'s account opens it, from
 * every key version sealed to it; throws if none is.
 */
export function repoSealer(owner, name, card, address, privateKey) {
  const mine = boxKeys(privateKey);
  const keys = new Map();
  for (const { v, to } of card.private.keys) {
    const key = to?.[address] && openKey(to[address], mine, `${owner}/${name}`);
    if (key && Number.isInteger(v) && v > 0 && v < 256) keys.set(v, key);
  }
  const current = Math.max(...card.private.keys.map((k) => k.v));
  if (!keys.size) throw new Error(`${owner}/${name} is private and ${address} isn't one of its members`);
  if (!keys.has(current)) throw new Error(`${owner}/${name} is private and ${address} is no longer one of its members`);
  return sealer(keys, current);
}

/** A new private repo's `private` field, its key sealed to the owner. */
export function newPrivate(owner, name, ownerBox) {
  return { keys: [{ v: 1, to: { [owner]: sealKeyTo(ownerBox, newRepoKey(), `${owner}/${name}`) } }] };
}

/**
 * `card` with the private keys re-dealt for `card`'s members as they now are,
 * by a member holding every version (`address`, `privateKey`): someone new
 * gets every version; if anyone was dropped, a new version for the rest.
 * `boxes(a)` is each member's box public key. Resolves to the new card.
 */
export async function redeal(owner, name, before, after, address, privateKey, boxes) {
  const mine = boxKeys(privateKey);
  const repo = `${owner}/${name}`;
  const was = new Set(members(owner, before));
  const now = members(owner, after);
  const dropped = [...was].some((m) => !now.includes(m));
  const keys = [];
  for (const { v, to } of before.private.keys) {
    const key = openKey(to?.[address], mine, repo);
    if (!key) throw new Error(`you don't hold key ${v} of ${repo}, so you can't share it`);
    const next = {};
    for (const m of now) {
      if (to[m] && was.has(m)) next[m] = to[m];
      else {
        const box = await boxes(m);
        if (!box) throw new Error(`${m} has no box key yet: they publish one by pushing anywhere with trellis, or with trellis box`);
        next[m] = sealKeyTo(box, key, repo);
      }
    }
    keys.push({ v, to: next });
  }
  if (dropped) {
    const v = Math.max(...keys.map((k) => k.v)) + 1;
    if (v > 255) throw new Error("this repo has had 255 keys: make a new one");
    const key = newRepoKey();
    const to = {};
    for (const m of now) to[m] = sealKeyTo(await boxes(m), key, repo);
    keys.push({ v, to });
  }
  return { ...after, private: { keys } };
}
