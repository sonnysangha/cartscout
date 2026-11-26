'use client';

import React, { Component, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ClerkFailed, ClerkProvider, PricingTable, SignIn, SignUp, UserButton, UserProfile, useAuth, useClerk, useSession, useUser,
} from '@clerk/nextjs';
// Clerk Billing's buttons and plan data are a public beta, which is why @clerk/react is pinned to an exact version.
import { CheckoutButton, SubscriptionDetailsButton, usePlans } from '@clerk/nextjs/experimental';
import { useConvexAuth, useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { celebrate, stopConfetti } from '@/extension/confetti.js';
import { dealIn, drawSwipe, stickOn } from '@/extension/motion.js';
import { Scout } from './Scout';
import { BackArrow, ScanArt, ShopArt, Tick, ToolbarArt } from './art';
import { OxylabsSimulator } from './OxylabsSimulator';

const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || '';
const hasConvex = Boolean(process.env.NEXT_PUBLIC_CONVEX_URL);
const testMode = publishableKey?.startsWith('pk_test_') ?? false;
// The Clerk plan slug that means Pro. The API reads the same slug from CLERK_PRO_PLAN.
const PRO_PLAN = process.env.NEXT_PUBLIC_CLERK_PRO_PLAN || 'pro';
const API_ORIGIN = (process.env.NEXT_PUBLIC_API_ORIGIN || '').replace(/\/$/, '');

// The extension opens /?intent=<intent>. The first name in each list is the one this portal writes.
const VIEWS = {
  signin: ['signin', 'sign-in', 'home'],
  signup: ['signup', 'sign-up'],
  billing: ['plans', 'billing', 'upgrade'],
  account: ['account', 'manage'],
  demo: ['demo', 'simulator', 'how-it-works'],
};
// What the popup sends for "sort out my plan": the plans for a Free member, billing management for a Pro member.
const PLAN_INTENTS = ['billing', 'upgrade'];

const hrefFor = (view) => `/?intent=${VIEWS[view][0]}`;
// Clerk's profile routes by hash, so this opens the account view on its Billing tab.
const BILLING_HASH = '#/billing';
const NEXT_STEP = 'Go back to your shop tab and click the CartScout icon.';
// The repository this code lives in. There is no support inbox, so questions go where the project is public.
const ISSUES_URL = 'https://github.com/sonnysangha/cartscout/issues';

function viewFor(value, fallback = 'signin') {
  const found = Object.keys(VIEWS).find((view) => VIEWS[view].includes(value));
  return found ?? fallback;
}

function readRoute() {
  const params = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
  const asked = params.get('intent');
  const intent = viewFor(asked);
  // Where to land once signed in: sign-up carries the real destination in `next`.
  const wanted = intent === 'signup' ? params.get('next') : asked;
  const destination = viewFor(wanted) === 'signup' ? 'signin' : viewFor(wanted);
  return {
    intent,
    destination,
    // The name the visitor arrived with, kept through sign-in so "billing" still means billing afterwards.
    entry: VIEWS[destination].includes(wanted) ? wanted : VIEWS[destination][0],
    forPlan: PLAN_INTENTS.includes(wanted),
    checkoutComplete: params.get('checkout') === 'complete',
  };
}

function useRoute() {
  const [route, setRoute] = useState(readRoute);
  const sync = useCallback(() => setRoute(readRoute()), []);
  useEffect(() => {
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, [sync]);
  const go = useCallback((view, hash = '') => {
    window.history.pushState(null, '', hrefFor(view) + hash);
    sync();
    window.scrollTo(0, 0);
  }, [sync]);
  const replace = useCallback((href) => {
    window.history.replaceState(null, '', href);
    sync();
  }, [sync]);
  return { route, go, replace, sync };
}

/** A real link that changes view without reloading, so nothing flashes or shifts between screens. */
function ViewLink({ to, hash = '', go, className, current, label, children }) {
  const onClick = (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    go(to, hash);
  };
  return (
    <a className={className} href={hrefFor(to) + hash} onClick={onClick} aria-current={current ? 'page' : undefined} aria-label={label}>
      {children}
    </a>
  );
}

/** Arrival: the hero lands like a sticker, the highlighter draws once and the content deals in. */
function useArrival() {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const hero = root.querySelector('[data-stick]');
    if (hero) stickOn(hero);
    root.querySelectorAll('.swipe').forEach((mark) => drawSwipe(mark, { delay: 240 }));
    dealIn(root.querySelectorAll('[data-deal]'), { delay: 60 });
  }, []);
  return ref;
}

function useTitle(title) {
  useEffect(() => { document.title = `${title} · CartScout`; }, [title]);
}

function Header({ signedIn = false, pro = false, view, go, mood = 'idle' }) {
  const mark = <><Scout tile mood={mood} /><span className="wordmark">CartScout</span></>;
  return (
    <header className="site-header">
      <div className="wrap header-row">
        {go
          ? <ViewLink className="brand" to="signin" go={go} label={signedIn ? 'CartScout home' : undefined}>{mark}</ViewLink>
          : <a className="brand" href="/">{mark}</a>}
        <nav className="account-nav" aria-label="Primary">
          {signedIn ? (
            <>
              <ViewLink className="nav-link nav-home" to="signin" go={go} current={view === 'signin'}>Home</ViewLink>
              <ViewLink className="nav-link nav-demo" to="demo" go={go} current={view === 'demo'}>Oxylabs Simulator</ViewLink>
              {!pro && <ViewLink className="nav-link" to="billing" go={go} current={view === 'billing'}>Plans</ViewLink>}
              {!pro && <ViewLink className="nav-link" to="account" go={go} current={view === 'account'}>Account</ViewLink>}
              <ViewLink
                className="plan-badge"
                to={pro ? 'account' : 'billing'}
                hash={pro ? BILLING_HASH : ''}
                go={go}
                label={pro ? 'CartScout Pro — manage billing' : 'Free plan — upgrade to Pro'}
              >
                <span className="plan-badge-pill" data-plan={pro ? 'pro' : 'free'}>
                  {pro ? 'Pro' : 'Free'}
                </span>
              </ViewLink>
              {/* "Manage account" in the menu opens the Account view, not a second copy of it in a dialog. */}
              <span className="avatar-slot"><UserButton userProfileMode="navigation" userProfileUrl={hrefFor('account')} /></span>
            </>
          ) : go ? (
            <>
              <ViewLink className="nav-link nav-demo" to="demo" go={go} current={view === 'demo'}>Oxylabs Simulator</ViewLink>
              {view === 'demo' ? <ViewLink className="nav-link" to="signin" go={go}>Sign in</ViewLink> : null}
            </>
          ) : null}
        </nav>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="site-footer">
      <p className="wrap">Scout looks for public promo codes. Whether a code works is up to the shop.</p>
    </footer>
  );
}

/** A centred message with a large Scout: setup and failure states. */
function Notice({ mood, title, children }) {
  return (
    <main className="view notice-view">
      <Scout mood={mood} size="7.5rem" />
      <h1>{title}</h1>
      {children}
    </main>
  );
}

/** Tells its parent that Clerk has drawn it. Used inside <ClerkFailed>, which renders only once Clerk has given up. */
function Signal({ onShow }) {
  useEffect(() => { onShow(); }, [onShow]);
  return null;
}

const SLOW_AFTER_MS = 9000;
const FAILED_AFTER_MS = 15000;
// Clerk retries its own script a few times. Three misses in a row means it is blocked or the connection is down.
const SCRIPT_MISSES = 3;
const SLOW_TEXT = 'This is taking longer than usual. You can keep waiting or reload the page.';
const FAILED_TEXT = 'The sign-in service didn’t load. Check your connection, then try again.';

