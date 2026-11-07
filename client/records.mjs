// The records on Trellis's chain. Every key belongs to the account named in
// it, and that account must sign the transaction that writes it (policy/).
// Values are JSON strings; anything that doesn't parse is skipped.
//
//   user/<a>/repo/<name>             { description?, delegates? }  the repo's card
//   user/<a>/repo/<name>/ref/<ref>   { commit: <CID> | null, seq }  <a>'s word on where a branch or tag points
//   user/<m>/push/<o>/<name>/ref/<ref>  { commit: <CID> | null, seq }  maintainer <m>'s word on <o>/<name>'s ref
//   index/repo/<name>/<a>            "1"                           lists the repo under its name
//
// A repo's maintainers are its owner and the delegates its card names. Each
// writes only their own word (the chain's policy sees only who signs, not the
// card), and a ref is where the maintainers' word with the highest seq says:
// a push sets seq one past the word it replaces, so the latest push wins, as
// Radicle's delegates' refs make a canonical branch. A null commit deletes.
// Words from anyone the card no longer names don't count.
//
// A repo moves to another account (or name) when both cards say so: the old
// one's `movedTo: "<owner>/<name>"`, the new one's `movedFrom` naming it back.
// Either alone moves nothing, so neither side can claim the other's repo.

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
export const pushPrefix = (m, owner, name) => `user/${m}/push/${owner}/${checkName(name)}/ref/`;
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

/**
 * Maintainer `as`'s word that `owner`'s `ref` in repo `name` points at commit
 * block `commit` (undefined: the ref is deleted), as push number `seq`.
 */
/** The highest seq counted: a word above it counts as it. */
export const MAX_SEQ = 2 ** 52;
/** The seq of a push replacing a word at `seq`. */
export const nextSeq = (seq) => Math.min(seq + 1, MAX_SEQ);

export const ref = (owner, name, refName, commit, { as = owner, seq = 1 } = {}) => [
  [as === owner ? refKey(owner, name, refName) : `${pushPrefix(as, owner, name)}${checkRef(refName)}`, json({ commit: commit ?? null, seq })],
];

/** The repo's maintainers: its owner and the delegates its card names. */
export const maintainers = (owner, card) => [owner, ...(Array.isArray(card?.delegates) ? [...new Set(card.delegates.filter((d) => typeof d === "string" && d !== owner && !d.includes("/")))] : [])];

// Reads, from a state view `{ get, list }` (client/state.mjs).

/** `a`'s card for repo `name`, or undefined. */
export async function card(state, a, name) {
  const value = await state.get(cardKey(a, name));
  return value === undefined ? undefined : parse(value);
}

/** `a`'s refs in repo `name`: a Map from ref name to commit CID. */
export async function refs(sdk, state, a, name, theCard) {
  const out = new Map();
  for (const [ref, word] of await words(sdk, state, a, name, theCard)) if (word.commit) out.set(ref, word.commit);
  return out;
}

/**
 * The word each ref of `a`'s repo `name` stands on: a Map from ref name to
 * `{ commit, seq, by }`, commit null for a deleted ref. Pass the card if it
 * is already read.
 */
export async function words(sdk, state, a, name, theCard) {
  const theirs = maintainers(a, theCard === undefined ? await card(state, a, name) : theCard);
  const all = await Promise.all(theirs.map(async (m) => {
    const prefix = m === a ? refPrefix(a, name) : pushPrefix(m, a, name);
    const found = [];
    for await (const [key, value] of state.list(prefix)) {
      const ref = key.slice(prefix.length);
      const word = parse(value);
      const seq = word?.seq ?? 0;
      try {
        checkRef(ref);
        if (!Number.isSafeInteger(seq) || seq < 0) continue;
        // Clamped, so a word can't climb out of reach: at the cap, the owner's word wins.
        word.seq = Math.min(seq, MAX_SEQ);
        if (word.commit === null || (typeof word.commit === "string" && sdk.parseCID(word.commit).codec === 0x71)) found.push([ref, { commit: word.commit, seq: word.seq, by: m }]);
      } catch {}
    }
    return found;
  }));
  const out = new Map();
  for (const [ref, word] of all.flat()) {
    const held = out.get(ref);
    if (!held || beats(word, held, a)) out.set(ref, word);
  }
  return out;
}

// Higher seq; at equal seq (two pushes at once) the owner's, then the smaller commit.
const beats = (x, y, owner) =>
  x.seq !== y.seq ? x.seq > y.seq : x.by === owner || y.by === owner ? x.by === owner : (x.commit ?? "") !== (y.commit ?? "") ? (x.commit ?? "") < (y.commit ?? "") : x.by < y.by;

/** The accounts with a repo called `name`. */
export async function owners(state, name) {
  const prefix = `index/repo/${checkName(name)}/`;
  const out = [];
  for await (const [key, value] of state.list(prefix)) if (value === "1" && !key.slice(prefix.length).includes("/")) out.push(key.slice(prefix.length));
  return out;
}

const place = (text) => {
  const m = typeof text === "string" ? /^([^/]+)\/([^/]+)$/.exec(text) : null;
  if (!m || !NAME.test(m[2]) || m[2].endsWith(".lock")) return undefined;
  return { owner: m[1], name: m[2] };
};

/** Where `<a>/<name>` moved, `{ owner, name }`, if both cards say so; else undefined. */
export async function movedTo(state, a, name, theCard) {
  const there = place((theCard === undefined ? await card(state, a, name) : theCard)?.movedTo);
  if (!there || (there.owner === a && there.name === name)) return undefined;
  return (await card(state, there.owner, there.name))?.movedFrom === `${a}/${name}` ? there : undefined;
}

/** Where `<a>/<name>` is now, moves followed (at most 8): `{ owner, name, moved }`. */
export async function whereNow(state, a, name) {
  let at = { owner: a, name };
  const seen = new Set([`${a}/${name}`]);
  for (let hop = 0; hop < 8; hop++) {
    const next = await movedTo(state, at.owner, at.name);
    if (!next || seen.has(`${next.owner}/${next.name}`)) break;
    seen.add(`${next.owner}/${next.name}`);
    at = next;
  }
  return { ...at, moved: at.owner !== a || at.name !== name };
}

/**
 * `me`'s fork of `<owner>/<name>`: the same name under `me`, its card naming
 * the original (`forkOf`), its refs where the original's are. The blocks are
 * the original's, so nothing is uploaded. `mine` is `me`'s card there, if any:
 * then only the refs are written.
 */
export const fork = (me, owner, name, card, refs, mine) => [
  ...(mine ? [] : repo(me, name, { forkOf: `${owner}/${name}`, ...(typeof card?.description === "string" && { description: card.description }) })),
  ...[...refs].flatMap(([refName, cid]) => ref(me, name, refName, cid)),
];

/** The forks of `<owner>/<name>`: owners of the same name whose card says it's a fork of it. */
export async function forks(state, owner, name) {
  const out = [];
  for (const a of await owners(state, name)) if (a !== owner && (await card(state, a, name))?.forkOf === `${owner}/${name}`) out.push(a);
  return out;
}
