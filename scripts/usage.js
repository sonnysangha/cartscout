// npm run usage            the ledger against the budgets, then Oxylabs' own count of billable results by day
// npm run usage -- --local the ledger only, without asking Oxylabs anything
//
// The ledger is read from DATABASE_PATH without changing it. Oxylabs' count comes from its statistics endpoint,
// which is free of charge and needs OXYLABS_WEB_API_KEY. The key is sent in a header and never printed.
import { readBudgetLimits } from '../server/config.js';
import { usageReport } from '../server/usage.js';

try {
  console.log(await usageReport({
    databasePath: process.env.DATABASE_PATH || 'data/cartscout.sqlite',
    ...readBudgetLimits(process.env),
    key: process.env.OXYLABS_WEB_API_KEY?.trim(),
    remote: !process.argv.includes('--local'),
  }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
