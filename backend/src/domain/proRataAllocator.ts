// Splits a filled order's quantity across client accounts by target weight,
// conserving every share: the sum of every account's allocated quantity must
// exactly equal the filled quantity, for every order, not just on average.
//
// The first implementation of this function rounded each account
// independently (`Math.round(filledQuantity * weight / totalWeight)`); see
// the README's Findings section for the property test that caught this not
// conserving shares and the fix below. The method that survived is the
// largest-remainder method: give every account the floor of its exact share,
// then hand the leftover whole shares (an exact integer by construction,
// `filledQuantity - sum(floors)`) to the accounts with the largest fractional
// remainder, one each, breaking ties by account name for determinism.
export interface AccountWeight {
  account: string;
  weight: number;
}

export function allocateProRata(
  filledQuantity: number,
  weights: AccountWeight[]
): Record<string, number> {
  if (weights.length === 0) {
    throw new Error("allocateProRata requires at least one target account");
  }
  if (!Number.isInteger(filledQuantity) || filledQuantity < 0) {
    throw new Error(`allocateProRata requires a non-negative integer filled quantity, got ${filledQuantity}`);
  }
  for (const w of weights) {
    if (w.weight < 0) {
      throw new Error(`allocateProRata requires non-negative weights, got ${w.weight} for ${w.account}`);
    }
  }
  const totalWeight = weights.reduce((sum, w) => sum + w.weight, 0);
  if (totalWeight <= 0) {
    throw new Error("allocateProRata requires a positive total weight");
  }

  const floors = weights.map((w) => {
    const exact = (filledQuantity * w.weight) / totalWeight;
    const base = Math.floor(exact);
    return { account: w.account, base, remainder: exact - base };
  });

  const result: Record<string, number> = {};
  let allocated = 0;
  for (const f of floors) {
    result[f.account] = f.base;
    allocated += f.base;
  }

  // Integer subtraction of two integers: exact, no floating-point residue,
  // regardless of any rounding wobble in how `exact`/`base` were computed
  // above. This is what makes conservation hold by construction rather than
  // by luck: every one of these `leftover` whole shares gets handed out
  // below, so the total handed out is always exactly `allocated + leftover`,
  // which is exactly `filledQuantity`.
  const leftover = filledQuantity - allocated;

  const byRemainderDesc = [...floors].sort(
    (a, b) => b.remainder - a.remainder || a.account.localeCompare(b.account)
  );

  for (let i = 0; i < leftover; i++) {
    const account = byRemainderDesc[i % byRemainderDesc.length].account;
    result[account] += 1;
  }

  return result;
}