/** How the wait for Clerk is going: loading, then slow, then failed. Never waits for ever. */
function useWait(isLoaded) {
  const [stage, setStage] = useState('loading');
  const fail = useCallback(() => setStage('failed'), []);
  useEffect(() => {
    if (isLoaded) return undefined;
    const slow = setTimeout(() => setStage((now) => (now === 'loading' ? 'slow' : now)), SLOW_AFTER_MS);
    const failed = setTimeout(fail, FAILED_AFTER_MS);
    // The browser says at once when Clerk's script cannot be fetched; the timer above is only the backstop.
    let misses = 0;
    const missed = (event) => {
      const node = event.target;
      if (node?.tagName !== 'SCRIPT' || !node.hasAttribute('data-clerk-publishable-key')) return;
      misses += 1;
      if (misses >= SCRIPT_MISSES) fail();
    };
    // A script's load error does not bubble, so it is caught on the way down.
    window.addEventListener('error', missed, true);
    window.addEventListener('offline', fail);
    return () => {
      clearTimeout(slow);
      clearTimeout(failed);
      window.removeEventListener('error', missed, true);
      window.removeEventListener('offline', fail);
    };
  }, [isLoaded, fail]);
  return { stage, fail };
}

/** Loading and "couldn't load" share one grid cell, so the box is the same in both and the change moves nothing. */
function Waiting({ stage, onFailed }) {
  const failed = stage === 'failed';
  const slow = stage === 'slow';
  const reload = () => window.location.reload();
  useTitle(failed ? 'Couldn’t reach sign-in' : 'Fetching your account');
  return (
    <main className="view notice-view" aria-busy={failed ? undefined : true}>
      <Scout mood={failed ? 'oops' : 'search'} size="7.5rem" />
      <div className="swap">
        <div className="swap-side" aria-hidden={failed || undefined} inert={failed || undefined}>
          <h1>Fetching your account</h1>
          {/* The slow message and its button keep their space from the start, so showing them moves nothing. */}
          <p className="lede slow-line">{slow ? SLOW_TEXT : ''}</p>
          <button className="secondary slow-action" type="button" hidden={!slow} onClick={reload}>Reload page</button>
        </div>
        <div className="swap-side" aria-hidden={!failed || undefined} inert={!failed || undefined}>
          <h1>Scout couldn’t reach sign-in</h1>
          <p className="lede">{FAILED_TEXT}</p>
          <button className="primary" type="button" onClick={reload}>Try again</button>
        </div>
      </div>
      <p className="visually-hidden" role="status">{failed ? '' : slow ? SLOW_TEXT : 'Fetching your account'}</p>
      <p className="visually-hidden" role="alert">{failed ? `Scout couldn’t reach sign-in. ${FAILED_TEXT}` : ''}</p>
      <ClerkFailed><Signal onShow={onFailed} /></ClerkFailed>
    </main>
  );
}

/**
 * Keeps the final box of a Clerk component from the first paint and shows a skeleton in it until Clerk has drawn.
 * Clerk titles its cards with an h1; the page already has one, so those are exposed one level down.
 */
function Reserve({ kind, step, label, waiting, named = true, skeleton, children }) {
  const live = useRef(null);
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const node = live.current;
    const read = () => {
      node.querySelectorAll('h1:not([aria-level])').forEach((heading) => {
        heading.setAttribute('role', 'heading');
        heading.setAttribute('aria-level', '2');
      });
      setDrawn(node.querySelector('.cl-cardBox, .cl-pricingTableCard') !== null);
    };
    const observer = new MutationObserver(read);
    observer.observe(node, { childList: true, subtree: true });
    read();
    return () => observer.disconnect();
  }, []);
  return (
    <div className={`reserve reserve-${kind}`} data-step={step}>
      {/* The wait has a name, drawn inside the box it is waiting for, so it comes and goes without moving anything. */}
      <div className="skeleton" aria-hidden="true">
        {named ? <span className="skeleton-name">{waiting}</span> : null}
        {skeleton}
      </div>
      <div className="reserve-live" ref={live} role="group" aria-label={label}>{children}</div>
      <p className="visually-hidden" role="status">{drawn ? '' : waiting}</p>
    </div>
  );
}

const AuthSkeleton = (
  <>
    <span className="bone bone-title" />
    <span className="bone bone-text" />
    <span className="bone bone-field" />
    <span className="bone bone-rule" />
    <span className="bone bone-label" />
    <span className="bone bone-field" />
    <span className="bone bone-field" />
  </>
);
const PlansSkeleton = (
  <>
    {[0, 1].map((index) => (
      <span className="bone-plan" key={index}>
        <span className="bone bone-title" />
        <span className="bone bone-price" />
        <span className="bone bone-text" />
        <span className="bone bone-field" />
      </span>
    ))}
  </>
);
const ProfileSkeleton = (
  <>
    <span className="bone-side">
      <span className="bone bone-title" />
      <span className="bone bone-text" />
      <span className="bone bone-text" />
    </span>
    <span className="bone-main">
      <span className="bone bone-title" />
      <span className="bone bone-field" />
      <span className="bone bone-field" />
      <span className="bone bone-field" />
    </span>
  </>
);

const BENEFITS = [
  'Scan any online shop for public promo codes.',
  'Let Scout try them at checkout and keep the biggest saving.',
  'Pro unlocks a live feed of working codes & savings from other members.',
];

// Synthetic placeholders rendered behind the blur for Free accounts.
// Real codes, shops, usernames, and savings are NEVER sent by the API or placed in the DOM for Free members.
const LOCKED_PLACEHOLDERS = [
  { id: 'p1', shop: 'example-shop.co.uk', code: 'SAVE15NOW', offer: '15% off your order', member: '@alex_m', saving: 'Saved £14.20', when: '3m ago' },
  { id: 'p2', shop: 'wellness-store.com', code: 'CHECKOUT20', offer: 'Extra 20% off basket', member: '@sam_k', saving: 'Saved £8.50', when: '18m ago' },
  { id: 'p3', shop: 'outdoor-gear.co.uk', code: 'EXTRA10UK', offer: '10% off first order', member: '@jordan_d', saving: 'Saved £19.00', when: '1h ago' },
  { id: 'p4', shop: 'beauty-outlet.com', code: 'MEMBER12', offer: '12% off selected lines', member: '@taylor_s', saving: 'Saved £6.40', when: '2h ago' },
];

const RANDOM_HANDLES = [
  '@olivia_k', '@liam_p', '@priya_s', '@noah_j', '@emma_r', '@harry_w',
  '@sophie_t', '@oscar_b', '@mia_h', '@jack_d', '@ava_c', '@leo_m',
];

