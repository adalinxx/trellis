// @handles from Moniker (Nexus/moniker), the names chain Lattice apps share.
// An account shows @h only while it names h (user/<a>/name) and h, held, points
// at it (points/<h>): Moniker's own rule (moniker-sdk records/names.mjs), so
// `trellis::@alice/repo` means the repo of whoever shows @alice now.

export const isHandle = (text) => typeof text === "string" && /^[a-z0-9_]+$/.test(text);

/** The account that shows `@handle` on Moniker's state `moniker`, or undefined. */
export async function accountOf(moniker, handle) {
  const h = handle.replace(/^@/, "");
  if (!isHandle(h)) return undefined;
  const [account, held] = await Promise.all([moniker.get(`points/${h}`), moniker.get(`name/${h}`)]);
  if (typeof account !== "string" || held === undefined || account.includes("/")) return undefined;
  return (await moniker.get(`user/${account}/name`)) === h ? account : undefined;
}

/** The handle `account` shows, or undefined. */
export async function handleOf(moniker, account) {
  const h = await moniker.get(`user/${account}/name`);
  if (!isHandle(h) || (await moniker.get(`points/${h}`)) !== account) return undefined;
  return (await moniker.get(`name/${h}`)) === undefined ? undefined : h;
}

/** `who` as an address: itself, or the account that shows it if it is an @handle. */
export async function addressOf(monikerState, who) {
  if (!who.startsWith("@")) return who;
  const account = await accountOf(await monikerState(), who);
  if (!account) throw new Error(`no account shows ${who} on Moniker`);
  return account;
}
