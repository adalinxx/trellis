// Builds the transactions that write records. A record change is a
// general-state action `{ key, oldValue?, newValue? }`: consensus applies it
// only when `oldValue` is what the key holds now, so a change is always made
// against a state the writer has read. (As Stoa's and Kith's.)

/** The actions for `[key, value]` writes against `state`; a value of undefined deletes the key. */
export async function changes(state, writes) {
  const actions = await Promise.all(
    writes.map(async ([key, newValue]) => {
      const oldValue = await state.get(key);
      return { key, ...(oldValue !== undefined && { oldValue }), ...(newValue !== undefined && { newValue }) };
    }),
  );
  // Deleting a key that is not there, or writing what it holds, changes nothing.
  return actions.filter((action) => action.oldValue !== action.newValue);
}

/** A transaction body carrying `actions`, signed for and paid by `owner` (no fee: a sponsor pays it). */
export function transaction({ owner, actions, fee = 0n, nonce, chainPath }) {
  return {
    accountActions: fee > 0n ? [{ owner, delta: -fee }] : [],
    actions,
    depositActions: [],
    receiptActions: [],
    withdrawalActions: [],
    signers: [owner],
    nonce,
    chainPath: [...chainPath],
  };
}