function displayHandle(raw, seed = '') {
  const clean = String(raw || '').trim();
  if (clean && !/^@?member(?:_[a-f0-9]+)?$/i.test(clean)) return clean.startsWith('@') ? clean : `@${clean}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return RANDOM_HANDLES[hash % RANDOM_HANDLES.length];
}

function formatSaving(amount, currency) {
  if (!Number.isFinite(amount) || amount <= 0) return '';
  try {
    return `Saved ${new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency: currency || 'GBP',
      currencyDisplay: 'narrowSymbol',
    }).format(amount)}`;
  } catch {
    return `Saved ${amount.toFixed(2)} ${currency || ''}`.trim();
  }
}

function relativeTime(timestamp) {
  if (!Number.isFinite(timestamp)) return '';
  const mins = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (mins < 2) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return days === 1 ? 'Yesterday' : `${days}d ago`;
}

function memberInitial(handle) {
  const clean = String(handle || '').replace(/^@/, '').trim();
  return (clean[0] || 'M').toUpperCase();
}

/** A long code steps down a size on the stub instead of wrapping or losing its end. */
function codeSize(code) {
  const length = String(code || '').length;
  return length <= 10 ? undefined : length <= 13 ? '2' : '3';
}

/** Subscribes to Convex's Clerk-authenticated real-time pulse so RecentWins updates live without refreshing. */
function useLiveWinsPulse() {
  const { isAuthenticated } = useConvexAuth();
  return useQuery(api.wins.feedPulse, isAuthenticated ? {} : 'skip');
}

function RecentWins({ pro, go }) {
  const { getToken } = useAuth();
  const pulse = hasConvex ? useLiveWinsPulse() : null;
  const [state, setState] = useState({ loading: true, wins: [], count: 0, error: false });
  const [copied, setCopied] = useState('');
  const [currencyFilter, setCurrencyFilter] = useState('all');
  const [sortBy, setSortBy] = useState('recent');
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const token = await getToken();
        if (!token || cancelled) return;
        const response = await fetch(`${API_ORIGIN}/v1/wins`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) throw new Error('bad status');
        const data = await response.json();
        if (cancelled) return;
        setState({
          loading: false,
          wins: Array.isArray(data.wins) ? data.wins : [],
          count: Number(data.count) || 0,
          error: false,
        });
      } catch {
        if (!cancelled) setState((prev) => ({ ...prev, loading: false, error: true }));
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [pro, getToken, pulse?.count, pulse?.latestAt]);

  const copyCode = async (key, code) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(key);
      setTimeout(() => setCopied((cur) => (cur === key ? '' : cur)), 1400);
    } catch {
      // Clipboard unavailable.
    }
  };

  const currencies = [...new Set(state.wins.map((w) => w.savedCurrency).filter(Boolean))];
  const needle = query.trim().toLowerCase();
  const filteredWins = state.wins
    .filter((win) => currencyFilter === 'all' || win.savedCurrency === currencyFilter)
    .filter((win) => !needle || win.merchant.toLowerCase().includes(needle) || win.code.toLowerCase().includes(needle) || (win.offer || '').toLowerCase().includes(needle))
    .slice()
    .sort((a, b) => (sortBy === 'saving'
      ? (Number(b.savedAmount) || 0) - (Number(a.savedAmount) || 0)
      : (Number(b.reportedAt) || 0) - (Number(a.reportedAt) || 0)));

  const currencyLabel = (code) => ({ GBP: '🇬🇧 UK (£)', USD: '🇺🇸 US ($)', EUR: '🇪🇺 EU (€)' }[code] || code);
  const hasActiveFilter = currencyFilter !== 'all' || sortBy !== 'recent' || needle.length > 0;

  return (
    <section className="wins" aria-labelledby="wins-title" data-deal>
      <div className="wins-head">
        <div className="wins-title-row">
          <h2 id="wins-title">Recent coupons used by members</h2>
          <span className="wins-badge">PRO</span>
        </div>
        <p className="wins-lede">
          {pro
            ? 'Working codes recently applied at checkout by Pro members. Click any ticket to copy.'
            : 'See which codes Pro members just used at checkout and how much they saved.'}
        </p>
      </div>

      {pro && !state.loading && !state.error && state.wins.length > 0 ? (
        <div className="filter-bar" role="region" aria-label="Filter recent coupons">
          <div className="filter-group" role="group" aria-label="Currency">
            <button
              type="button"
              className="filter-chip"
              aria-pressed={currencyFilter === 'all'}
              onClick={() => setCurrencyFilter('all')}
            >
              All <span className="filter-count">{state.wins.length}</span>
            </button>
            {currencies.map((cur) => (
              <button
                key={cur}
                type="button"
                className="filter-chip"
                aria-pressed={currencyFilter === cur}
                onClick={() => setCurrencyFilter((prev) => (prev === cur ? 'all' : cur))}
              >
                {currencyLabel(cur)}
              </button>
            ))}
          </div>
          <div className="filter-tools">
            <div className="filter-group" role="group" aria-label="Sort coupons">
              <button
                type="button"
                className="filter-chip"
                aria-pressed={sortBy === 'recent'}
                onClick={() => setSortBy('recent')}
              >
                Newest
              </button>
              <button
                type="button"
                className="filter-chip"
                aria-pressed={sortBy === 'saving'}
                onClick={() => setSortBy('saving')}
              >
                Biggest saving
              </button>
            </div>
            <input
              type="search"
              className="filter-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter shops or codes…"
              aria-label="Filter recent coupons by shop or code"
            />
          </div>
        </div>
      ) : null}

      {!pro ? (
        <div className="wins-locked">
          <ul className="wins-grid wins-blurred" aria-hidden="true">
            {LOCKED_PLACEHOLDERS.map((item) => (
              <li key={item.id} className="win-ticket">
                <div className="win-ticket-body">
                  <div className="win-meta-top">
                    <span className="win-site">{item.shop}</span>
                    <span className="win-when">{item.when}</span>
                  </div>
                  <p className="win-offer">{item.offer}</p>
                  <div className="win-member">
                    <span className="win-avatar">{memberInitial(item.member)}</span>
                    <span className="win-handle">{item.member}</span>
                  </div>
                </div>
                <div className="win-ticket-stub">
                  <span className="win-stub-face win-stub-default">
                    <span className="win-stub-top">
                      <span className="win-code" data-size={codeSize(item.code)}>{item.code}</span>
                    </span>
                    <span className="win-stub-bottom">
                      <span className="win-saved">{item.saving}</span>
                    </span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
          <div className="wins-gate">
            <span className="plan-badge-pill" data-plan="pro">Pro</span>
            <h3>Unlock recent member coupons</h3>
            <p>
              {state.count > 0
                ? `${state.count} recent ${state.count === 1 ? 'code' : 'codes'} worked for Pro members. Upgrade to see the shops, codes and savings.`
                : 'Upgrade to Pro to see which codes are working right now and how much other members saved.'}
            </p>
            <ViewLink className="primary" to="billing" go={go}>Upgrade to Pro</ViewLink>
          </div>
        </div>
      ) : state.loading ? (
        <ul className="wins-grid" aria-busy="true">
          {[0, 1, 2, 3].map((idx) => (
            <li key={idx} className="win-ticket win-skeleton">
              <div className="win-ticket-body">
                <span className="bone bone-label" />
                <span className="bone bone-title" />
                <span className="bone bone-text" />
              </div>
              <div className="win-ticket-stub" />
            </li>
          ))}
        </ul>
      ) : state.error ? (
        <p className="wins-empty">Couldn’t load recent member coupons right now.</p>
      ) : !state.wins.length ? (
        <p className="wins-empty">No recent member coupons yet — try codes at checkout with CartScout and working ones will appear here.</p>
      ) : !filteredWins.length ? (
        <div className="wins-empty filter-empty">
          <span>No recent coupons match that filter.</span>
          {hasActiveFilter ? (
            <button type="button" className="filter-reset" onClick={() => { setCurrencyFilter('all'); setSortBy('recent'); setQuery(''); }}>
              Reset filters
            </button>
          ) : null}
        </div>
      ) : (
        <ul className="wins-grid">
          {filteredWins.map((win) => {
            const key = `${win.merchant}:${win.code}`;
            const saved = formatSaving(win.savedAmount, win.savedCurrency);
            const isCopied = copied === key;
            const handle = displayHandle(win.memberName, key);
            return (
              <li
                key={key}
                className="win-ticket is-interactive"
                data-copied={isCopied ? 'true' : undefined}
                role="button"
                tabIndex={0}
                aria-label={`Copy ${win.code} for ${win.merchant}`}
                onClick={() => copyCode(key, win.code)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    void copyCode(key, win.code);
                  }
                }}
              >
                <div className="win-ticket-body">
                  <div className="win-meta-top">
                    <a
                      className="win-site"
                      href={`https://${win.merchant}/`}
                      target="_blank"
                      rel="noreferrer"
                      title={`Visit ${win.merchant}`}
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => event.stopPropagation()}
                    >
                      <span>{win.merchant}</span>
                      <span className="win-arrow" aria-hidden="true">↗</span>
                    </a>
                    <span className="win-when">{relativeTime(win.reportedAt)}</span>
                  </div>
                  <p className="win-offer" title={win.offer || ''}>{win.offer || 'Verified at checkout'}</p>
                  <div className="win-member">
                    <span className="win-avatar" aria-hidden="true">{memberInitial(handle)}</span>
                    <span className="win-handle">{handle}</span>
                  </div>
                </div>
                <div className="win-ticket-stub" aria-hidden="true">
                  <span className="win-stub-face win-stub-default">
                    <span className="win-stub-top">
                      <span className="win-code" data-size={codeSize(win.code)}>{win.code}</span>
                    </span>
                    <span className="win-stub-bottom">
                      <span className="win-saved">{saved || 'Worked'}</span>
                    </span>
                  </span>
                  <span className="win-stub-face win-stub-hover">
                    <svg
                      viewBox="0 0 20 20"
                      width="18"
                      height="18"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      focusable="false"
                    >
                      <rect x="7" y="7" width="9.5" height="9.5" rx="2.5" />
                      <path d="M13 7V5.5a2 2 0 0 0-2-2H5.5a2 2 0 0 0-2 2V11a2 2 0 0 0 2 2H7" />
                    </svg>
                    <span>Copy code</span>
                  </span>
                  <span className="win-stub-face win-stub-copied">Copied!</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="visually-hidden" role="status">{copied ? `Copied ${copied.split(':').slice(1).join(':')}` : ''}</p>
    </section>
  );
}

