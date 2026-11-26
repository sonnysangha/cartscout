// Shared by the tests of the Oxylabs spend controls: an API whose clock the test sets, and an Oxylabs that is a
// function, so no test ever sends a real request.
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createCouponServer } from '../index.js';
import { openStore } from '../store.js';

/** A saved Oxylabs answer in the documented response format, from server/fixtures/oxylabs. */
export const fixture = (name) => JSON.parse(readFileSync(new URL(`./oxylabs/${name}.json`, import.meta.url), 'utf8'));

export const members = {
  'free-a': { userId: 'user_alex', plan: 'free' },
  'free-b': { userId: 'user_bailey', plan: 'free' },
  'pro-c': { userId: 'user_casey', plan: 'pro' },
  'pro-d': { userId: 'user_devon', plan: 'pro' },
};

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

/**
 * Stands in for Oxylabs. `answer` is given each request ({ endpoint, ...body }) and returns the `results` of a done
 * answer, a whole Response, or throws. `sent` lists every request that reached it, in order.
 */
export function fakeOxylabs(answer) {
  const sent = [];
  const request = async (address, { body, headers }) => {
    const call = { endpoint: address.slice(address.indexOf('/v1/') + 4), ...JSON.parse(body) };
    sent.push({ ...call, authorization: headers.Authorization });
    const reply = await answer(call);
    return reply instanceof Response ? reply : Response.json({ state: 'done', results: reply });
  };
  return { request, sent };
}

/** A page as /v1/scrape returns it: every output that was not asked for is null. */
export const page = (fields) => [{ html: null, markdown: null, screenshot: null, json: null, ...fields }];

export async function startApi(t, { store = openStore(':memory:'), clock = { now: Date.parse('2026-11-23T12:00:00Z') }, ...options } = {}) {
  const server = createCouponServer({
    store, now: () => clock.now, log: () => {},
    authenticate: async (token) => (Object.hasOwn(members, token) ? members[token] : null),
    ...options,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let open = true;
  const close = async () => {
    if (!open) return;
    open = false;
    await new Promise((resolve) => server.close(resolve));
  };
  t.after(async () => {
    await close();
    try {
      store.close();
    } catch {
      // The test closed it already.
    }
  });
  return {
    clock, store, close,
    async call(route, token, body) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/${route}`, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${token}`, ...(body && { 'Content-Type': 'application/json' }) },
        ...(body && { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}
