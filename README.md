# Trellis

Git hosting with no server. A repo's branches and tags are records on
Trellis's own Lattice chain, `Nexus/trellis`. Its code is Lattice content:
every commit, tree and file is a block named by its CID, which anyone can keep
and serve. No coins are needed: a sponsor pays each write's fee and keeps each
push's objects in return for a moment of the pusher's work.

Stock git pushes and clones through `git-remote-trellis`. The web viewer,
import from GitHub, and issues and pull requests come next.

## Use

Put `bin/` on your `PATH` (it needs Node 22 or later), and use SHA-256
repositories:

```sh
git init --object-format=sha256 myrepo
git config trellis.node https://<a node serving Nexus/trellis>
git config trellis.sponsor https://<a lattice-sponsor>   # pays fees and keeps objects, for work
git config trellis.key ~/.lattice/me.json                 # lattice key generate --out ...
git remote add origin trellis::<your address>/myrepo
git push origin main

git clone trellis::<owner address>/<repo>                 # needs only trellis.node (or TRELLIS_NODE)
```

### Testnet

Trellis runs on testnet as `Nexus/testnet/trellis`, served publicly by
`lattice-testnet-apps-iad.fly.dev` and `lattice-testnet-apps-ams.fly.dev`
(list both in `trellis.node` to read from either), with a sponsor on iad:

```sh
git config trellis.node https://lattice-testnet-apps-iad.fly.dev
git config trellis.sponsor https://lattice-testnet-apps-iad.fly.dev:8650/sponsor
git config trellis.chain Nexus/testnet/trellis
```

Testnet may be reset; don't keep anything only there.

Each setting can also come from the environment: `TRELLIS_NODE`,
`TRELLIS_SPONSOR`, `TRELLIS_KEY`, `TRELLIS_CHAIN` (`Nexus/trellis` by
default). `trellis.node` may list several nodes, comma-separated: blocks are
read from any of them, and writes go to the first. A push needs no coins. A
rewrite needs `--force`, and a key can push only to its own address. The
helper keeps `$GIT_DIR/trellis/cids`, the CID of each object it has seen, so
it never walks old history twice.

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
- `client/remote.mjs`: the git remote helper (`bin/git-remote-trellis`).

## No coins

`client/sponsor.mjs` talks to a
[lattice-sponsor](https://github.com/0xLattice/lattice-sponsor): `sponsored`
earns a write's fee with work and has the sponsor co-sign it; `keep` has the
sponsor (run with `--sell-storage`) keep a push's Volumes for good, paid with
work. The sponsor is trusted to keep the data, never to keep it correct.

## Tests

```sh
npm test
```

`test/privacy.test.mjs` fails if any file git would commit, the built policy
module, or any commit names this machine or its user: the home path, user
name, full name, or the identity git falls back to. It works them out when it
runs and never prints them.

The end-to-end test runs a private host, a sponsor and a reader's node. Two
coinless accounts push, through the client library and through stock git.
Another account can't move their refs, a rewrite needs `--force`, and the
reader clones and fetches (a new commit, an annotated tag) from peers:

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
