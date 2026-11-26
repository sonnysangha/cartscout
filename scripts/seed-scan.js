// npm run seed:scan -- <shop> CODE[=offer text] ...
//
// Puts codes for a shop into the local database without a scan, for test rigs and local development. Nothing is sent
// to Oxylabs. A member who scans that shop in the next 24 hours (or at any time, in replay mode) is answered from
// these codes. Everything written is marked as seeded, so it can be told apart from codes Scout really found.
//
//   npm run seed:scan -- myprotein.com MORE="Extra 10% off" WELCOME5
//   npm run seed:scan -- --db data/rig.sqlite lookfantastic.com EXTRA="Extra 5% off selected"
//   npm run seed:scan -- nocodes.example.com          (a scan that found nothing)
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { normalizeCode, normalizeMerchant } from '../server/oxylabs.js';
import { openStore } from '../server/store.js';

const HOW = 'Usage: npm run seed:scan -- [--db <database file>] <shop> CODE[=offer text] ...';

function fail(message) {
  console.error(`${message}\n${HOW}`);
  process.exit(1);
}

// The same database the server opens: --db, then DATABASE_PATH, then the DATABASE_PATH line of .env, then the default.
// Only that one line of .env is used. This tool has no use for a key and never loads one.
function databasePath(given) {
  if (given) return given;
  if (process.env.DATABASE_PATH) return process.env.DATABASE_PATH;
  if (existsSync('.env')) {
    const fromFile = parseEnv(readFileSync('.env', 'utf8')).DATABASE_PATH;
    if (fromFile) return fromFile;
  }
  return 'data/cartscout.sqlite';
}

const args = process.argv.slice(2);
let chosen;
const at = args.indexOf('--db');
if (at !== -1) {
  chosen = args[at + 1];
  if (!chosen || chosen.startsWith('--')) fail('Name a database file after --db.');
  args.splice(at, 2);
}
const unknown = args.find((value) => value.startsWith('--'));
if (unknown) fail(`Unknown option ${unknown}.`);
const [shop, ...entries] = args;
if (!shop) fail('Name the shop to seed.');
const merchant = normalizeMerchant(shop);
if (!merchant) fail(`"${shop}" is not a public shop address. Give its hostname, like myprotein.com.`);

const coupons = new Map();
for (const entry of entries) {
  const split = entry.indexOf('=');
  const written = split === -1 ? entry : entry.slice(0, split);
  const code = normalizeCode(written);
  if (!code) fail(`"${written}" is not a coupon code. A code is 3 to 40 letters, digits, hyphens or underscores.`);
  const offer = split === -1 ? '' : entry.slice(split + 1).trim().replace(/\s+/g, ' ').slice(0, 180);
  // No page showed these codes, so they name no source.
  coupons.set(code, { code, offer, sources: [], expiresOn: null });
}

const path = databasePath(chosen);
const store = openStore(path);
try {
  store.seedScan(merchant, [...coupons.values()], Date.now());
} finally {
  store.close();
}
const codes = [...coupons.keys()];
console.log(codes.length
  ? `Seeded ${codes.length} ${codes.length === 1 ? 'code' : 'codes'} for ${merchant} in ${path}: ${codes.join(', ')}. Marked as seeded.`
  : `Seeded a scan with no codes for ${merchant} in ${path}. Marked as seeded.`);
