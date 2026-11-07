// Private repos: every block sealed with the repo's key, so a node or
// sponsor keeps and serves bytes it can't read. Node only.
//
//   sealed block   DAG-CBOR { sealed: <bytes> }: version (1 byte), nonce (12), AES-256-GCM ciphertext and tag
//   plain block    the block a public repo would have (objects.mjs), its links naming sealed CIDs
//
// The nonce is an HMAC of the plaintext under the key, so a block always
// seals to the same bytes (AES-GCM-SIV's idea, with plain GCM): pushes still
// share blocks, a clone makes the CIDs the chain names, and only equal blocks
// in the same repo look equal. A big file's root and its chunks are each
// sealed; how many blocks a file takes shows roughly how big it is.
//
// The repo key reaches each member sealed to their box key, an X25519 key
// derived from their account key and published at user/<a>/box. Removing a
// member makes a new key version for pushes from then on; members keep every
// version, so all history stays readable to them (and to whoever had it
// before, as with any clone).
import { createCipheriv, createDecipheriv, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";

const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");
const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const unb64 = (text) => new Uint8Array(Buffer.from(text, "base64"));

/** The box key pair of an account, derived from its Lattice private key: `{ publicKey, privateKey }` (raw 32 bytes each). */
export function boxKeys(accountPrivateKey) {
  const seed = Buffer.from(hkdfSync("sha256", accountPrivateKey, Buffer.alloc(0), "trellis box key v1", 32));
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_X25519, seed]), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(SPKI_X25519.length);
  return { publicKey: new Uint8Array(publicKey), privateKey: new Uint8Array(seed) };
}

const keyObjects = {
  private: (raw) => createPrivateKey({ key: Buffer.concat([PKCS8_X25519, Buffer.from(raw)]), format: "der", type: "pkcs8" }),
  public: (raw) => createPublicKey({ key: Buffer.concat([SPKI_X25519, Buffer.from(raw)]), format: "der", type: "spki" }),
};

const gcm = (key, nonce, data, aad) => {
  const c = createCipheriv("aes-256-gcm", key, nonce);
  if (aad) c.setAAD(aad);
  return Buffer.concat([c.update(data), c.final(), c.getAuthTag()]);
};
const ungcm = (key, nonce, data, aad) => {
  const d = createDecipheriv("aes-256-gcm", key, nonce);
  if (aad) d.setAAD(aad);
  d.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
};

/** A repo key sealed to box public key `to`, for repo `repo` (`<owner>/<name>`): a base64 string. */
export function sealKeyTo(to, repoKey, repo) {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const ephemeral = publicKey.export({ format: "der", type: "spki" }).subarray(SPKI_X25519.length);
  const shared = diffieHellman({ privateKey, publicKey: keyObjects.public(to) });
  const wrap = Buffer.from(hkdfSync("sha256", shared, Buffer.concat([ephemeral, Buffer.from(to)]), `trellis repo key v1 ${repo}`, 32));
  return b64(Buffer.concat([ephemeral, gcm(wrap, Buffer.alloc(12), repoKey)]));
}

/** The repo key sealed to the box key pair `mine`, or undefined if it isn't sealed to it. */
export function openKey(sealed, mine, repo) {
  try {
    const bytes = Buffer.from(unb64(sealed));
    const ephemeral = bytes.subarray(0, 32);
    const shared = diffieHellman({ privateKey: keyObjects.private(mine.privateKey), publicKey: keyObjects.public(ephemeral) });
    const wrap = Buffer.from(hkdfSync("sha256", shared, Buffer.concat([ephemeral, Buffer.from(mine.publicKey)]), `trellis repo key v1 ${repo}`, 32));
    return new Uint8Array(ungcm(wrap, Buffer.alloc(12), bytes.subarray(32)));
  } catch {
    return undefined;
  }
}

export const newRepoKey = () => new Uint8Array(randomBytes(32));

/**
 * A sealer for keys `keys` (a Map from version to repo key), sealing with
 * version `current`: `seal(sdk, volumes)` turns an object's Volumes (its own
 * first, as objects.toVolumes makes them) into sealed ones, and `open(sdk,
 * cid, bytes)` checks a sealed block against its CID and gives the plain
 * block `{ cid, bytes }` (cid: the plain block's own).
 */
export function sealer(keys, current) {
  const sealBytes = (sdk, plain) => {
    const key = keys.get(current);
    const nonce = createHmac("sha256", key).update(plain).digest().subarray(0, 12);
    const sealed = Buffer.concat([Buffer.of(current), nonce, gcm(Buffer.from(key), nonce, plain)]);
    const block = sdk.encodeDagCbor({ sealed: new Uint8Array(sealed) });
    return { cid: sdk.cidV1DagCbor(block), block };
  };
  const volume = ({ cid, block }) => ({ cid, entries: { [cid]: b64(block) } });
  return {
    seal(sdk, volumes) {
      const [root, ...chunks] = volumes;
      const plainOf = (v) => unb64(v.entries[v.cid]);
      const sealedChunks = chunks.map((c) => sealBytes(sdk, plainOf(c)));
      let rootPlain = plainOf(root);
      if (chunks.length) {
        // A file root names its chunks: name the sealed ones.
        const decoded = sdk.decodeDagCbor(rootPlain);
        const renamed = new Map(chunks.map((c, i) => [c.cid, sealedChunks[i].cid]));
        rootPlain = sdk.encodeDagCbor({ ...decoded, chunks: decoded.chunks.map((c) => renamed.get(c) ?? c) });
      }
      return [volume(sealBytes(sdk, rootPlain)), ...sealedChunks.map(volume)];
    },
    open(sdk, cid, bytes) {
      if (sdk.cidV1DagCbor(bytes) !== cid) throw new Error(`${cid}: the bytes aren't its block`);
      const { sealed } = sdk.decodeDagCbor(bytes);
      if (!(sealed instanceof Uint8Array) || sealed.length < 29) throw new Error(`${cid} isn't a sealed block`);
      const key = keys.get(sealed[0]);
      if (!key) throw new Error(`${cid} is sealed with key ${sealed[0]}, which you don't have`);
      const plain = new Uint8Array(ungcm(Buffer.from(key), Buffer.from(sealed.subarray(1, 13)), Buffer.from(sealed.subarray(13))));
      return { cid: sdk.cidV1DagCbor(plain), bytes: plain };
    },
  };
}
