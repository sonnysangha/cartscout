import { API_ORIGIN } from './config.js';

const status = document.querySelector('#status');
const list = document.querySelector('#coupons');
const retry = document.querySelector('#retry');
const template = document.querySelector('#coupon');
let merchant;
let token;

async function installationToken() {
  return navigator.locks.request('cartscout-installation', async () => {
    const { installToken } = await chrome.storage.local.get('installToken');
    if (installToken) return installToken;
    const generated = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, '0')).join('');
    await chrome.storage.local.set({ installToken: generated });
    return generated;
  });
}

async function api(route, fields) {
  let response;
  try {
    response = await fetch(new URL(route, API_ORIGIN), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ merchant, ...fields }),
      signal: AbortSignal.timeout(75_000),
    });
  } catch {
    throw new Error('Couldn’t reach CartScout. Try again shortly.');
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'CartScout request failed.');
  return data;
}

function render(data, savedReport) {
  const label = data.coupons.length === 1 ? '1 candidate code' : `${data.coupons.length} candidate codes`;
  const context = data.source === 'stale' ? 'Refresh unavailable. Showing previously found codes.'
    : data.partial ? 'Some coupon sources could not be checked.' : '';
  status.textContent = [
    savedReport ? 'Report saved.' : '',
    data.coupons.length ? label : 'No codes found for this shop.',
    context,
  ].filter(Boolean).join(' ');
  list.replaceChildren();
  for (const coupon of data.coupons) {
    const row = template.content.firstElementChild.cloneNode(true);
    row.querySelector('.code').textContent = coupon.code;
    row.querySelector('.offer').textContent = coupon.offer;
    row.querySelector('.counts').textContent = coupon.worked || coupon.failed
      ? `${coupon.worked} worked · ${coupon.failed} failed` : 'No recent reports';
    const source = row.querySelector('.source');
    if (coupon.sources[0]) source.href = coupon.sources[0];
    else source.hidden = true;

    const copy = row.querySelector('.copy');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(coupon.code);
        copy.textContent = 'Copied';
      } catch {
        status.textContent = 'Couldn’t copy. You can select the code above.';
      }
    });

    const votes = [row.querySelector('.worked'), row.querySelector('.failed')];
    votes.forEach((button, index) => {
      const worked = index === 0;
      button.setAttribute('aria-pressed', String(coupon.myReport === Number(worked)));
      button.addEventListener('click', async () => {
        const allVotes = list.querySelectorAll('.votes button');
        allVotes.forEach((vote) => { vote.disabled = true; });
        try {
          render(await api('/v1/reports', { code: coupon.code, worked }), true);
          const refreshedRow = Array.from(list.children).find((item) => item.querySelector('.code').textContent === coupon.code);
          refreshedRow?.querySelector(worked ? '.worked' : '.failed')?.focus();
        } catch (error) {
          status.textContent = error.message;
          allVotes.forEach((vote) => { vote.disabled = false; });
        }
      });
    });
    list.append(row);
  }
}

async function loadCoupons() {
  retry.hidden = true;
  status.textContent = 'Looking for coupon codes…';
  try {
    render(await api('/v1/coupons'));
  } catch (error) {
    status.textContent = error.message;
    retry.hidden = false;
  }
}

retry.addEventListener('click', loadCoupons);

try {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ? new URL(tab.url) : null;
  if (!url || !['https:', 'http:'].includes(url.protocol)) {
    status.textContent = 'Open a shop in the current tab to find coupon codes.';
  } else {
    merchant = url.hostname.replace(/^www\./, '');
    document.querySelector('#merchant').textContent = merchant;
    token = await installationToken();
    await loadCoupons();
  }
} catch {
  status.textContent = 'Couldn’t read the current shop. Reopen CartScout to retry.';
}