function SignedOut({ route }) {
  const signingUp = route.intent === 'signup';
  const returnUrl = `/?intent=${route.entry}`;
  const signUpUrl = `/?intent=signup&next=${route.entry}`;
  const first = signingUp ? 'Create your account' : 'Sign in';
  const ref = useArrival();
  useTitle(first);

  let lede = `When you’re in, ${NEXT_STEP.charAt(0).toLowerCase()}${NEXT_STEP.slice(1)}`;
  if (route.destination === 'billing') lede = `${first} first. Your plan is on the next screen.`;
  if (route.destination === 'account') lede = `${first} first. Your account and billing are on the next screen.`;

  return (
    <main className="view auth-view" ref={ref}>
      <section className="hello">
        <span className="hello-sticker"><Scout sticker mood="wave" data-stick /></span>
        <h1>
          {signingUp ? 'Join in and Scout ' : 'Sign in and Scout '}
          <span className="swipe">gets to work</span>.
        </h1>
        <p className="hello-lede">{lede}</p>
        <ul className="benefits">
          {BENEFITS.map((benefit) => <li key={benefit} data-deal><Tick />{benefit}</li>)}
        </ul>
        <p className="free-line" data-deal>Free plan: 5 shop scans a week.</p>
      </section>
      <section className="auth-card">
        <Reserve kind="auth" step={signingUp ? 'signup' : 'signin'} label={first} waiting={signingUp ? 'Fetching the sign-up form…' : 'Fetching the sign-in form…'} skeleton={AuthSkeleton}>
          {signingUp
            ? <SignUp routing="hash" signInUrl={returnUrl} forceRedirectUrl={returnUrl} />
            : <SignIn routing="hash" signUpUrl={signUpUrl} forceRedirectUrl={returnUrl} signUpForceRedirectUrl={returnUrl} />}
        </Reserve>
      </section>
    </main>
  );
}

/** The portal cannot know which tab the shopper came from, so it says where to go next instead of faking a link. */
function WayBack({ children }) {
  return (
    <div className="view-foot">
      <p className="way-back"><strong>All done here?</strong> {NEXT_STEP}</p>
      {children}
    </div>
  );
}

/** How a billing question is handled here, said honestly: there is no support inbox to print. */
function BillingHelp() {
  return (
    <p className="billing-help">
      <strong>Question about a charge?</strong> Receipts and payment methods are under Account, then Billing. For anything
      else, <a href={ISSUES_URL} target="_blank" rel="noreferrer">raise it on CartScout’s GitHub page</a>. Issues there are
      public, so leave out card details.
    </p>
  );
}

const STEPS = [
  { art: <ShopArt />, title: 'Open a shop', text: 'Any online shop you’re about to buy from.' },
  { art: <ToolbarArt />, title: 'Click the CartScout icon', text: 'It sits in Chrome’s toolbar. Pin it from the Extensions menu.' },
  { art: <ScanArt />, title: 'Press Scan', text: 'Scout looks for public codes and lists the ones worth a try.' },
];

// Where each shop sells from, read off its storefront. Flags are decoration; the names are what gets read out.
const COUNTRIES = {
  GB: { flag: '🇬🇧', short: 'UK', name: 'United Kingdom', shop: 'UK' },
  DE: { flag: '🇩🇪', short: 'Germany', name: 'Germany', shop: 'German' },
  FR: { flag: '🇫🇷', short: 'France', name: 'France', shop: 'French' },
  US: { flag: '🇺🇸', short: 'US', name: 'United States', shop: 'US' },
  AE: { flag: '🇦🇪', short: 'UAE', name: 'United Arab Emirates', shop: 'UAE' },
};

// Reference exchange rates to GBP for showing an easy-to-read approximate saving in the shopper's local currency
// when a cheaper retailer prices in another currency.
const APPROX_TO_GBP = { GBP: 1, EUR: 0.84, USD: 0.78, AED: 0.212 };

function approxLocalSaving(from, to) {
  const fromRate = APPROX_TO_GBP[from.currency];
  const toRate = APPROX_TO_GBP[to.currency];
  if (!fromRate || !toRate) return null;
  const converted = (to.amount * toRate) / fromRate;
  const diff = Math.round(from.amount - converted);
  if (diff <= 0) return null;
  const formatted = new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: from.currency,
    currencyDisplay: 'narrowSymbol',
    maximumFractionDigits: 0,
  }).format(diff);
  return `~${formatted}`;
}

