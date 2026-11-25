import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [, , option, value] = process.argv;
if (option && (option !== '--api-origin' || !value || process.argv.length !== 4)) {
  throw new Error('Usage: npm run package:extension -- [--api-origin https://api.example.com]');
}

const url = new URL(value ?? 'http://localhost:8787');
const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))
  || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
  throw new Error('Use an HTTPS API origin, or an HTTP loopback origin for local development.');
}

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = mkdtempSync(join(tmpdir(), 'cartscout-package-'));
try {
  cpSync(join(root, 'extension'), temp, { recursive: true });
  const path = join(temp, 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.host_permissions = [`${url.protocol}//${url.hostname}/*`];
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(temp, 'config.js'), `export const API_ORIGIN = ${JSON.stringify(url.origin)};\n`);

  const dist = join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  const result = join(dist, `cartscout-${manifest.version}${loopback ? '-local' : ''}.zip`);
  rmSync(result, { force: true });
  execFileSync('zip', ['-q', '-r', '-X', result, '.', '-x', '*.DS_Store'], { cwd: temp });
  console.log(result);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
