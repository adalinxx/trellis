# Trellis

Git hosting with no server. A repo's branches and tags are records on
Trellis's own Lattice chain, `Nexus/trellis`. Its code is Lattice content:
every commit, tree and file is a block named by its CID, which anyone can keep
and serve. No coins are needed: a sponsor pays each write's fee and keeps each
push's objects in return for a moment of the pusher's work.

This is phase 1: the chain, the record format, the object format, and
coinless pushes and clones in `client/`. The `git-remote-trellis` helper, the
web viewer, import, and issues and pull requests come next.

## Chain

`chain/spec.json` is the chain's `ChainSpec`. Its one policy, `policy/`, is
Kith's and lattice-social's, byte for byte (the same module CID): the owner
segment of `user/<owner>/...`, or the last segment of `index/.../<owner>`,
must sign the transaction. Nobody can write another account's records.

```sh
lattice child create Nexus/trellis --spec chain/spec.json \
  --policy-module chain/trellis_policy.wasm
```

## Records

| Key | Value |
| --- | --- |
| `user/<a>/repo/<name>` | `{ description?, delegates? }`: the repo's card |
| `user/<a>/repo/<name>/ref/<ref>` | `{ commit: <CID> }`: where `<a>`'s branch or tag points |
| `index/repo/<name>/<a>` | `"1"`: lists the repo under its name |

`client/records.mjs` builds and reads them. A change names the value it
replaces, so two pushes to one ref can't both apply.

## Objects

Repositories are SHA-256 (`git init --object-format=sha256`). Each git object
is one DAG-CBOR block, and each block is its own Volume, so any CID a repo
names can be fetched by itself, and two repos holding the same file hold one
block.

| Object | Block |
| --- | --- |
| commit | `{ tree: <CID>, parents: [<CID>], rest: <bytes>, id: <git id> }` |
| tree | `{ entries: [{ mode, name: <bytes>, cid }] }`; a submodule entry keeps its git `id` |
| tag | `{ object: <CID>, rest: <bytes>, id: <git id> }` |
| blob | a [lattice-storage](https://github.com/0xLattice/lattice-storage) file, type `application/vnd.git.blob`: one block up to 1 MiB, chunked above |

`rest` is every byte after the `tree`/`parent` or `object` lines, so each git
object is rebuilt exactly: the git ids match, and signed commits and tags
still verify. `id` lets a reader show a commit's git id without walking its
history; a clone recomputes it and refuses a block whose claim is wrong.

- `client/objects.mjs`: git object ↔ block.
- `client/transfer.mjs`: `encode` (git objects → Volumes to keep, children
  first, skipping what the other side has) and `fetchObjects` (Volumes → git
  objects, every block checked against its CID).
- `client/git.mjs`: a local repository through the `git` command (Node).

## No coins

`client/sponsor.mjs` talks to a
[lattice-sponsor](https://github.com/0xLattice/lattice-sponsor): `sponsored`
earns a write's fee with work and has the sponsor co-sign it; `keep` has the
sponsor (run with `--sell-storage`) keep a push's Volumes for good, paid with
work. The sponsor is trusted to keep the data, never to keep it correct.

## Tests

```sh
node --test client/*.test.mjs
```

The end-to-end test runs a private host, a sponsor and a reader's node. A
coinless account pushes twice, another can't move its ref, and the reader
clones from peers:

```sh
LATTICE=<lattice-node>/.build/debug/lattice \
LATTICE_SPONSOR=<lattice-sponsor>/.build/debug/lattice-sponsor node e2e/run.mjs
```

It passes on lattice-node `9abd15b` with lattice-sponsor `24d8c4d`.

The policy's own tests:

```sh
cd policy && cargo build --release --target wasm32-unknown-unknown
LATTICE_SDK_CORE=../vendor/lattice-sdk.js node --test test/policy.test.mjs
```