// Live-verified comparisons across six distinct products and categories. `from` is the storefront the shopper was
// looking at, `to` is where Scout found it lower. Same-currency deals show the exact saving; cross-currency deals
// convert to an approximate saving in the shopper's local (`from`) currency so it's immediately clear.
const PRICE_WINS = [
  {
    id: 'xm5-uk',
    product: 'Sony WH-1000XM5',
    variant: 'Black · Noise-cancelling headphones',
    from: { shop: 'sony.co.uk', country: 'GB', amount: 299, currency: 'GBP', price: '£299.00' },
    to: { shop: 'johnlewis.com', country: 'GB', amount: 179.1, currency: 'GBP', price: '£179.10' },
    save: '£119.90',
    href: 'https://www.johnlewis.com/sony-wh-1000xm5-noise-cancelling-wireless-bluetooth-high-resolution-audio-over-ear-headphones-with-mic-remote/black/p6229813',
  },
  {
    id: 'dyson-airwrap-de',
    product: 'Dyson Airwrap Origin',
    variant: 'Prussian Blue & Copper · Multi-styler',
    from: { shop: 'dyson.de', country: 'DE', amount: 449, currency: 'EUR', price: '€449.00' },
    to: { shop: 'mediamarkt.de', country: 'DE', amount: 274, currency: 'EUR', price: '€274.00' },
    save: '€175.00',
    href: 'https://www.mediamarkt.de/de/product/_dyson-airwrap-origin-tm-multi-haarstyler-und-trockner-nachtblaukupfer-haarstyler-3065980.html',
  },
  {
    id: 'lego-falcon-uk',
    product: 'LEGO Millennium Falcon 75375',
    variant: '25th Anniversary · 921 pieces',
    from: { shop: 'lego.com', country: 'GB', amount: 74.99, currency: 'GBP', price: '£74.99' },
    to: { shop: 'smythstoys.com', country: 'GB', amount: 51.99, currency: 'GBP', price: '£51.99' },
    save: '£23.00',
    href: 'https://www.smythstoys.com/uk/en-gb/toys/lego-and-bricks/lego-star-wars/lego-star-wars-75375-millennium-falcon-25th-anniversary-model-set-for-adults/p/232325',
  },
  {
    id: 'switch-oled-gb-de',
    product: 'Nintendo Switch (OLED Model)',
    variant: 'White · 64GB Console',
    from: { shop: 'amazon.co.uk', country: 'GB', amount: 314.98, currency: 'GBP', price: '£314.98' },
    to: { shop: 'saturn.de', country: 'DE', amount: 327.99, currency: 'EUR', price: '€327.99' },
    href: 'https://www.saturn.de/de/product/_nintendo-switch-oled-modell-weiss-2749170.html',
  },
  {
    id: 'garmin-265-gb-fr',
    product: 'Garmin Forerunner 265',
    variant: 'Black · 46mm GPS Running Watch',
    from: { shop: 'johnlewis.com', country: 'GB', amount: 259.99, currency: 'GBP', price: '£259.99' },
    to: { shop: 'decathlon.fr', country: 'FR', amount: 269.99, currency: 'EUR', price: '€269.99' },
    href: 'https://www.decathlon.fr/p/garmin-forerunner-265/380399/m8998308',
  },
  {
    id: 'mx-master-3s-uk',
    product: 'Logitech MX Master 3S',
    variant: 'Graphite · Wireless Performance Mouse',
    from: { shop: 'dealmonday.co.uk', country: 'GB', amount: 119.99, currency: 'GBP', price: '£119.99' },
    to: { shop: 'amazon.co.uk', country: 'GB', amount: 76.49, currency: 'GBP', price: '£76.49' },
    save: '£43.50',
    href: 'https://www.amazon.co.uk/Logitech-Master-Performance-Ultra-fast-Scrolling/dp/B07W5JKHFZ',
  },
];

function Flag({ code, className = 'price-flag' }) {
  return <span className={className} aria-hidden="true">{COUNTRIES[code].flag}</span>;
}

/** Same country: one big flag. Cross-border: both flags, with the route drawn between them. */
function DealRoute({ from, to, cross }) {
  return (
    <span className="price-route" aria-hidden="true">
      <Flag code={from.country} />
      {cross ? (
        <>
          <svg className="price-route-line" viewBox="0 0 28 12" width="28" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" focusable="false">
            <path d="M2 6h19" strokeDasharray="2 3.5" />
            <path d="M20 2l5 4-5 4" />
          </svg>
          <Flag code={to.country} />
        </>
      ) : null}
    </span>
  );
}

