// With OXYLABS_RECORD=1 every raw answer from Oxylabs is saved as a file, so tests can be built on real answers
// in place of made-up ones. The request body is saved beside it; the API key is in a header and is never written.
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// One answer is kept up to this many characters. A longer one is cut and marked, so it is not mistaken for a whole page.
const MAX_BODY = 1_000_000;
// The folder stops growing here. Recording is for collecting fixtures, not an archive.
const MAX_FILES = 500;

export function createRecorder(folder, { maxBody = MAX_BODY, maxFiles = MAX_FILES, log = console.error } = {}) {
  let saved = null;
  let serial = 0;
  let stopped = false;

  return function record({ at, endpoint, request, status, body }) {
    if (stopped) return;
    try {
      if (saved === null) {
        mkdirSync(folder, { recursive: true });
        saved = readdirSync(folder).filter((name) => name.endsWith('.json')).length;
      }
      if (saved >= maxFiles) {
        stopped = true;
        log(`Oxylabs recording has stopped: ${folder} already holds ${saved} answers.`);
        return;
      }
      const truncated = body.length > maxBody;
      let parsed;
      if (!truncated) {
        try {
          parsed = JSON.parse(body);
        } catch {
          // An error page is kept as the text it was.
        }
      }
      let target = 'search';
      try {
        if (request.url) target = new URL(request.url).hostname;
      } catch {
        target = 'page';
      }
      serial += 1;
      const name = `${new Date(at).toISOString().replace(/[:.]/g, '-')}-${String(serial).padStart(4, '0')}-${endpoint}-${target.replace(/[^a-z0-9.-]/gi, '_').slice(0, 80)}.json`;
      writeFileSync(join(folder, name), `${JSON.stringify({
        recordedAt: new Date(at).toISOString(), endpoint, request, status, characters: body.length, truncated,
        body: parsed ?? body.slice(0, maxBody),
      }, null, 2)}\n`, { flag: 'wx' });
      saved += 1;
    } catch (error) {
      // A recording that cannot be written must never fail the scan it was recording.
      log('Oxylabs recording failed:', error.message);
    }
  };
}
