// Who signs a command-line write: a key file (trellis.key = its path), or
// Selfhold (trellis.key = selfhold), the account the page signs with, whose
// address `trellis login` keeps in trellis.account. Either way the fee is
// paid with work through a sponsor, so no coins are needed.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { setting } from "./remote.mjs";
import { sponsored } from "./sponsor.mjs";
import { transaction } from "./write.mjs";
import { inSelfhold } from "./selfhold.mjs";

/**
 * The signer `gitDir`'s settings name: `{ address, write(chain, chainPath,
 * actions, what) }`, where `write` resolves once the node has taken the
 * transaction, or throws saying why not.
 */
export function signer(sdk, gitDir, { say = () => {}, urls = [] } = {}) {
  const key = setting(gitDir, "key", "TRELLIS_KEY");
  const sponsor = (setting(gitDir, "sponsor", "TRELLIS_SPONSOR") ?? "").split(",")[0].trim() || undefined;
  if (!key) throw new Error("no key: set trellis.key (git config) to a key file, or to selfhold and run trellis login");
  if (key === "selfhold") {
    const address = setting(gitDir, "account", "TRELLIS_ACCOUNT");
    if (!address) throw new Error("trellis.key is selfhold, but no account is signed in: run trellis login");
    return {
      address,
      async write(chain, chainPath, actions, what = "Write to Trellis") {
        const detail = actions.map((a) => `${a.newValue === undefined ? "delete" : a.oldValue === undefined ? "add" : "change"} ${a.key}`).join("\n");
        const { sent } = await inSelfhold({ title: what, what: `${actions.length} record${actions.length === 1 ? "" : "s"} on ${chainPath.join("/")}, signed by ${address}.`, detail, request: { chainPath, actions }, account: address, hosts: urls, sponsor }, { say });
        if (!sent) throw new Error("Selfhold sent nothing");
      },
    };
  }
  const privateKey = sdk.hexToBytes(JSON.parse(readFileSync(key, "utf8")).privateKey);
  return {
    address: sdk.accountFromPrivateKey(privateKey).address,
    async write(chain, chainPath, actions) {
      if (!sponsor) throw new Error("no sponsor: set trellis.sponsor (git config) or TRELLIS_SPONSOR");
      const draft = transaction({ owner: this.address, actions, nonce: await chain.nonce(this.address), chainPath });
      const response = await chain.submit(await sponsored(sdk, sponsor, draft, privateKey));
      if (!response.ok) throw new Error(`refused: ${(await response.text()).replace(/\s+/g, " ").slice(0, 300)}`);
    },
  };
}

/** `trellis login`: signs in with Selfhold and keeps the account in trellis.account (global git config). */
export async function login({ say = () => {}, urls = [], sponsor } = {}) {
  const { address } = await inSelfhold({ title: "Sign in to Trellis", what: "The trellis command and git will ask Selfhold to approve each write, as this account.", hosts: urls, sponsor }, { say });
  if (!address) throw new Error("Selfhold gave no account");
  execFileSync("git", ["config", "--global", "trellis.account", address]);
  execFileSync("git", ["config", "--global", "trellis.key", "selfhold"]);
  return address;
}