function PriceComparisons() {
  const [scope, setScope] = useState('all');
  const [countryFilter, setCountryFilter] = useState('all');

  const sameCount = PRICE_WINS.filter((d) => d.from.country === d.to.country).length;
  const crossCount = PRICE_WINS.length - sameCount;
  const availableCountries = [...new Set(PRICE_WINS.flatMap((d) => [d.from.country, d.to.country]))];

  const filtered = PRICE_WINS.filter((deal) => {
    const cross = deal.from.country !== deal.to.country;
    if (scope === 'same' && cross) return false;
    if (scope === 'cross' && !cross) return false;
    if (countryFilter !== 'all' && deal.from.country !== countryFilter && deal.to.country !== countryFilter) return false;
    return true;
  });

  return (
    <section className="price-wins" aria-labelledby="price-wins-title" data-deal>
      <div className="wins-head">
        <h2 id="price-wins-title">Found cheaper at other retailers</h2>
        <p className="wins-lede">Scout also checks the same product at other shops, at home and across borders.</p>
      </div>

      <div className="filter-bar" role="region" aria-label="Filter retailer price comparisons">
        <div className="filter-group" role="group" aria-label="Deal scope">
          <button type="button" className="filter-chip" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>
            All <span className="filter-count">{PRICE_WINS.length}</span>
          </button>
          <button type="button" className="filter-chip" aria-pressed={scope === 'same'} onClick={() => setScope('same')}>
            Same country <span className="filter-count">{sameCount}</span>
          </button>
          <button type="button" className="filter-chip" aria-pressed={scope === 'cross'} onClick={() => setScope('cross')}>
            Cheaper abroad <span className="filter-count">{crossCount}</span>
          </button>
        </div>
        <div className="filter-group" role="group" aria-label="Country">
          {availableCountries.map((code) => (
            <button
              key={code}
              type="button"
              className="filter-chip"
              aria-pressed={countryFilter === code}
              onClick={() => setCountryFilter((prev) => (prev === code ? 'all' : code))}
            >
              <span aria-hidden="true">{COUNTRIES[code].flag}</span> {COUNTRIES[code].short}
            </button>
          ))}
        </div>
      </div>

      {!filtered.length ? (
        <div className="wins-empty filter-empty">
          <span>No retailer comparisons match that filter.</span>
          <button type="button" className="filter-reset" onClick={() => { setScope('all'); setCountryFilter('all'); }}>
            Reset filters
          </button>
        </div>
      ) : (
        <ul className="price-grid">
          {filtered.map((deal) => {
            const { from, to } = deal;
            const cross = from.country !== to.country;
            const home = COUNTRIES[from.country];
            const away = COUNTRIES[to.country];
            const title = cross ? 'Cheaper abroad' : `Another ${home.shop} shop`;
            const where = cross ? `${home.short} → ${away.short}` : home.name;
            const approx = !deal.save ? approxLocalSaving(from, to) : null;
            const saveLabel = deal.save ? 'You save' : approx ? 'Approx. saving' : `Cheaper in the ${away.short}`;
            const saveValue = deal.save ?? approx ?? `${to.price.charAt(0)} vs ${from.price.charAt(0)}`;
            const totalSpeech = deal.save
              ? `You save ${deal.save}`
              : approx
                ? `Approximate saving ${approx} in ${from.currency}`
                : `Cheaper in the ${away.short}, priced in a different currency`;
            return (
              <li key={deal.id}>
                <a
                  className="price-card"
                  data-kind={cross ? 'cross' : 'same'}
                  href={deal.href}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`${title}. ${deal.product}, ${deal.variant}: ${to.price} at ${to.shop}, was ${from.price} at ${from.shop}. ${totalSpeech}. Opens ${to.shop} in a new tab.`}
                >
                  <span className="price-card-head">
                    <DealRoute from={from} to={to} cross={cross} />
                    <span className="price-where">
                      <span className="price-where-title">{title}</span>
                      <span className="price-where-route">{where}</span>
                    </span>
                  </span>
                  <span className="price-card-prod">
                    <span className="price-product">{deal.product}</span>
                    <span className="price-variant">{deal.variant}</span>
                  </span>
                  <span className="price-slip">
                    <span className="price-line price-line-was">
                      <span className="price-line-shop">
                        <Flag code={from.country} className="price-line-flag" />
                        <span className="price-line-name">{from.shop}</span>
                      </span>
                      <span className="price-leader" aria-hidden="true" />
                      <s className="price-line-amount">{from.price}</s>
                    </span>
                    <span className="price-line price-line-now">
                      <span className="price-line-shop">
                        <Flag code={to.country} className="price-line-flag" />
                        <span className="price-line-name">{to.shop}</span>
                        <span className="price-line-out" aria-hidden="true">↗</span>
                      </span>
                      <span className="price-leader" aria-hidden="true" />
                      <strong className="price-line-amount">{to.price}</strong>
                    </span>
                    <span className="price-total" data-fx={deal.save ? undefined : 'true'}>
                      <span className="price-total-label">{saveLabel}</span>
                      <span className="price-leader" aria-hidden="true" />
                      <span className="price-total-value">{saveValue}</span>
                    </span>
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const FEED_TABS = [
  { id: 'all', label: 'All' },
  { id: 'coupons', label: 'Coupons' },
  { id: 'retailers', label: 'Other retailers' },
];

function Demo({ go }) {
  const ref = useArrival();
  useTitle('Oxylabs Live Simulator');
  return (
    <main className="view demo-view" ref={ref}>
      <p className="back-row"><ViewLink className="quiet-link back-link" to="signin" go={go}><BackArrow />Back to home</ViewLink></p>
      <OxylabsSimulator />
    </main>
  );
}

function Home({ pro, go }) {
  const { user } = useUser();
  const [feedTab, setFeedTab] = useState('all');
  const name = user?.firstName?.trim();
  const ref = useArrival();
  useTitle('Home');

  return (
    <main className="view home-view" ref={ref}>
      <section className="welcome">
        <Scout mood="happy" data-stick />
        <div>
          <h1>You’re <span className="swipe">in</span>{name ? `, ${name}` : ''}.</h1>
          <p className="lede">{NEXT_STEP} Here’s how a scan goes.</p>
        </div>
      </section>
      <ol className="steps">
        {STEPS.map((step, index) => (
          <li key={step.title} data-deal>
            {step.art}
            {/* The list already numbers the steps for a screen reader. */}
            <h2><span className="step-number" aria-hidden="true">{index + 1}</span>{step.title}</h2>
            <p>{step.text}</p>
          </li>
        ))}
      </ol>
      <div className="feed-shell" data-tab={feedTab}>
        <div className="feed-tabs" role="tablist" aria-label="Browse CartScout savings">
          {FEED_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              className="feed-tab"
              aria-selected={feedTab === tab.id}
              onClick={() => setFeedTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {(feedTab === 'all' || feedTab === 'coupons') ? <RecentWins pro={pro} go={go} /> : null}
        {(feedTab === 'all' || feedTab === 'retailers') ? <PriceComparisons /> : null}
      </div>
    </main>
  );
}

const ANSWERS = [
  { question: 'What counts as a scan?', answer: 'Pressing Scan on a shop that has no fresh result saved. Reopening a shop you scanned recently is free, and so is a scan that fails on our side.' },
  { question: 'When does it reset?', answer: 'Free scans come back every Monday at 00:00 UTC. A scan that finishes without finding a code still counts.' },
  { question: 'What does Pro unlock?', answer: 'Unlimited scans, the live feed of recent working codes and verified checkout savings from other Pro members, and shared thumbs up and down so codes that worked for others are listed and tried first.' },
  { question: 'How do I change or cancel?', answer: 'Open Account, then the Billing tab. Your plan and payment method are both there.' },
];

// What each plan is, in the product's own words. Every line is a rule the API enforces (server/store.js, plans.test.js).
const PLAN_COPY = {
  free: {
    name: 'Free',
    points: ['5 shop scans a week', 'Your results stay private', 'Your own thumbs up and thumbs down'],
  },
  pro: {
    name: 'Pro',
    points: [
      'Unlimited shop scans every week',
      'Live feed of recent working codes & savings from Pro members',
      'Other Pro members’ thumbs up and down on every code',
      'Codes that worked for others, listed first and tried first',
    ],
  },
};

/** The price exactly as Clerk states it for the plan. Never a number of our own. */
const priceOf = (plan) => (plan?.fee ? `${plan.fee.currencySymbol}${plan.fee.amountFormatted}` : '');

/**
 * One plan as a ticket: what you get on the paper, the price on the stub. The price and the action each keep a fixed
 * box, so the ticket is the same size before Clerk has answered, after, and when the plan changes.
 */
function PlanCard({ kind, price, pricing, children }) {
  const copy = PLAN_COPY[kind];
  return (
    <div className="plan-slot">
      <article className="plan-ticket" data-plan={kind} aria-labelledby={`plan-${kind}-name`}>
        <div className="plan-body">
          <h2 id={`plan-${kind}-name`}>{copy.name}</h2>
          <ul className="plan-points">
            {copy.points.map((point) => <li key={point}><Tick />{point}</li>)}
          </ul>
          <div className="plan-action">{children}</div>
        </div>
        <p className="plan-stub" id={`plan-${kind}-price`}>
          {pricing ? <span className="bone bone-fee" aria-hidden="true" /> : null}
          {price ? <><span className="plan-fee">{price}</span> <span className="plan-period">a month</span></> : null}
        </p>
      </article>
    </div>
  );
}

const CHECKOUT_DONE_URL = `${hrefFor('billing')}&checkout=complete`;

function Plans({ pro, celebrating, checking, checkMessage, recheck, drawerOpen, go }) {
  const { userId } = useAuth();
  const ref = useArrival();
  const scoutRef = useRef(null);
  const plans = usePlans({ for: 'user' });
  const [settled, setSettled] = useState(false);
  const [opening, setOpening] = useState(false);
  const box = useRef(null);
  const held = useRef(0);
  useTitle(pro ? 'You’re Pro' : 'Plans');

  useEffect(() => {
    if (!celebrating) return undefined;
    celebrate({ origin: scoutRef.current ?? undefined });
    return () => stopConfetti();
  }, [celebrating]);

  const list = plans.data ?? [];
  const proPlan = list.find((plan) => plan.slug === PRO_PLAN);
  const freePlan = list.find((plan) => plan.isDefault && plan.slug !== PRO_PLAN);
  const busy = plans.isLoading || plans.isFetching;
  // Clerk can report "not loading" for a beat before its first request starts; only a quiet moment counts as an answer.
  useEffect(() => {
    if (busy) {
      setSettled(false);
      return undefined;
    }
    const timer = setTimeout(() => setSettled(true), 600);
    return () => clearTimeout(timer);
  }, [busy]);
  const pricing = !proPlan && !settled && !plans.isError;
  // Without the Pro plan's id our own button cannot open checkout, so Clerk's stock table takes over and upgrading still works.
  const stock = !pro && !proPlan && (plans.isError || settled);

  // If Clerk's table has to stand in, it gets at least the room the tickets had, so the answers below stay put.
  useLayoutEffect(() => {
    if (!stock && box.current) held.current = box.current.offsetHeight;
  });

  // "Opening checkout" lasts from the press until Clerk's drawer is on screen, or a few seconds if it never arrives.
  useEffect(() => {
    if (!opening) return undefined;
    if (drawerOpen) {
      setOpening(false);
      return undefined;
    }
    const timer = setTimeout(() => setOpening(false), 8000);
    return () => clearTimeout(timer);
  }, [opening, drawerOpen]);

  const mood = celebrating ? 'party' : pro ? 'happy' : 'idle';
  const waiting = checking && !pro;
  const dollars = [proPlan, freePlan].some((plan) => plan?.fee?.currency?.toUpperCase() === 'USD');

  // Keyed, so one message replaces another instead of the same node changing size under the reader.
  let status = null;
  if (waiting) status = <span key="checking">{checkMessage || 'Checking your plan…'}</span>;
  else if (testMode) status = <span key="test" className="test-note">Test checkout. No real charges.</span>;
  // Short waits are named where they happen (the price line, the button) and announced from here.
  let heard = '';
  if (opening) heard = 'Opening checkout…';
  else if (pricing) heard = 'Fetching prices…';

  let proAction;
  if (pro) {
    proAction = (
      <>
        <p className="plan-current"><Tick />You’re on Pro</p>
        <SubscriptionDetailsButton for="user">
          <button className="quiet-link" type="button">Manage plan</button>
        </SubscriptionDetailsButton>
      </>
    );
  } else if (waiting) {
    // Checkout has just finished: a second press here could only buy the same plan twice.
    proAction = <p className="plan-aside">Checking your plan…</p>;
  } else if (proPlan) {
    proAction = (
      <CheckoutButton planId={proPlan.id} planPeriod="month" for="user" newSubscriptionRedirectUrl={CHECKOUT_DONE_URL}>
        {/* Both labels sit in one cell, so the button is the same width whichever one shows. */}
        <button className="primary plan-buy" type="button" aria-describedby="plan-pro-price" aria-busy={opening || undefined} onClick={() => { noteCheckoutStarted(userId); setOpening(true); }}>
          <span aria-hidden={opening || undefined}>Upgrade to Pro</span>
          <span aria-hidden={!opening || undefined}>Opening checkout…</span>
        </button>
      </CheckoutButton>
    );
  } else {
    proAction = <span className="bone bone-action" aria-hidden="true" />;
  }

  return (
    <main className="view plans-view" data-plan={pro ? 'pro' : 'free'} ref={ref}>
      <p className="back-row"><ViewLink className="quiet-link back-link" to="signin" go={go}><BackArrow />Back to home</ViewLink></p>
      <section className="plans-intro">
        <div className="plans-copy">
          {/* Both headlines share one grid cell, so swapping them when the plan changes cannot move the page. */}
          <div className="swap">
            <div className="swap-side" aria-hidden={pro || undefined} inert={pro || undefined}>
              <h1>Stop <span className="swipe">counting scans</span>.</h1>
              <p className="lede">Unlock unlimited scans, live working codes &amp; savings from Pro members, and shared thumbs on every code.</p>
            </div>
            <div className="swap-side" aria-hidden={!pro || undefined} inert={!pro || undefined}>
              <h1>You’re <span className="swipe">Pro</span>{celebrating ? '!' : '.'}</h1>
              <p className="lede">{NEXT_STEP} If the popup still says Free, press its refresh button.</p>
            </div>
          </div>
          <p className="status-line" role="status">
            {celebrating ? <span className="visually-hidden">You’re Pro. {NEXT_STEP}</span> : null}
            {status}
            {heard ? <span key="heard" className="visually-hidden">{heard}</span> : null}
            {waiting && checkMessage ? <button className="quiet-link" type="button" onClick={recheck}>Check again</button> : null}
          </p>
        </div>
        <span className="plans-scout" ref={scoutRef}><Scout mood={mood} data-stick /></span>
      </section>
      <section className="plans-table" aria-label="Plans">
        <div className="plan-box" ref={box} style={stock && held.current ? { minBlockSize: held.current } : undefined}>
          {stock
            ? (
              <Reserve kind="plans" label="Plans" waiting="Fetching the plans…" named={false} skeleton={PlansSkeleton}>
                {/* Any press inside Clerk's own table may be the one that starts a checkout. */}
                <div onClickCapture={() => noteCheckoutStarted(userId)}>
                  <PricingTable for="user" newSubscriptionRedirectUrl={CHECKOUT_DONE_URL} />
                </div>
              </Reserve>
            )
            : (
            <div className="plan-tickets">
              <PlanCard kind="free" price={priceOf(freePlan)} pricing={pricing}>
                {pro
                  ? <p className="plan-aside">Every account starts here.</p>
                  : <p className="plan-current"><Tick />You’re on Free</p>}
              </PlanCard>
              <PlanCard kind="pro" price={priceOf(proPlan)} pricing={pricing}>{proAction}</PlanCard>
            </div>
            )}
        </div>
        {/* Its line is kept from the start, so the note arriving with the prices moves nothing. */}
        <p className="price-note">
          {pricing ? 'Fetching prices…' : ''}
          {dollars ? 'Prices are in US dollars.' : ''}
        </p>
      </section>
      <dl className="answers">
        {ANSWERS.map((item) => (
          <div key={item.question} data-deal>
            <dt>{item.question}</dt>
            <dd>{item.answer}</dd>
          </div>
        ))}
      </dl>
      <BillingHelp />
      <WayBack>
        <ViewLink className="quiet-link" to="account" hash={BILLING_HASH} go={go}>Manage billing</ViewLink>
      </WayBack>
    </main>
  );
}

function Manage({ pro, go }) {
  const ref = useArrival();
  useTitle('Your account');
  return (
    <main className="view manage-view" data-plan={pro ? 'pro' : 'free'} ref={ref}>
      <p className="back-row"><ViewLink className="quiet-link back-link" to="signin" go={go}><BackArrow />Back to home</ViewLink></p>
      <h1>Your <span className="swipe">account</span></h1>
      <p className="lede">Change your details, payment method or plan. Billing lives under the Billing tab.</p>
      <Reserve kind="profile" label="Account settings" waiting="Fetching your account settings…" skeleton={ProfileSkeleton}>
        <UserProfile routing="hash" />
      </Reserve>
      <BillingHelp />
      <WayBack />
    </main>
  );
}

// An address ending in checkout=complete can be saved, shared or reopened. It only earns a party when this browser
// saw the member press a button that starts a checkout, not long before.
const startedKey = (userId) => `cartscout:checkout-started:${userId}`;
const CHECKOUT_MEMORY_MS = 2 * 60 * 60 * 1000;
function noteCheckoutStarted(userId) {
  if (!userId) return;
  try { window.localStorage.setItem(startedKey(userId), String(Date.now())); } catch { /* Private mode: nothing to remember. */ }
}
/** True once for a checkout started here in the last two hours; the note is used up by asking. */
function checkoutWasStarted(userId) {
  try {
    const at = Number(window.localStorage.getItem(startedKey(userId))) || 0;
    window.localStorage.removeItem(startedKey(userId));
    return Date.now() - at < CHECKOUT_MEMORY_MS;
  } catch {
    return false;
  }
}

const celebratedKey = (userId) => `cartscout:pro-celebrated:${userId}`;
/** When this browser last threw the party for this member's Pro plan, or 0 if it never has. Kept until they are Free again. */
function celebratedAt(userId) {
  try { return Number(window.localStorage.getItem(celebratedKey(userId))) || 0; } catch { return 0; }
}
function rememberCelebration(userId) {
  try { window.localStorage.setItem(celebratedKey(userId), String(Date.now())); } catch { /* Private mode: nothing to remember. */ }
}
/** Back on Free, so a later upgrade is a new one and gets its own party. */
function forgetCelebration(userId) {
  try { window.localStorage.removeItem(celebratedKey(userId)); } catch { /* Private mode: nothing was kept. */ }
}
// Another tab may have thrown the party for a plan change this tab only watched happen; one is enough.
const OTHER_TAB_WINDOW_MS = 120000;

/** True while one of Clerk's drawers (checkout, plan details) is open over the page. */
function useDrawerOpen(active) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!active) return undefined;
    const read = () => setOpen(document.querySelector('.cl-drawerRoot, .cl-drawerContent') !== null);
    const observer = new MutationObserver(read);
    observer.observe(document.body, { childList: true, subtree: true });
    read();
    return () => observer.disconnect();
  }, [active]);
  return active && open;
}

/** Pro status, plus the one-off "just upgraded" moment and the short wait after returning from checkout. */
function usePlan(route, view, replace) {
  const { isLoaded, isSignedIn, has, userId } = useAuth();
  const clerk = useClerk();
  const { session } = useSession();
  const sessionId = session?.id;
  const signedIn = Boolean(isLoaded && isSignedIn && userId);
  const pro = signedIn ? has?.({ plan: PRO_PLAN }) === true : false;
  const drawerOpen = useDrawerOpen(signedIn);
  const [celebrating, setCelebrating] = useState(false);
  const [checkMessage, setCheckMessage] = useState('');
  const [round, setRound] = useState(0);
  const wasPro = useRef(null);
  // Which party is owed: 'arrival' from a finished checkout's address, or 'flip' when the plan changes on an open page.
  const owed = useRef(null);
  const drawerSeen = useRef(false);
  const leaving = useRef(false);
  const checking = route.checkoutComplete && route.intent === 'billing';

  useEffect(() => {
    const leave = () => { leaving.current = true; };
    window.addEventListener('beforeunload', leave);
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('beforeunload', leave);
      window.removeEventListener('pagehide', leave);
    };
  }, []);

  // One party per upgrade: when the plan turns Pro on a screen that sells it, or on arrival from a finished checkout.
  // Never on an ordinary page load, and never behind Clerk's checkout drawer.
  useEffect(() => {
    if (!signedIn) {
      wasPro.current = null;
      owed.current = null;
      return undefined;
    }
    const before = wasPro.current;
    wasPro.current = pro;
    // Seen on Free with no party in the last couple of minutes: any earlier party belonged to an earlier membership.
    if (!pro && Date.now() - celebratedAt(userId) > OTHER_TAB_WINDOW_MS) forgetCelebration(userId);
    if (pro && before === false && view !== 'signin') owed.current = 'flip';
    if (pro && before === null && checking) owed.current = 'arrival';
    if (!owed.current) return undefined;
    if (drawerOpen) {
      drawerSeen.current = true;
      return undefined;
    }
    // Clerk closes its drawer just before it sends the browser to the "checkout complete" address, and the party
    // belongs to that arrival. Waiting a beat after a drawer closes keeps it from starting here and again there.
    const timer = setTimeout(() => {
      if (leaving.current) return;
      const arrival = owed.current === 'arrival';
      owed.current = null;
      drawerSeen.current = false;
      const last = celebratedAt(userId);
      // A saved "checkout complete" address is not an upgrade: it needs a checkout started in this browser, and once
      // this membership has had its party it never has another. A plan that changes while the page is open only
      // stays quiet if another tab celebrated it just now.
      const already = arrival ? last > 0 || !checkoutWasStarted(userId) : Date.now() - last < OTHER_TAB_WINDOW_MS;
      // Drops `checkout=complete`, so reloading the page cannot celebrate again, and shows the plans view.
      if (arrival || !already) replace(hrefFor('billing'));
      if (already) return;
      rememberCelebration(userId);
      setCelebrating(true);
    }, drawerSeen.current ? 900 : 0);
    return () => clearTimeout(timer);
  }, [signedIn, userId, pro, checking, drawerOpen, view, replace]);

  // The party belongs to the visit it happened on: after the member moves to another view, coming back to Plans is
  // an ordinary visit and must not set the confetti off again.
  useEffect(() => {
    if (view !== 'billing') setCelebrating(false);
  }, [view]);

  // After checkout the session can lag the new plan by a moment: reload it a few times, then say so.
  useEffect(() => {
    if (!checking || pro || !sessionId) return undefined;
    let cancelled = false;
    let attempts = 0;
    let timer;
    setCheckMessage('');
    async function refreshPlan() {
      try {
        await clerk.session?.reload();
        await clerk.session?.getToken({ skipCache: true });
      } catch {
        // A short propagation delay is expected after checkout.
      }
      if (cancelled) return;
      attempts += 1;
      if (attempts < 5) timer = setTimeout(refreshPlan, 1200);
      else setCheckMessage('Your plan is still updating.');
    }
    void refreshPlan();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [checking, pro, sessionId, clerk, round]);

  const recheck = useCallback(() => setRound((count) => count + 1), []);
  return { pro, celebrating, checking, checkMessage, recheck, drawerOpen };
}

function Portal() {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const { route, go, replace, sync } = useRoute();
  const view = isSignedIn ? route.destination : route.intent;
  const plan = usePlan(route, view, replace);
  const wait = useWait(isLoaded);
  const announcer = useRef(null);
  const moved = useRef(false);
  const landedFor = useRef(null);

  // Clerk may move the address itself after sign-in or sign-out, so read it again whenever that changes.
  useEffect(() => { sync(); }, [isSignedIn, sync]);

  // "Manage plan" in the popup arrives with the same intent as "Upgrade". A Pro member wants billing, not the price list.
  useLayoutEffect(() => {
    if (!isLoaded || !isSignedIn || landedFor.current === userId) return;
    landedFor.current = userId;
    if (plan.pro && route.forPlan && !route.checkoutComplete) replace(hrefFor('account') + BILLING_HASH);
  }, [isLoaded, isSignedIn, userId, plan.pro, route.forPlan, route.checkoutComplete, replace]);

  // Changing view keeps focus where it was, so the new screen's name is announced instead.
  const move = useCallback((to, hash) => {
    moved.current = true;
    go(to, hash);
  }, [go]);
  useEffect(() => {
    if (!moved.current || !announcer.current) return;
    moved.current = false;
    announcer.current.textContent = document.title.split(' · ')[0];
  }, [view]);

  let content;
  let mood = 'idle';
  if (route.intent === 'demo') {
    mood = 'search';
    content = <Demo go={move} />;
  } else if (!isLoaded) {
    mood = wait.stage === 'failed' ? 'oops' : 'search';
    content = <Waiting stage={wait.stage} onFailed={wait.fail} />;
  } else if (!isSignedIn) {
    content = <SignedOut key={route.intent} route={route} />;
  } else if (view === 'billing') {
    mood = plan.celebrating ? 'party' : 'idle';
    content = <Plans go={move} {...plan} />;
  } else if (view === 'account') {
    content = <Manage pro={plan.pro} go={move} />;
  } else {
    content = <Home pro={plan.pro} go={move} />;
  }

  return (
    <>
      <Header signedIn={isLoaded && isSignedIn} pro={plan.pro} view={view} go={move} mood={mood} />
      {content}
      {isLoaded && <Footer />}
      <p className="visually-hidden" role="status" ref={announcer} />
    </>
  );
}

function SetupNeeded() {
  useTitle('Setup needed');
  return (
    <>
      <Header />
      <Notice mood="shrug" title="The portal needs a Clerk key">
        <p className="lede">Add <code>VITE_CLERK_PUBLISHABLE_KEY</code> to <code>portal/.env.local</code>, then restart the portal.</p>
      </Notice>
      <Footer />
    </>
  );
}

/** A render error shows a way out instead of a blank page. */
class Safety extends Component {
  state = { broken: false };

  static getDerivedStateFromError() {
    return { broken: true };
  }

  componentDidCatch() {
    document.title = 'Something went wrong · CartScout';
  }

  render() {
    if (!this.state.broken) return this.props.children;
    return (
      <>
        <Header />
        <Notice mood="oops" title="Something went wrong">
          <p className="lede" role="alert">This page hit a problem on our side. Reload it to carry on.</p>
          <button className="primary" type="button" onClick={() => window.location.reload()}>Reload page</button>
        </Notice>
        <Footer />
      </>
    );
  }
}

export function CartScoutPortal() {
  return (
    <Safety>
      {publishableKey ? <Portal /> : <SetupNeeded />}
    </Safety>
  );
}
