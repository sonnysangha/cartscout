// How many requests CartScout may send to Oxylabs in a UTC day and month, and what a member is told when that is used up.

export const DEFAULT_DAILY_REQUESTS = 150;
export const DEFAULT_MONTHLY_REQUESTS = 2000;

export function createBudget({ ledger, daily = DEFAULT_DAILY_REQUESTS, monthly = DEFAULT_MONTHLY_REQUESTS }) {
  return {
    daily,
    monthly,
    /** Holds the worst case of one operation: { ticket }, or { refused: { scope, resetAt } } when it cannot be covered. */
    reserve: (operation, requests, now) => ledger.reserve({ operation, requests, now, daily, monthly }),
    /** Where both budgets stand, counting requests that running operations are still holding. */
    status(now) {
      const format = ({ day, month, held }) => {
        const line = (limit, period) => ({
          limit, used: period.requests, held, left: Math.max(0, limit - period.requests - held), resetAt: period.to,
        });
        return { day: line(daily, day), month: line(monthly, month) };
      };
      const result = ledger.totals(now);
      return result && typeof result.then === 'function' ? result.then(format) : format(result);
    },
  };
}

const WORDS = {
  scan: { saved: 'codes', back: 'scanning is' },
  lookup: { saved: 'prices', back: 'price checks are' },
};

/** The sentence for a member whose scan or price check the budget could not cover. */
export function budgetMessage(operation, { scope, resetAt }) {
  const { saved, back } = WORDS[operation];
  if (scope === 'month') {
    const date = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(resetAt);
    return `Scout has done all of this month’s live searching. Saved ${saved} still open, and ${back} back on ${date}.`;
  }
  return `Scout has done all of today’s live searching. Saved ${saved} still open, and ${back} back tomorrow.`;
}
