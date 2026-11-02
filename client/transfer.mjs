// Moving objects between a git repository and Lattice content: `encode` turns
// git objects into Volumes to store, `fetchObjects` reads Volumes back into
// git objects, checking every block against its CID and every commit's and
// tag's git id against its claim. Browser-safe; the git side is client/git.mjs.
import { children, decodeBlock, gitBytes, gitId, readObject, toVolumes } from "./objects.mjs";
import { assemble, chunkLength } from "../vendor/storage-file.mjs";

/**
 * The Volumes of the objects `ids` (git ids, as `objectsBetween` lists
 * them), children before the objects that name them. `read(id)` gives an
 * object's `{ type, raw }`. `known` maps git id to CID: objects the other
 * side already holds, so nothing they name is walked. It is filled as
 * objects are encoded. An object outside `ids` that a new one names is
 * encoded for its CID, and its Volumes are not returned (the other side has
 * it).
 */
export async function encode(sdk, read, ids, known = new Map()) {
  const wanted = new Set(ids);
  const volumes = [];
  const pending = new Map();
  for (const start of ids) {
    const stack = [start];
    while (stack.length > 0) {
      const id = stack.at(-1);
      if (known.has(id)) {
        stack.pop();
        continue;
      }
      let object = pending.get(id);
      if (!object) pending.set(id, (object = await read(id)));
      const missing = children(object.type, object.raw).filter((child) => !known.has(child));
      if (missing.length > 0) {
        stack.push(...missing);
        continue;
      }
      stack.pop();
      const own = await toVolumes(sdk, object.type, object.raw, (child) => known.get(child));
      known.set(id, own[0].cid);
      pending.delete(id);
      if (wanted.has(id)) volumes.push(...own);
    }
  }
  return volumes;
}

/** Many at once, at most `width` in flight. */
async function each(items, width, run) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await run(items[index]);
      }
    }),
  );
  return out;
}

/**
 * Every object reachable from `roots` (CIDs) that `ids` (CID to git id,
 * objects already held) doesn't have, read with `load(cid)` (a block's bytes)
 * and rebuilt as `[{ type, raw, id, cid }]`, children first. `ids` is filled
 * as objects are rebuilt. Throws on a block that is not its CID or not an
 * object, and on a commit or tag whose git id is not the one it claims.
 */
export async function fetchObjects(sdk, load, roots, ids = new Map(), { width = 64 } = {}) {
  const objects = new Map();
  let frontier = [...new Set(roots)].filter((cid) => !ids.has(cid));
  while (frontier.length > 0) {
    const read = await each(frontier, width, async (cid) => {
      const object = readObject(sdk, cid, await load(cid));
      if (!object) throw new Error(`${cid} is not a git object block`);
      if (object.type === "blob" && object.links.length > 0) {
        object.chunks = await each(object.links.map((chunkCID, index) => [chunkCID, index]), width, async ([chunkCID, index]) => {
          const chunk = decodeBlock(sdk, chunkCID, await load(chunkCID));
          const bytes = chunk?.bytes;
          if (!(bytes instanceof Uint8Array) || Object.keys(chunk).length !== 1 || bytes.length !== chunkLength(object.block, index)) {
            throw new Error(`${chunkCID} is not chunk ${index} of ${cid}`);
          }
          return bytes;
        });
      }
      return [cid, object];
    });
    const next = new Set();
    for (const [cid, object] of read) {
      objects.set(cid, object);
      if (object.type !== "blob") for (const link of object.links) if (!ids.has(link) && !objects.has(link)) next.add(link);
    }
    frontier = [...next];
  }

  // Children first: a git object's bytes need its children's git ids.
  const out = [];
  const done = new Set();
  for (const root of objects.keys()) {
    const stack = [root];
    while (stack.length > 0) {
      const cid = stack.at(-1);
      if (ids.has(cid) || done.has(cid)) {
        stack.pop();
        continue;
      }
      const object = objects.get(cid);
      const missing = object.type === "blob" ? [] : object.links.filter((link) => !ids.has(link));
      if (missing.length > 0) {
        stack.push(...missing);
        continue;
      }
      stack.pop();
      const raw = object.type === "blob" ? assemble(object.block, object.chunks ?? []) : gitBytes(object.type, object.block, (link) => ids.get(link));
      const id = await gitId(object.type, raw);
      if ((object.type === "commit" || object.type === "tag") && id !== object.block.id) {
        throw new Error(`${cid} claims git id ${object.block.id} but is ${id}`);
      }
      ids.set(cid, id);
      done.add(cid);
      out.push({ type: object.type, raw, id, cid });
    }
  }
  return out;
}
