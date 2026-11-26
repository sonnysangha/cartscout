import assert from 'node:assert/strict';
import test from 'node:test';
import { HANDOVER_MS, handedHost, popupHandover } from '../extension/handover.js';

const NOW = Date.parse('2026-11-26T09:00:00Z');

test('the worker leaves the shop of the page whose notice was pressed', () => {
  assert.deepEqual(popupHandover(7, 'https://www.LookFantastic.com/offers/?x=1#top', NOW), { tabId: 7, host: 'www.lookfantastic.com', at: NOW });
  // Nothing is left for pages that are not public sites, or when Chrome names no page.
  for (const address of ['chrome://extensions/', 'chrome-extension://abc/popup.html', 'http://localhost:8788/', 'https://192.168.0.4/', 'about:blank', '', undefined]) {
    assert.equal(popupHandover(7, address, NOW), null, String(address));
  }
  assert.equal(popupHandover(undefined, 'https://www.myprotein.com/', NOW), null);
});

test('a popup takes the note only for its own tab and only straight away', () => {
  const note = popupHandover(7, 'https://www.myprotein.com/basket/', NOW);
  assert.equal(handedHost(note, 7, NOW + 400), 'www.myprotein.com');
  assert.equal(handedHost(note, 8, NOW + 400), '');
  assert.equal(handedHost(note, 7, NOW + HANDOVER_MS + 1), '');
  assert.equal(handedHost(note, 7, NOW - 5_000), '');
  assert.equal(handedHost(undefined, 7, NOW), '');
  assert.equal(handedHost({ tabId: 7, host: 'not a host', at: NOW }, 7, NOW), '');
  assert.equal(handedHost({ tabId: 7, host: 'www.myprotein.com' }, 7, NOW), '');
});
