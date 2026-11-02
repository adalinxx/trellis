// The records on Trellis's chain. Every key belongs to the account named in
// it, and that account must sign the transaction that writes it (policy/).
// Values are JSON strings; anything that doesn't parse is skipped.
//
//   user/<a>/repo/<name>             { description?, delegates? }  the repo's card
//   user/<a>/repo/<name>/ref/<ref>   { commit: <CID> }             where <a>'s branch or tag points
//   index/repo/<name>/<a>            "1"                           lists the repo under its name

const NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;

/** Throws unless `name` is a repo name: letters, digits, `.`, `_`, `-`, at most 100. */
export function checkName(name) {
  if (!NAME.test(name) || name.endsWith(".lock")) throw new Error(`not a repo name: ${name}`);
  return name;
}

/** Throws unless `ref` is a full ref name git would take, under refs/. */
export function checkRef(ref) {
  const ok =
    /^refs\/[^\0- ~^:?*[\\\x7f]+$/.test(ref) &&
    !ref.split("/").some((part) => part === "" || part.startsWith(".") || part.endsWith(".lock")) &&
    !ref.includes("..") &&
    !ref.includes("@{") &&
    !ref.endsWith(".");
  if (!ok) throw new Error(`not a ref name: ${ref}`);
  return ref;
}

export const cardKey = (a, name) => `user/${a}/repo/${checkName(name)}`;
export const refPrefix = (a, name) => `${cardKey(a, name)}/ref/`;
export const refKey = (a, name, ref) => `${refPrefix(a, name)}${checkRef(ref)}`;
export const listingKey = (name, a) => `index/repo/${checkName(name)}/${a}`;

const json = (value) => (value === undefined ? undefined : JSON.stringify(value));
const parse = (value) => {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

// Writes: lists of [key, value]; a value of undefined deletes the key.

/** `a`'s repo `name` with its card, listed under its name; undefined deletes both. */
export const repo = (a, name, card = {}) => [
  [cardKey(a, name), json(card)],
  [listingKey(name, a), card === undefined ? undefined : "1"],
];

/** `a`'s `ref` in repo `name` pointing at commit block `commit`; undefined deletes it. */
export const ref = (a, name, refName, commit) => [[refKey(a, name, refName), commit === undefined ? undefined : json({ commit })]];

// Reads, from a state view `{ get, list }` (client/state.mjs).

/** `a`'s card for repo `name`, or undefined. */
export async function card(state, a, name) {
  const value = await state.get(cardKey(a, name));
  return value === undefined ? undefined : parse(value);
}

/** `a`'s refs in repo `name`: a Map from ref name to commit CID. */
export async function refs(sdk, state, a, name) {
  const prefix = refPrefix(a, name);
  const out = new Map();
  for await (const [key, value] of state.list(prefix)) {
    const name = key.slice(prefix.length);
    const commit = parse(value)?.commit;
    try {
      checkRef(name);
      if (typeof commit === "string" && sdk.parseCID(commit).codec === 0x71) out.set(name, commit);
    } catch {}
  }
  return out;
}

/** The accounts with a repo called `name`. */
export async function owners(state, name) {
  const prefix = `index/repo/${checkName(name)}/`;
  const out = [];
  for await (const [key, value] of state.list(prefix)) if (value === "1" && !key.slice(prefix.length).includes("/")) out.push(key.slice(prefix.length));
  return out;
}
