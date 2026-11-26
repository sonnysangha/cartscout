import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
const source = join(temp, 'source');
const out = join(temp, 'package');
const STATIC_FILES = /\.(?:html|css)$/;
const STATIC_FOLDERS = ['fonts', 'icons'];

// Classic self-contained scripts injected into the shop's page; run.js names the same files.
const INJECTED = [
  { entry: join('panel', 'panel.js'), file: 'panel.js', globalName: 'CartScoutPanel', loader: { '.css': 'text', '.woff2': 'binary' } },
  { entry: join('autotry', 'page.js'), file: 'autotry.js', globalName: 'CartScoutAutoTry', warnAt: 80_000, failAt: 110_000 },
];

/** Fail the build if a bundle still asks for a module at run time: every import must be inside the bundle. */
function assertSelfContained(result, name) {
  for (const [file, output] of Object.entries(result.metafile.outputs)) {
    const loose = output.imports.filter((entry) => entry.external).map((entry) => entry.path);
    if (loose.length) throw new Error(`${name}: ${basename(file)} still imports ${loose.join(', ')} at run time.`);
  }
}

try {
  cpSync(join(root, 'extension'), source, { recursive: true });
  mkdirSync(out);

  const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
  manifest.host_permissions = [...new Set([api, portal, sync, clerk].map((url) => `${url.protocol}//${url.hostname}/*`))];
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const config = {
    API_ORIGIN: api.origin, PORTAL_ORIGIN: portal.origin,
    CLERK_SYNC_ORIGIN: sync.origin, CLERK_PUBLISHABLE_KEY: publishableKey,
  };
  writeFileSync(join(source, 'config.js'), Object.entries(config).map(([name, value]) =>
    `export const ${name} = ${JSON.stringify(value)};\n`).join(''));

  for (const name of readdirSync(source)) {
    if (STATIC_FILES.test(name)) cpSync(join(source, name), join(out, name));
  }
  for (const folder of STATIC_FOLDERS) {
    cpSync(join(source, folder), join(out, folder), { recursive: true, filter: (path) => basename(path) !== '.DS_Store' });
  }

  const modules = new Set([manifest.background.service_worker]);
  const pages = readdirSync(out).filter((name) => name.endsWith('.html'));
  const local = (reference) => !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(reference);
  for (const page of pages) {
    const html = readFileSync(join(out, page), 'utf8');
    for (const [, reference] of html.matchAll(/<script\b[^>]*\bsrc="([^"#?]+)[^"]*"/g)) {
      if (local(reference)) modules.add(reference);
    }
  }
  for (const entry of modules) {
    if (!existsSync(join(source, entry))) throw new Error(`${entry} is loaded by the extension but is not in extension/.`);
  }
  const bundle = await build({
    entryPoints: [...modules].map((entry) => join(source, entry)),
    outdir: out,
    outbase: source,
    nodePaths: [join(root, 'node_modules')],
    bundle: true,
    format: 'esm',
    target: 'chrome120',
    minify: true,
    legalComments: 'eof',
    define: { 'process.env.NODE_ENV': '"production"' },
    metafile: true,
  });
  assertSelfContained(bundle, 'Extension modules');

  for (const spec of INJECTED) {
    const built = await build({
      entryPoints: [join(source, spec.entry)],
      outfile: join(out, spec.file),
      bundle: true,
      format: 'iife',
      globalName: spec.globalName,
      target: 'chrome120',
      minify: true,
      legalComments: 'eof',
      ...(spec.loader && { loader: spec.loader }),
      metafile: true,
    });
    assertSelfContained(built, spec.file);
    const bytes = statSync(join(out, spec.file)).size;
    if (spec.failAt && bytes > spec.failAt) {
      throw new Error(`${spec.file} is ${bytes} bytes, over the ${spec.failAt}-byte budget.`);
    }
    if (spec.warnAt && bytes > spec.warnAt) {
      console.warn(`Warning: ${spec.file} is ${bytes} bytes (budget warnAt ${spec.warnAt}).`);
    }
  }

  const needed = new Set([
    manifest.background.service_worker, manifest.action.default_popup,
    ...INJECTED.map((spec) => spec.file),
    ...Object.values(manifest.icons ?? {}), ...Object.values(manifest.action.default_icon ?? {}),
  ]);
  for (const page of pages) {
    const html = readFileSync(join(out, page), 'utf8');
    for (const [, reference] of html.matchAll(/\b(?:src|href)="([^"#?]+)[^"]*"/g)) {
      if (local(reference)) needed.add(reference);
    }
  }
  for (const file of needed) {
    if (!existsSync(join(out, file))) throw new Error(`The extension loads ${file}, which is not in the package.`);
  }

  const dist = join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  const isLocal = api.protocol === 'http:' || portal.protocol === 'http:';
  const result = join(dist, `cartscout-${manifest.version}${isLocal ? '-local' : ''}.zip`);
  rmSync(result, { force: true });
  execFileSync('zip', ['-q', '-r', '-X', result, '.', '-x', '*.DS_Store'], { cwd: out });
  console.log(result);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
