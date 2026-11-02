// Vendored from 0xLattice/lattice-storage client/file.mjs at fc24f13 (MIT).
// Git blobs use this layout unchanged, so a blob is a lattice-storage file.

// A file's layout in Volumes. Every block is DAG-CBOR, named by its CID.
//
// A file of at most CHUNK_BYTES is one Volume, one block:
//   { type, size, bytes }
// the shape Moniker's and Fanfare's media readers take (`{ type, bytes }`).
//
// A larger file is a root Volume, one block:
//   { type, size, chunks: [cid, ...] }
// and one Volume per chunk, each one block `{ bytes }` of CHUNK_BYTES, the
// last of what remains. A file has one layout, so one CID.
//
// The record on chain names the root and the size; a reader checks the root
// against both before fetching any chunk, and every chunk against its CID
// and place.
//
// Browser-safe: base64 through btoa/atob, which Node has too.

export const CHUNK_BYTES = 1 << 20;

const toBase64 = (bytes) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};
const fromBase64 = (text) => Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));

function volume(sdk, value) {
  const block = sdk.encodeDagCbor(value);
  const cid = sdk.cidV1DagCbor(block);
  return { cid, entries: { [cid]: toBase64(block) } };
}

/**
 * The Volumes for a file, each in the shape `POST /pins` takes: the root
 * first, then the chunks in order (none for a file of one block).
 */
export function fileVolumes(sdk, type, bytes) {
  if (type.length > MAX_TYPE_LENGTH) throw new Error(`a file type is at most ${MAX_TYPE_LENGTH} characters`);
  const size = BigInt(bytes.length);
  if (bytes.length <= CHUNK_BYTES) return [volume(sdk, { bytes, size, type })];
  const chunks = [];
  for (let at = 0; at < bytes.length; at += CHUNK_BYTES) chunks.push(volume(sdk, { bytes: bytes.subarray(at, at + CHUNK_BYTES) }));
  return [volume(sdk, { chunks: chunks.map((chunk) => chunk.cid), size, type }), ...chunks];
}

/**
 * The one block of a Volume read from `GET /fetch/:cid`, decoded, or
 * undefined when its bytes are not its CID. Only the root's own entry is
 * read; any other entry the Volume carries is ignored. The CID must be the
 * DAG-CBOR SHA-256 one of the bytes: `verifyCID` would also take an identity
 * CID, whose "bytes" are whatever the CID itself says.
 */
export function readBlock(sdk, volume) {
  const encoded = volume?.entries?.[volume.cid];
  if (typeof encoded !== "string") return undefined;
  try {
    const bytes = fromBase64(encoded);
    if (sdk.cidV1DagCbor(bytes) !== volume.cid) return undefined;
    const value = sdk.decodeDagCbor(bytes);
    // Only a value that encodes back to the same bytes: a map key such as
    // `__proto__` decodes to no field at all, and would carry bytes no check
    // sees.
    return sdk.equalBytes(sdk.encodeDagCbor(value), bytes) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The longest `type` a root may carry. */
export const MAX_TYPE_LENGTH = 255;

/** Whether `cid` is a CIDv1 DAG-CBOR SHA-256 one, the only kind a file block has. */
export function isDagCborCID(sdk, cid) {
  if (typeof cid !== "string" || !/^b[a-z2-7]+$/.test(cid)) return false;
  try {
    const parsed = sdk.parseCID(cid);
    return parsed.version === 1 && parsed.codec === 0x71 && parsed.multihashCode === 0x12 && parsed.digest.length === 32;
  } catch {
    return false;
  }
}

/**
 * A file's root, `{ type, size, bytes }` or `{ type, size, chunks }`, or
 * undefined when the Volume is not one: bytes that are not its CID, a shape
 * that is not exactly a root (no other fields, which would be bytes no size
 * accounts for), sizes that don't add up, or more than `maxBytes`.
 */
export function readRoot(sdk, volume, { maxBytes = Infinity } = {}) {
  const root = readBlock(sdk, volume);
  if (typeof root !== "object" || root === null || Object.keys(root).length !== 3) return undefined;
  const { type, size, bytes, chunks } = root;
  if (typeof type !== "string" || type.length > MAX_TYPE_LENGTH || typeof size !== "bigint" || size > maxBytes) return undefined;
  if (bytes instanceof Uint8Array) {
    return BigInt(bytes.length) === size && size <= BigInt(CHUNK_BYTES) ? { type, size, bytes } : undefined;
  }
  const count = (size + BigInt(CHUNK_BYTES) - 1n) / BigInt(CHUNK_BYTES);
  if (!Array.isArray(chunks) || size <= BigInt(CHUNK_BYTES)) return undefined;
  if (BigInt(chunks.length) !== count || !chunks.every((cid) => isDagCborCID(sdk, cid))) return undefined;
  return { type, size, chunks };
}

/** How many bytes chunk `index` of a chunked root holds. */
export function chunkLength(root, index) {
  const rest = root.size - BigInt(index) * BigInt(CHUNK_BYTES);
  return Number(rest < BigInt(CHUNK_BYTES) ? rest : BigInt(CHUNK_BYTES));
}

/**
 * Chunk `index` of `root`, from its Volume, or undefined when the Volume is
 * not that chunk: another CID, bytes that are not it, or the wrong length.
 */
export function readChunk(sdk, volume, root, index) {
  if (volume?.cid !== root.chunks[index]) return undefined;
  const chunk = readBlock(sdk, volume);
  const bytes = chunk?.bytes;
  if (!(bytes instanceof Uint8Array) || Object.keys(chunk).length !== 1) return undefined;
  return bytes.length === chunkLength(root, index) ? bytes : undefined;
}

/** The file's bytes, from its root and every chunk read in order. */
export function assemble(root, chunks) {
  if (root.bytes) return root.bytes;
  if (chunks.length !== root.chunks.length || !chunks.every((chunk, index) => chunk.length === chunkLength(root, index))) {
    throw new Error("chunks don't add up to the file");
  }
  const bytes = new Uint8Array(Number(root.size));
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}
