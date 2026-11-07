# Trellis

Git hosting with no server. A repo's branches and tags are records on
Trellis's own Lattice chain, `Nexus/trellis`. Its code is Lattice content:
every commit, tree and file is a block named by its CID, which anyone can keep
and serve. No coins are needed: a sponsor pays each write's fee and keeps each
push's objects in return for a moment of the pusher's work.

Stock git pushes and clones through `git-remote-trellis`, and `trellis
import` brings a repo from GitHub. The web page (`app/`) browses any repo,
and there anyone can fork, open issues and pull requests, review a pull
request line by line, and write releases, signing with
[Selfhold](https://github.com/adalinxx/selfhold-wallet) and with no coins.

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

Instead of a key file, git and `trellis` can sign with
[Selfhold](https://github.com/adalinxx/selfhold-wallet), the account you use
in the page: `trellis login` once, and each write after that opens a page on
`127.0.0.1` that asks Selfhold's window to approve it, as `gh auth login
--web` does. It sets `trellis.key` to `selfhold` and keeps the account in
`trellis.account` (global git config).

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

Any node that hosts the chain can serve a clone. The helper asks it which
nodes host the chain (`/api/chain/endpoints`) and asks all of them at once for
the blocks each holds, so blocks come from the nodes that keep them (the
sponsors' hosts); only a block none of them holds is fetched from peers. ky's
4,267 objects clone in about 45 s on testnet through either node.

### Browse

`app/` is a static page: serve the repository root from any static host and
open `app/`. It lists the chain's repos and shows a repo's files, README,
history, branches, tags and each commit's changes, for any branch, tag or
commit. It reads from the node in Settings (by default
`lattice-testnet-apps-iad.fly.dev`, chain `Nexus/testnet/trellis`; `?node=`
and `?chain=` on the page's URL override both) and reads only the blocks it
shows: a directory without its files, a file's size without its chunks, a
commit's changes only in the subtrees that differ. A file over 2 MiB is read
only when asked. Every block is checked against its CID. A README's raw HTML
is shown as text, only http(s) and mailto links are kept, and an image from
outside the repo becomes a link, so no other host learns who reads.
Signatures are shown as present, not checked: `git verify-commit` does that,
on a clone. The fonts ship with the page.

```sh
python3 -m http.server 8791   # from the repository root, then open http://127.0.0.1:8791/app/
```

### Issues, pull requests, reviews, releases

Sign in on the page with Selfhold: its window makes an account with a
passkey and approves each write, and the sponsor in Settings takes the
device's work for each fee, so taking part needs no coins.

- **Fork** writes your card and copies the repo's refs. The blocks are the
  original's, so nothing is uploaded.
- **Issues**: open, comment, close and reopen. The author and the repo's
  maintainers (its owner and the delegates its card names) can close one;
  maintainers label them.
- **Pull requests** merge a branch of any copy of the repo (yours, or
  someone's fork) into one of its branches. The page shows its commits and
  its changes from the merge base, and anyone signed in can comment on any
  line; a reviewer sees the commits since their last review on their own. A
  maintainer merges in the page when the base is behind the branch (a
  fast-forward: their push moves the base, with no new commit), or else by
  pushing a merge commit from a clone (the page shows how). Once the base
  branch contains the head's commit, the page shows it as merged. No record
  says so.
- **Releases**: a maintainer writes notes for a tag, with files if they
  like; they show on the Tags page, each file a download read by its CID. A
  release's files are kept by the sponsor, for the device's work. From a
  terminal or CI: `trellis release <tag> --title <t> --notes <text> <file>...`
  (every sponsor in `trellis.sponsor` keeps them).
- **Search**: a repo's Search tab finds files by name and text on any branch
  or tag, reading the blocks in the browser (ky's 115 files: about 30 s the
  first time); the issue and pull request lists filter by words in a title,
  description, label or author.
- **Inbox**: whoever opens an issue or pull request, or comments, tells the
  repo's maintainers, the thread's author and commenters, and anyone they
  mention by @handle, in the same transaction. The Inbox shows these notes,
  newest first, each only if what it names is there; which are read is kept
  on the device.

### Names

Wherever an address goes, an @handle from
[Moniker](https://github.com/adalinxx/moniker), the names chain Lattice apps
share, goes too: `git clone trellis::@alice/tools`, `trellis maintainers add
@bob`, and `#/@alice/tools` in the page, which shows every account by the
handle it shows. A handle stands for an account only while that account names
it on Moniker and the handle points at it, Moniker's own rule; a handle sold
or pointed elsewhere stops meaning the old account. Handles are read from
`Nexus/moniker` (`trellis.moniker`, or Names in the page's Settings) through
the same nodes.

### Teams

A repo's maintainers are its owner and the delegates the owner names. Each
pushes with their own key, to the owner's address, and the latest push to a
branch stands:

```sh
trellis maintainers                    # in a clone whose origin is the repo
trellis maintainers add <address>      # the owner's key only
trellis maintainers remove <address>   # branches stay where they are
```

Maintainers also close and label issues and write releases. Two pushes to one
branch that land in the same block can't both stand: the one that loses says
so (`another maintainer pushed to it at the same time`), and fetching and
pushing again puts it on top.

### CI

A check is a CI result on a commit, signed by whoever ran it, as GitHub's
commit statuses are. The page shows each commit's checks, and a pull
request's on its head, counting only the repo's maintainers' and the runners
its owner names:

```sh
trellis runners add <address>              # the owner: whose checks count
trellis ci                                 # a runner: .trellis/ci on each new branch tip, results posted
trellis check test pass --url <link>       # from any CI (GitHub Actions on an exported mirror, say)
```

`trellis ci` fetches `origin` every minute (`--once` for one pass), runs the
commit's executable `.trellis/ci` in a scratch worktree with `CI=true`,
`TRELLIS_COMMIT` and `TRELLIS_BRANCH` set, and posts pending, then pass or
fail with the output's last lines. It runs the repo's own code, from the
commit's files alone (no `.git`, no git config, a bare environment), but as
your OS user: run it under an account of its own, holding only the runner's
key, and only for repos you trust, as with any CI runner. Private repos have
no checks or releases, since both are public records.

### Private repos

```sh
trellis private                        # in a new repo's clone, before its first push
trellis readers add <address>          # members who read but don't push
trellis maintainers add <address>      # members who push too
```

A private repo's every block is sealed with the repo's key (AES-256-GCM), so
the nodes and sponsors that keep and serve it can't read its files, messages
or history. The key reaches each member sealed to their box key, an X25519
key derived from their account key and published on their first push (or
with `trellis box`). Removing a member makes a new key for every push from
then on; members keep every key, so all history stays readable to them.
Members read and push with key files, as git does; the page can't open a
private repo. Public on the chain: its name, its branch and tag names, who
its members are, and its files' sizes. Issues and pull requests are off.
Sealing is deterministic, so pushes share blocks and `trellis mirror` works.

### Keeping a repo

A repo's blocks are kept by the sponsors that push or mirror it, each on its
own node. `trellis.sponsor` may list several, comma-separated: every push is
kept by each of them (the first pays the fee), so the repo outlives any one
host. To have one more sponsor keep a whole repo, from an up-to-date clone:

```sh
trellis mirror https://<a sponsor your team runs>
```

The blocks are made from the clone, with the same CIDs, so nothing is
downloaded. The chain itself (refs, issues, reviews, releases) is kept by
every node that hosts it.

### Bring a repo from GitHub

```sh
trellis import https://github.com/<org>/<repo> myrepo   # any URL or path git clones
cd myrepo
git remote add origin trellis::<your address>/<repo>
git push origin --all && git push origin --tags refs/notes/commits
trellis import-issues https://github.com/<org>/<repo>   # its issues and pull requests
```

`trellis import` converts a SHA-1 repository to SHA-256 with git's own
`fast-export` and `fast-import`: branches and tags, with every author, date,
message, file and mode kept byte for byte. Only the ids change, so a
signature made over the old ids no longer verifies. Each commit and annotated
tag gets a git note (`refs/notes/commits`, shown by `git log`) with its old
id and, if it was signed, the signature as text. An old id in a message or a
link can still be found with `git log --notes --grep=<id>`. The notes name a
URL source without credentials and a local path by its last segment only. A
repository with submodules is refused: their ids are SHA-1.

`trellis import-issues`, in a repository whose `origin` is yours on Trellis,
brings the GitHub repo's issues and pull requests, with their comments,
labels, dates and open or closed state. They are written and signed by you:
their GitHub authors can't sign here, so each one starts with a line naming
its author and linking the original. A pull request comes in as an issue
labelled `pull request`, since its branches are GitHub's. Ids come from the
GitHub URLs, so running it again writes only what changed (and finishes an
import that stopped). It needs no coins. GitHub lets it make 60 requests an
hour without `GITHUB_TOKEN`, 100 issues or comments each.

To keep a GitHub copy while a team moves (so CI and tools that only know
SHA-1 keep working), from a Trellis clone:

```sh
trellis export https://github.com/<org>/<repo>.git   # branches and tags, as SHA-1; again: only what is new
```

It is `trellis import` in reverse, by `git fast-export` and `fast-import`,
with marks kept in `.git/trellis/export`. History that came from SHA-1 comes
back with its old ids (signatures aside: they were stripped on import), so
GitHub's copy of an imported repo keeps its commits. Branches and tags
deleted here are deleted there.

Each setting can also come from the environment: `TRELLIS_NODE`,
`TRELLIS_SPONSOR`, `TRELLIS_KEY`, `TRELLIS_CHAIN` (`Nexus/trellis` by
default). `trellis.node` may list several nodes, comma-separated: blocks are
read from any of them, and writes go to the first. A push needs no coins. A
rewrite needs `--force`, and only the repo's maintainers can push to it. The
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
| `user/<a>/repo/<name>/ref/<ref>` | `{ commit: <CID> \| null, seq }`: the owner's word on where a branch or tag points |
| `user/<m>/push/<a>/<name>/ref/<ref>` | the same, maintainer `<m>`'s word on `<a>`'s repo |
| `index/repo/<name>/<a>` | `"1"`: lists the repo under its name |

`client/records.mjs` builds and reads them. A change names the value it
replaces, so two writes to one key can't both apply. The chain's policy sees
only who signs, so each maintainer writes only their own words, and readers
take the word with the highest `seq` from the maintainers the card names (at
equal `seq`, the owner's, then the smaller commit CID), as Radicle's
delegates make a canonical branch. A push sets `seq` one past the word it
replaces; a null commit deletes the ref.

Collaboration, `client/collab.mjs`:

| Key | Value |
| --- | --- |
| `user/<a>/issue/<id>` | `{ repo: "<owner>/<name>", title, body, time, state?, updated?, head?, base? }`: an issue; with `head: "<a>/<name>:<branch>"` and `base: "<branch>"`, a pull request |
| `index/issue/<owner>/<name>/<id>/<a>` | `"1"`: lists it under the repo |
| `user/<a>/post/<id>` | `{ on: "<author>/<id>", body, time, review? }`: a comment; `review: { commit, path, line, side }` puts it on a line of a pull request's changes at that head commit |
| `index/post/<author>/<id>/<post id>/<a>` | `"1"`: lists it under the issue |
| `user/<m>/triage/<owner>/<name>/<author>/<id>` | `{ state?, labels?, time }`: a maintainer closes, reopens or labels it |
| `user/<m>/release/<name>/<tag>` | `{ title?, notes, time }`: a maintainer's release notes for a tag |

An issue's state is the latest word on it, its author's or a maintainer's;
its labels, the latest maintainer's to label it. Records from anyone else
are ignored. Times are each writer's own claim.

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
- `client/import.mjs`: `trellis import` (`bin/trellis`).
- `client/github.mjs`: `trellis import-issues`, GitHub's issues and pull
  requests as collaboration records.
- `client/browse.mjs`: what the page reads (commits, trees, files,
  history, changes, a pull request's commits and merge base) and its line
  diff (Myers', with git's hunks).

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

`E2E_BIG_MB=120` adds a repo of about 120 MiB (3,200 objects over four
commits), pushed by stock git and cloned through the reader and from the
host. It passes, with the helper under 760 MB of memory.

It passes on lattice-node `9abd15b` with lattice-sponsor `24d8c4d`.

The page's tests drive `app/` in headless Chromium (Playwright) against the
same private stack (`e2e/stack.mjs`). `viewer.test.mjs`: a repo pushed by
stock git with no coins, then its list, files, README, history, diffs,
branches, tags, a large file read only when asked, and a node that can't
serve the chain. `collab.test.mjs`, with Selfhold's window built from
selfhold-wallet and a passkey from Chromium's virtual authenticator: a
coinless person signs in and forks; opens an issue that the owner (signing
with a key file) labels and closes, comments, and reopens it; declines a
write, which isn't sent; opens a pull request from someone else's fork,
comments on a line of its changes, and sees it merged once the owner
pushes the merge; and writes a release on their fork.

```sh
cd e2e/ui && npm ci && npx playwright install chromium
LATTICE=<lattice-node>/.build/debug/lattice \
LATTICE_WALLET_WEB=<selfhold-wallet>/dist-web npm test
```

The policy's own tests:

```sh
cd policy && cargo build --release --target wasm32-unknown-unknown
LATTICE_SDK_CORE=../vendor/lattice-sdk.js node --test test/policy.test.mjs
```
