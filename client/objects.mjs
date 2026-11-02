// Git objects as Lattice content. Every object is one DAG-CBOR block named by
// its CIDv1 SHA-256, and every block is its own Volume, so any CID a repo
// names can be fetched by itself, and a block two repos share is one block.
//
//   commit  { tree: <CID>, parents: [<CID>], rest: <bytes>, id: <git id> }
//   tree    { entries: [{ mode, name: <bytes>, cid }] }   (a submodule: { mode, name, id })
//   tag     { object: <CID>, rest: <bytes>, id: <git id> }
//   blob    a lattice-storage file (vendor/storage-file.mjs), type BLOB_TYPE
//
// `rest` is every byte of the git object after its `tree`/`parent` or
// `object` lines, so a git object is rebuilt exactly from its block and its
// children's git ids: git's SHA-256 ids still match, and signatures over
// commits and tags still verify. `id` on a commit or tag is a claim that lets
// a reader show the git id without walking the history; whoever rebuilds the
// object recomputes it and refuses a block whose claim is wrong.
//
// Browser-safe: hashing is WebCrypto.
import { fileVolumes, isDagCborCID, readBlock } from "../vendor/storage-file.mjs";

/** The `type` of every blob's file root. */
export const BLOB_TYPE = "application/vnd.git.blob";
/** Largest block that is one Volume, as a node pins it and a sponsor stores it. */
export const MAX_BLOCK_BYTES = 1 << 20;

const ID_BYTES = 32; // SHA-256 git ids only
const GITLINK = "160000";
const MODES = new Set(["100644", "100755", "120000", "40000", GITLINK]);
const text = new TextEncoder();
const latin1 = (bytes) => String.fromCharCode(...bytes);

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (id) => Uint8Array.from(id.match(/../g), (pair) => parseInt(pair, 16));
const isId = (id) => typeof id === "string" && /^[0-9a-f]{64}$/.test(id);

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const toBase64 = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Git's SHA-256 id of an object: the hash of `<type> <size>\0<raw>`. */
export async function gitId(type, raw) {
  const framed = concat(text.encode(`${type} ${raw.length}\0`), raw);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", framed)));
}

/** The git ids an object names, in order: what must be stored before it. */
export function children(type, raw) {
  if (type === "commit") {
    const { tree, parents } = parseCommit(raw);
    return [tree, ...parents];
  }
  if (type === "tag") return [parseTag(raw).object];
  if (type === "tree") return parseTree(raw).filter((e) => e.mode !== GITLINK).map((e) => e.id);
  return [];
}

// "tree <id>\n" then any "parent <id>\n" lines: git writes them first, always.
function parseCommit(raw) {
  let at = 0;
  const line = (word) => {
    const head = `${word} `;
    if (latin1(raw.subarray(at, at + head.length)) !== head || raw[at + head.length + 64] !== 0x0a) return undefined;
    const id = latin1(raw.subarray(at + head.length, at + head.length + 64));
    if (!isId(id)) return undefined;
    at += head.length + 65;
    return id;
  };
  const tree = line("tree");
  if (!tree) throw new Error("a commit must start with its tree");
  const parents = [];
  for (let parent; (parent = line("parent")); ) parents.push(parent);
  return { tree, parents, rest: raw.subarray(at) };
}

function parseTag(raw) {
  const head = "object ";
  const id = latin1(raw.subarray(head.length, head.length + 64));
  if (latin1(raw.subarray(0, head.length)) !== head || !isId(id) || raw[head.length + 64] !== 0x0a) {
    throw new Error("a tag must start with its object");
  }
  return { object: id, rest: raw.subarray(head.length + 65) };
}

function parseTree(raw) {
  const entries = [];
  for (let at = 0; at < raw.length; ) {
    const space = raw.indexOf(0x20, at);
    const nul = raw.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 1 + ID_BYTES > raw.length) throw new Error("a tree entry is cut short");
    const mode = latin1(raw.subarray(at, space));
    if (!MODES.has(mode)) throw new Error(`a tree entry's mode ${mode} is not one git writes`);
    entries.push({ mode, name: raw.slice(space + 1, nul), id: hex(raw.subarray(nul + 1, nul + 1 + ID_BYTES)) });
    at = nul + 1 + ID_BYTES;
  }
  return entries;
}

function volumeOf(sdk, value) {
  const block = sdk.encodeDagCbor(value);
  if (block.length > MAX_BLOCK_BYTES) throw new Error(`a block of ${block.length} bytes is over 1 MiB`);
  const cid = sdk.cidV1DagCbor(block);
  return { cid, entries: { [cid]: toBase64(block) } };
}

