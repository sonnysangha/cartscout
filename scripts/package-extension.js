import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';

const { values } = parseArgs({
  options: { 'api-origin': { type: 'string' }, 'portal-origin': { type: 'string' }, 'sync-origin': { type: 'string' } },
});

function parseOrigin(value) {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use an HTTPS origin, or an HTTP loopback origin for local development.');
  }
  return url;
}

const api = parseOrigin(values['api-origin'] ?? process.env.API_ORIGIN ?? 'http://localhost:8787');
const portal = parseOrigin(values['portal-origin'] ?? process.env.PORTAL_ORIGIN ?? 'http://localhost:8788');
const sync = parseOrigin(values['sync-origin'] ?? process.env.CLERK_SYNC_ORIGIN ?? portal.origin);
const publishableKey = process.env.CLERK_PUBLISHABLE_KEY?.trim();
const key = publishableKey?.match(/^pk_(?:test|live)_([A-Za-z0-9_-]+={0,2})$/)?.[1];
const frontendHost = key && Buffer.from(key, 'base64url').toString('utf8').match(/^([a-z0-9.-]+)\$$/i)?.[1];
if (!frontendHost) throw new Error('Set CLERK_PUBLISHABLE_KEY before packaging.');

const clerk = parseOrigin(`https://${frontendHost}`);
const root = fileURLToPath(new URL('..', import.meta.url));
const temp = mkdtempSync(join(tmpdir(), 'cartscout-package-'));
try {
  cpSync(join(root, 'extension'), temp, { recursive: true });
  const path = join(temp, 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.host_permissions = [...new Set([api, portal, sync, clerk].map((url) => `${url.protocol}//${url.hostname}/*`))];
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
  const config = {
    API_ORIGIN: api.origin, PORTAL_ORIGIN: portal.origin,
    CLERK_SYNC_ORIGIN: sync.origin, CLERK_PUBLISHABLE_KEY: publishableKey,
  };
  writeFileSync(join(temp, 'config.js'), Object.entries(config).map(([name, value]) =>
    `export const ${name} = ${JSON.stringify(value)};\n`).join(''));
  const bundle = await build({
    entryPoints: [join(temp, 'popup.js'), join(temp, 'service-worker.js')],
    outdir: join(temp, 'compiled'),
    nodePaths: [join(root, 'node_modules')],
    bundle: true,
    format: 'esm',
    target: 'chrome120',
    minify: true,
    legalComments: 'eof',
    define: { 'process.env.NODE_ENV': '"production"' },
    write: false,
  });
  for (const file of bundle.outputFiles) writeFileSync(join(temp, basename(file.path)), file.contents);
  rmSync(join(temp, 'account.js'));

  const dist = join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  const local = api.protocol === 'http:' || portal.protocol === 'http:';
  const result = join(dist, `cartscout-${manifest.version}${local ? '-local' : ''}.zip`);
  rmSync(result, { force: true });
  execFileSync('zip', ['-q', '-r', '-X', result, '.', '-x', '*.DS_Store'], { cwd: temp });
  console.log(result);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