/**
 * An object's Volumes (as `POST /pins` and a storage sponsor take them), its
 * own first, so its CID is `volumes[0].cid`. `cidOf(id)` is the CID of each
 * child named in `children(type, raw)`, which is stored first.
 */
export async function toVolumes(sdk, type, raw, cidOf) {
  const link = (id) => {
    const cid = cidOf(id);
    if (!cid) throw new Error(`no CID for ${id}`);
    return cid;
  };
  if (type === "blob") return fileVolumes(sdk, BLOB_TYPE, raw);
  if (type === "tree") {
    const entries = parseTree(raw).map(({ mode, name, id }) => (mode === GITLINK ? { id, mode, name } : { cid: link(id), mode, name }));
    return [volumeOf(sdk, { entries })];
  }
  if (type === "commit") {
    const { tree, parents, rest } = parseCommit(raw);
    return [volumeOf(sdk, { id: await gitId(type, raw), parents: parents.map(link), rest, tree: link(tree) })];
  }
  if (type === "tag") {
    const { object, rest } = parseTag(raw);
    return [volumeOf(sdk, { id: await gitId(type, raw), object: link(object), rest })];
  }
  throw new Error(`no such git object type: ${type}`);
}

const exactly = (value, ...keys) =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).sort().join() === [...keys].sort().join();
const isBytes = (value) => value instanceof Uint8Array;

/**
 * The block `bytes` decoded, or undefined unless they are exactly the
 * DAG-CBOR block `cid` names (lattice-storage's check, on bytes).
 */
export function decodeBlock(sdk, cid, bytes) {
  return readBlock(sdk, { cid, entries: { [cid]: toBase64(bytes) } });
}

/**
 * The object block `cid` holds, `{ type, links, block }`, or undefined when
 * `bytes` are not that block or it is not exactly one of the shapes above.
 * `links` are the CIDs it names, children first. A blob's `block` is its file
 * root; its chunks (`links`) are read with `readChunk` and joined with
 * `assemble` (vendor/storage-file.mjs).
 */
export function readObject(sdk, cid, bytes) {
  const block = decodeBlock(sdk, cid, bytes);
  if (exactly(block, "tree", "parents", "rest", "id")) {
    const { tree, parents, rest, id } = block;
    if (!isDagCborCID(sdk, tree) || !Array.isArray(parents) || !parents.every((p) => isDagCborCID(sdk, p))) return undefined;
    return isBytes(rest) && isId(id) ? { type: "commit", links: [tree, ...parents], block } : undefined;
  }
  if (exactly(block, "object", "rest", "id")) {
    const { object, rest, id } = block;
    return isDagCborCID(sdk, object) && isBytes(rest) && isId(id) ? { type: "tag", links: [object], block } : undefined;
  }
  if (exactly(block, "entries")) {
    if (!Array.isArray(block.entries)) return undefined;
    const ok = block.entries.every((e) =>
      e?.mode === GITLINK
        ? exactly(e, "mode", "name", "id") && isBytes(e.name) && isId(e.id)
        : exactly(e, "mode", "name", "cid") && MODES.has(e.mode) && isBytes(e.name) && isDagCborCID(sdk, e.cid),
    );
    return ok ? { type: "tree", links: block.entries.filter((e) => e.mode !== GITLINK).map((e) => e.cid), block } : undefined;
  }
  if (exactly(block, "type", "size", "bytes") || exactly(block, "type", "size", "chunks")) {
    if (block.type !== BLOB_TYPE) return undefined;
    if (isBytes(block.bytes)) return block.size === BigInt(block.bytes.length) ? { type: "blob", links: [], block } : undefined;
    return Array.isArray(block.chunks) && block.chunks.every((c) => isDagCborCID(sdk, c)) ? { type: "blob", links: block.chunks, block } : undefined;
  }
  return undefined;
}

/**
 * The git object's bytes, rebuilt from a commit, tree or tag block and
 * `idOf(cid)`, the git id of each CID it links to. (A blob's bytes are its
 * file's bytes.)
 */
export function gitBytes(type, block, idOf) {
  const id = (cid) => {
    const value = idOf(cid);
    if (!isId(value)) throw new Error(`no git id for ${cid}`);
    return value;
  };
  if (type === "commit") {
    const lines = [`tree ${id(block.tree)}\n`, ...block.parents.map((p) => `parent ${id(p)}\n`)].join("");
    return concat(text.encode(lines), block.rest);
  }
  if (type === "tag") return concat(text.encode(`object ${id(block.object)}\n`), block.rest);
  if (type === "tree") {
    return concat(...block.entries.flatMap((e) => [text.encode(`${e.mode} `), e.name, Uint8Array.of(0), unhex(e.mode === GITLINK ? e.id : id(e.cid))]));
  }
  throw new Error(`no such git object type: ${type}`);
}
