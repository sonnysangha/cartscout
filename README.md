# CartScout 🛒 — AI Coupon Finder, Checkout Auto-Try & Cross-Border Price Comparison with Oxylabs, Next.js 16, Clerk & Convex

<img src="assets/icon.svg" alt="CartScout icon" width="72" align="right">

[![Oxylabs Web API](https://img.shields.io/badge/Oxylabs-Web%20API-00d4aa)](https://oxylabs.io/SONNY)
[![Next.js 16](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org/)
[![Clerk](https://img.shields.io/badge/Clerk-Auth%20%2B%20Billing-6c47ff?logo=clerk)](https://go.clerk.com/sonny)
[![Convex](https://img.shields.io/badge/Convex-Realtime%20%2B%20ActionCache-ee342f)](https://convex.dev/referral/SONNYS4371)
[![Chrome MV3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285f4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![React 19](https://img.shields.io/badge/React-19-149eca?logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-3178c6?logo=typescript)](https://www.typescriptlang.org/)

**Find real codes. Auto-try at checkout. Compare prices across borders.** CartScout is a Chrome Manifest V3 extension, unified **Next.js 16** app (account portal + API routes + interactive Oxylabs pipeline simulator), and **Convex** real-time backend with **Clerk** authentication & billing that helps shoppers save money before they buy.

**Scout**, the little yellow shopping cart, discovers public coupon codes for the shop you are visiting via the **[Oxylabs Web API](https://oxylabs.io/SONNY)**, verifies every code against raw Markdown, automatically tests them one by one at checkout to keep the biggest saving, and compares the exact product you are viewing (or everything in your basket) against other retailers at home and abroad.

[**Get started with Oxylabs →**](https://oxylabs.io/SONNY) · [**Get started with Clerk →**](https://go.clerk.com/sonny) · [**Get started with Convex →**](https://convex.dev/referral/SONNYS4371) · [**Join the free AI Community →**](https://www.papareact.com/ztoh-form)

> **Who is this for?** Developers who want to build a real, production-grade Chrome MV3 extension + full-stack SaaS powered by live web intelligence — combining geo-targeted search & parallel scraping (**Oxylabs Web API**), zero-timeout durable backend actions + 24h caching (**Convex** & `@convex-dev/action-cache`), auth + subscription billing (**Clerk**), and a unified **Next.js 16** app.

**This build uses:** Next.js **16.4.6**, React **19.3.1**, Clerk Next.js **7** & Clerk Chrome Extension **3**, Convex **1.51** with `@convex-dev/action-cache`, Oxylabs Web API (`/v1/search` & `/v1/scrape`), esbuild **0.28**, TypeScript **7**, pnpm, and Node **24.14+**. Exact resolutions are in [`pnpm-lock.yaml`](pnpm-lock.yaml).

---

## 👇🏼 DO THIS Before You Get Started

1️⃣ Sign up to Oxylabs Web API 👉 **[https://oxylabs.io/SONNY](https://oxylabs.io/SONNY)**

2️⃣ Sign up to Clerk 👉 **[https://go.clerk.com/sonny](https://go.clerk.com/sonny)**

3️⃣ Create your free Convex account 👉 **[https://convex.dev/referral/SONNYS4371](https://convex.dev/referral/SONNYS4371)**

4️⃣ Join my AI Community for FREE 👉 **[https://www.papareact.com/ztoh-form](https://www.papareact.com/ztoh-form)**

| Service | Its job in CartScout | Needed for |
| --- | --- | --- |
| **[Oxylabs Web API](https://oxylabs.io/SONNY)** | Geo-targeted Google Search (`/v1/search`) and parallel Markdown + AI JSON scraping (`/v1/scrape`) | Live coupon discovery and cross-border retailer price comparisons |
| **[Clerk](https://go.clerk.com/sonny)** | Sign-in, Chrome Extension Sync Host sessions, and Free vs Pro subscription billing | Authentication and Pro plan gating (no Stripe webhook code required) |
| **[Convex](https://convex.dev/referral/SONNYS4371)** | Real-time database, `@convex-dev/action-cache` (24h shop / 6h price TTL), 10-min Oxylabs Actions, and atomic UTC budget ledger | Caching, live member wins feed, community thumbs, and cost protection |

The Oxylabs, Clerk, and Convex links above are Sonny’s campaign/affiliate links — using them supports the channel and helps fund more free builds. Create your own accounts and keys when running your copy; no credentials are included in this repository.

## 🧭 Inside This README

- [How Oxylabs Powers CartScout](#how-oxylabs-powers-cartscout)
- [Interactive Oxylabs Pipeline Simulator](#interactive-oxylabs-pipeline-simulator)
- [Key Features & Plans](#key-features)
- [Getting Started](#getting-started)
- [How the Chrome Extension Is Bundled](#how-the-chrome-extension-is-bundled)
- [Environment Variables Reference](#environment-variables-reference)
- [Scripts & Testing](#scripts--testing)
- [Repository Layout](#repository-layout)
- [Packaging for Production](#packaging-for-production)
- [Attribution and Use](#attribution-and-use)

---

## How Oxylabs Powers CartScout

Every piece of live web intelligence in CartScout — **coupon discovery**, **source verification**, **geo-targeted retailer search**, and **structured product/price/stock extraction** — is built on the **[Oxylabs Web API](https://oxylabs.io/SONNY)** (`https://webapi.oxylabs.io/v1/search` and `https://webapi.oxylabs.io/v1/scrape`).

Rather than maintaining fragile per-site scrapers or hitting anti-bot blocks from a shopper’s browser, the Chrome extension delegates all external discovery to the unified Next.js API (`app/v1/*`) and **Convex Actions** (`convex/oxylabs.ts`), which funnel every outbound call through a single ticket-gated Oxylabs client (`createOxylabsClient` in [`server/oxylabs.js`](server/oxylabs.js)).

### Architecture Overview

```mermaid
flowchart LR
  Ext["Chrome Extension (MV3 + esbuild)"]
  Next["Unified Next.js 16 App (app/ + proxy.ts)\n• Account Portal UI + Oxylabs Simulator\n• /v1/coupons, /alternatives, /reports, /wins"]
  Convex["Convex Cloud (convex/)\n• @convex-dev/action-cache (24h & 6h TTL)\n• Oxylabs Actions (10-min runtime)\n• Atomic UTC Ledger & Real-Time Feed"]
  OxySearch["Oxylabs Web API /v1/search"]
  OxyScrape["Oxylabs Web API /v1/scrape (Markdown + AI JSON / JS Render)"]

  Ext -->|"HTTPS + Clerk Bearer JWT"| Next
  Next <-->|"ConvexProviderWithClerk (WebSockets) + /internal/rpc"| Convex
  Convex -->|"Ticket-gated search (location-targeted)"| OxySearch
  Convex -->|"Parallel page scrapes (output: markdown + json)"| OxyScrape
```

### Oxylabs Web API in 10 Seconds (ELI5)

CartScout uses just **two** Oxylabs Web API endpoints to turn any store or product into verified, structured data:

```mermaid
flowchart TD
  Need["CartScout needs live web data\n(coupons for a store OR competing retailer prices)"]
  Need --> Search["1. POST /v1/search\nGeo-targeted Google Search\n(returns top organic URLs for GB, US, DE, ...)"]
  Search --> Pick["Rank & pick best pages\n(official store + open coupon sites\nOR up to 4 competing retailers)"]
  Pick --> Scrape["2. POST /v1/scrape\nParallel page fetch with anti-bot handling\n(output: Markdown + AI JSON, or JS render fallback)"]
  Scrape --> Verify["Deterministic Verification\n• Coupon code must appear literally in raw Markdown\n• Product variant, unit size & stock text must match"]
  Verify --> Store["Save structured result to Convex\n(reused by every shopper)"]
```

### How Coupon Search + 24-Hour Caching Works (`@convex-dev/action-cache`)

Most opens never touch Oxylabs at all. CartScout wraps its live Oxylabs actions in Convex’s official **`@convex-dev/action-cache`** component ([`convex/cache.ts`](convex/cache.ts)) using one clean key (`registrableDomain(merchant) ?? merchant`, e.g. `"ridge.com"` for both `ridge.com` and `uk.ridge.com`) with a **24-hour TTL** and automatic daily cleanup:

```mermaid
flowchart TD
  Open["Shopper opens CartScout on a store\n(e.g. uk.ridge.com)"]
  Open --> CheckCache{"@convex-dev/action-cache\nkey = 'ridge.com' (24h TTL)"}

  CheckCache -->|"YES — Cache Hit (< 50ms)"| Fast["Return cached codes + community thumbs\n(0 Oxylabs requests spent)"]

  CheckCache -->|"NO — Cache Miss / Expired / Rescan"| Reserve["Reserve atomic ticket in Convex UTC Ledger\n(max 24 requests, enforces daily & monthly cap)"]
  Reserve --> RunOxy["Convex Action calls Oxylabs Web API\n• 1 × /v1/search (up to 20 results)\n• up to 20 external pages plus merchant reads (Markdown + AI JSON)"]
  RunOxy --> Save["@convex-dev/action-cache stores result (24h TTL)\n+ releases unused ledger slots"]
  Save --> Fast
```

### 1. Single Ticket-Gated Oxylabs Client ([`convex/oxylabs.ts`](convex/oxylabs.ts), [`server/oxylabs.js`](server/oxylabs.js))

Every outbound call to Oxylabs is ticket-gated and logged:

- **Endpoints:** `POST https://webapi.oxylabs.io/v1/search` and `POST https://webapi.oxylabs.io/v1/scrape`, authenticated via `Authorization: Bearer <OXYLABS_WEB_API_KEY>`.
- **Geo-location targeting:** Passes the two-letter ISO `location` (`OXYLABS_LOCATION`, e.g. `GB`, or the shopper’s chosen `Shop in` country such as `GB`, `US`, `DE`, `FR`, `AU`, `CA`) directly in the Oxylabs payload so Google search results and retailer storefronts reflect real local pricing, currency, and stock.
- **Hard ticket enforcement:** Every request must present an atomically reserved hold (`convex/ledger.ts`). If an operation tries to exceed its reserved ceiling, it throws locally before sending any HTTP request. Every call logs its kind (`search`, `read`, or `read_js`), target hostname, AI parser flag, HTTP success, and latency straight into the Convex UTC ledger.
- **Raw response recording:** When `OXYLABS_RECORD=1` is enabled locally, `createRecorder` ([`server/recorder.js`](server/recorder.js)) saves raw Oxylabs payloads to disk for offline fixture replay.

### 2. Multi-Stage Coupon Discovery Pipeline

When a member scans a shop (`POST /v1/coupons`), the Convex Action reserves up to 24 requests. A follow-up that skips previously checked merchant pages reserves up to 21.

The shared coupon cache is keyed by merchant domain, so product pages on the same storefront reuse the same scan. Independently hosted shops on multi-tenant platforms keep separate cache entries. Each coupon retains its own offer terms and expiry. While a live scan runs, the extension keeps saved codes visible and adds verified source results as pages finish. Convex publishes scan progress separately, and the retailer cache receives the final result.

1. **Stage 1 — Geo-Targeted Search (`POST /v1/search`, 1 request):**
   - Queries Oxylabs for up to 20 results, geo-located via `OXYLABS_LOCATION`.
   - Selects up to two official merchant pages and one candidate URL per external host. Follow-up searches filter out hosts recorded in the current cache window.
   - **Smart publisher ranking (`siteRank`):** Ranks open-code sites that print full unmasked codes in plain HTML (`couponsolver`, `wethrift`, `simplycodes`, `couponbirds`, `coupert`, `dontpayfull`, `worthepenny`, `knoji`, `retailmenot`, `reddit`, `moneysavingexpert`) ahead of click-to-reveal affiliate walls (`wowcher`, `savoo`, `vouchercodes`, `couponfollow`, etc.).
2. **Stage 2 — Parallel Scraping with Oxylabs AI Structured Extraction (`POST /v1/scrape`):**
   - Scrapes official store pages and then up to 20 ranked external coupon pages, with parallel reads within each group.
   - Requests `output: ['markdown', 'json']` with a strict `json.prompt` extracting `{ coupons: [{ code, offer, expiresOn }] }` only for the target `merchant`, ignoring masked `"Get Code / Show Code"` buttons and prompt-injection text.
   - **Double verification against raw Markdown (`hasPublicCode`, `namedBeside`):** CartScout never blindly trusts an LLM. Every AI-extracted code must appear literally in the raw Markdown next to an explicit label (`Use code:`, `Enter SAVE20 at checkout`, Markdown code cells, etc.), and expired dates are stripped with a global-friendly timezone cutoff.
3. **Stage 3 — Conditional JavaScript Rendering Fallback (`run_js: true`):**
   - If a merchant’s own page returns effectively blank (`< 20` characters of Markdown) and no codes were found on other official pages, CartScout spends at most **1** slot to re-scrape that page with `run_js: true` (`timeout: 45_000`) to capture SPA promo banners.

### 3. Cross-Retailer & Cross-Border Price Comparison (`LOOKUP_CEILING = 5`)

When a shopper switches to **Other retailers** in the extension, `POST /v1/alternatives` invokes the `@convex-dev/action-cache` wrapped `findAlternatives` action (**6-hour TTL**, capped at **5 requests max per item**):

1. **Country-Specific Retailer Search (`POST /v1/search`, 1 request):** Searches Oxylabs with `"buy <product> <variant> <country name> online retailer"` (`location: <country>`) and picks up to 4 competing retailer product URLs (excluding the current merchant, homepages, and search pages).
2. **Parallel Retailer Page Extraction (`POST /v1/scrape`, up to 4 parallel requests):** Extracts `{ offer: { title, variant, match, price, currency, availability, stockText } }` via Oxylabs AI JSON (or local Schema.org JSON-LD parsing in `local` mode).
3. **Deterministic Variant & Unit Verification (`sameVariant`):** Normalizes unit conversions (`1kg` == `1000g` == `2.2lb`, `250ml` == `250 ml`) and flavour word ordering while strictly rejecting mismatched model numbers or pack sizes.
4. **Partial Failure Recovery:** If 1 of 4 retailer pages fails or times out, retrying only re-scrapes the failed URL (`PAGE_TRIES = 2` max) rather than re-running the search.

---

## Interactive Oxylabs Pipeline Simulator

Open **`http://localhost:8788/?intent=demo`** (or click **Oxylabs Simulator** in the top nav bar of the web portal) for a full-width, animated visual walkthrough built for teaching and streaming:

- **Simulated real store checkout** on the left (switch between `nativecos.com`, `uk.ridge.com`, and `myprotein.com`), transitioning authentically from the Chrome extension popup → perforated tickets → floating in-page auto-try dock testing codes 1-by-1.
- **Animated node-graph pipeline** on the right with a highlighted **⚡ Oxylabs Web API Zone**, 4-way parallel `/v1/scrape` fan-out (`Promise.allSettled()`), and a toggle between **Live Oxylabs (Cache Miss)** and **24h `@convex-dev/action-cache` Hit (0 requests)**.
- **Clickable nodes + Simple (ELI5) / Raw JSON inspector** showing the exact `/v1/search` queries, `/v1/scrape` AI prompts, raw Markdown verification, and checkout results.

---

## Key Features

- **Coupon discovery & smart working-first ordering:** Reads codes advertised directly on the page instantly without spending a scan, displays discovered codes as perforated tickets with community 👍 / 👎 tallies, and automatically promotes codes that **worked on your basket** (best saving #1) to the very top.
- **Universal checkout auto-try engine (`extension/autotry/`):** On any HTTPS shop’s basket or checkout page, Scout tries up to 10 codes sequentially in a Shadow DOM floating dock, supports major e-commerce platforms + a 10-language heuristic promo-box finder + a **“Show Scout the code box”** visual picker, restores the biggest saving, and automatically files 👍 / 👎 reports to Convex.
- **Other retailers & cross-border price checks:** Reads product details and prices from product pages or baskets (`extension/basket.js`), lets you switch countries under **Shop in** (`UK`, `US`, `DE`, `FR`, `AU`, `CA`, etc.), and highlights local & cross-border savings.
- **Cached price alerts:** Open CartScout on a product page to see fresh savings from shared comparisons. In **Other retailers**, choose **Enable price alerts on this shop** to also see a dismissible notice when visiting that shop. Alerts compare the current page price with an in-stock exact match in the same currency, before delivery. Automatic checks only read the cache.
- **Unified Next.js 16 Portal & Real-Time Member Wins Feed:** Powered by [Clerk](https://go.clerk.com/sonny) + [Convex](https://convex.dev/referral/SONNYS4371) (`ConvexProviderWithClerk`), featuring Pro/Free plan management, a live Pro-only **Recent coupons used by members** ticket feed (server-gated — Free users see blurred synthetic placeholders with zero leaked codes), and cross-border comparison slips.

| Plan | Coupon discovery | Cache & Community Feed |
| --- | --- | --- |
| **Free** | 5 live site scans per week (resets Monday 00:00 UTC) | Private cache and thumbs per account |
| **Pro** | Unlimited site scans | Shared 24h `@convex-dev/action-cache`, shared community thumbs, working codes tried first, and full access to the live member coupons feed |

---

## Getting Started

You need **Node.js 24.14 or newer**, **Chrome 120 or newer**, and `zip` / `unzip`.

### 1. Install dependencies

```bash
pnpm install
test -e .env.local || cp .env.example .env.local
```

### 2. Configure Oxylabs, Clerk, and Convex

1. Create an **[Oxylabs Web API key](https://oxylabs.io/SONNY)**.
2. Create a **[Clerk](https://go.clerk.com/sonny)** development application with email sign-in, enable **Clerk Billing for users** with plan slug `pro`, and create a **`convex` JWT template** (`"aud": "convex"`).
3. Create a free **[Convex](https://convex.dev/referral/SONNYS4371)** account, push your schema & `@convex-dev/action-cache` component, and set your Oxylabs + auth secrets on Convex:

```bash
npx convex dev --once
npx convex env set CLERK_JWT_ISSUER_DOMAIN "https://<your-clerk-instance>.clerk.accounts.dev"
npx convex env set CARTSCOUT_CONVEX_SECRET "$(openssl rand -hex 32)"
npx convex env set OXYLABS_WEB_API_KEY "your_oxylabs_web_api_key"
npx convex env set OXYLABS_LOCATION "GB"
npx convex env set OXYLABS_PAGE_PARSER "ai"
npx convex env set OXYLABS_DAILY_REQUESTS "150"
npx convex env set OXYLABS_MONTHLY_REQUESTS "2000"
```

4. Populate `.env.local` (alongside the `CONVEX_URL` / `CONVEX_SITE_URL` written by `npx convex dev`):

```dotenv
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
NEXT_PUBLIC_CONVEX_URL=https://<your-deployment>.convex.cloud
NEXT_PUBLIC_CLERK_PRO_PLAN=pro

CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
CLERK_ALLOWED_ORIGINS=http://localhost:8788,chrome-extension://oiiahmlikdllbbbahedcpbojgohonhao
CLERK_PRO_PLAN=pro
CARTSCOUT_CONVEX_SECRET=<same secret set on Convex>
```

5. Allow the portal and Chrome extension origins on your Clerk instance (per [Clerk’s Chrome Extension `syncHost` docs](https://clerk.com/docs/guides/sessions/sync-host)):

```bash
curl -X PATCH https://api.clerk.com/v1/instance \
  -H "Authorization: Bearer YOUR_CLERK_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"allowed_origins": ["http://localhost:8788", "chrome-extension://oiiahmlikdllbbbahedcpbojgohonhao"]}'
```

6. *(Optional)* Seed 14 real stores with working & non-working codes and realistic community thumbs into your Convex deployment:

```bash
node --env-file=.env.local scripts/seed-convex-demo.js
```

### 3. Start the app + Convex backend (single command)

```bash
pnpm dev
```

This runs both **Next.js 16** (`http://localhost:8788`, Portal + `/v1/*` API + Oxylabs Simulator) and **`convex dev`** side by side in one terminal.

Verify the health endpoint:

```bash
curl -fsS http://localhost:8788/health
# Expected: {"ok":true,"runtime":"nextjs+convex"}
```

- **Portal + API (single origin):** `http://localhost:8788`
- **Interactive Oxylabs Simulator:** `http://localhost:8788/?intent=demo`

### 4. Package and load the Chrome extension

```bash
pnpm package:extension
unzip -o dist/cartscout-1.1.0-local.zip -d dist/cartscout-extension
```

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select `dist/cartscout-extension`.
3. Pin CartScout in Chrome’s toolbar, open any shop, and click **Sign in** to sync your Clerk session into the extension.

---

## How the Chrome Extension Is Bundled

Chrome Manifest V3 extensions cannot run inside Next.js — Chrome requires static, self-contained local files (zero remote code, zero runtime `node_modules` resolution). [`scripts/package-extension.js`](scripts/package-extension.js) compiles [`extension/`](extension/) into a production-ready ZIP using **`esbuild`**:

1. **Build-time config & manifest injection:** Reads `--api-origin`, `--portal-origin`, `--sync-origin`, and `CLERK_PUBLISHABLE_KEY` (defaulting locally to `http://localhost:8788`), generates `config.js`, and dynamically rewrites `manifest.json` `host_permissions` to allow only those origins plus Clerk’s Frontend API host.
2. **ESM bundles for extension contexts:** Bundles `service-worker.js` (including `@clerk/chrome-extension/client` for Clerk Sync Host) and `popup.js` as minified Chrome 120 ESM modules (`format: 'esm'`, `bundle: true`), then enforces `assertSelfContained()` so zero external imports remain at runtime.
3. **IIFE bundles for page injection (`INJECTED`):**
   - `extension/panel/panel.js` → `panel.js` (`format: 'iife'`, global `CartScoutPanel`, with CSS and fonts inlined for Shadow DOM isolation).
   - `extension/autotry/page.js` → `autotry.js` (`format: 'iife'`, global `CartScoutAutoTry`, checked against an 80 KB warn / 110 KB hard fail size budget).
4. **Static copy, integrity check & ZIP:** Copies `popup.html`, CSS, `fonts/`, and `icons/`, verifies every referenced file exists, and writes `dist/cartscout-<version>[-local].zip` (unpacked to `dist/cartscout-extension`).

---

## Environment Variables Reference

| Variable | Where set | Purpose |
| --- | --- | --- |
| `OXYLABS_WEB_API_KEY` | Convex env | Bearer API key for `https://webapi.oxylabs.io/v1/*` |
| `OXYLABS_LOCATION` | Convex env (`GB`) | Default two-letter ISO country code for coupon search geo-location |
| `OXYLABS_PAGE_PARSER` | Convex env (`ai`) | `ai` (Oxylabs AI JSON extraction) or `local` (raw Markdown only) |
| `OXYLABS_DAILY_REQUESTS` / `OXYLABS_MONTHLY_REQUESTS` | Convex env (`150` / `2000`) | Hard UTC daily & monthly Oxylabs request caps enforced atomically |
| `CLERK_JWT_ISSUER_DOMAIN` | Convex env | Clerk Frontend API origin (no trailing slash) for `convex/auth.config.ts` |
| `CARTSCOUT_CONVEX_SECRET` | Convex env + `.env.local` | Shared HMAC/Bearer secret guarding Convex’s `/internal/rpc` bridge |
| `CONVEX_URL` / `CONVEX_SITE_URL` / `NEXT_PUBLIC_CONVEX_URL` | `.env.local` | Convex Cloud client & HTTP action endpoints |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` | `.env.local` | Clerk browser auth, extension Sync Host, and server JWT verification |
| `CLERK_ALLOWED_ORIGINS` | `.env.local` | Comma-separated origins allowed as JWT `azp` (portal + extension ID) |
| `CLERK_PRO_PLAN` / `NEXT_PUBLIC_CLERK_PRO_PLAN` | `.env.local` (`pro`) | Clerk Billing plan slug that unlocks Pro features |

---

## Scripts & Testing

```bash
pnpm test                                              # Run the full 219-test Node suite
pnpm dev                                               # Run Next.js 16 (:8788) + Convex backend together
pnpm dev:next                                          # Run only Next.js 16 (:8788)
pnpm dev:convex                                        # Run only Convex backend watcher
pnpm build                                             # Production Next.js 16 + TypeScript build
pnpm package:extension                                 # Bundle & zip the MV3 Chrome extension with esbuild
pnpm exec convex dev --once                            # Push Convex schema, ActionCache, and Oxylabs actions
node --env-file=.env.local scripts/seed-convex-demo.js # Seed 14 real shops + realistic thumbs into Convex
pnpm start:replay                                      # Run standalone Node API offline against server/replay/ fixtures
pnpm usage                                             # Compare Oxylabs ledger against Oxylabs balance
```

---

## Repository Layout

| Folder | Role |
| --- | --- |
| [`app/`](app/) | Unified Next.js 16 App Router: Account Portal page (`page.tsx`, `layout.tsx`) + all `/v1/*` & `/health` Route Handlers |
| [`components/`](components/) | React portal UI (`CartScoutPortal.jsx`), interactive Oxylabs pipeline simulator (`OxylabsSimulator.jsx`), `ConvexClientProvider.jsx`, Scout art & Clerk theme |
| [`convex/`](convex/) | Convex Cloud backend: `@convex-dev/action-cache` config (`convex.config.ts`, `cache.ts`), 7 relational tables (`schema.ts`), coupon/report queries (`store.ts`), atomic UTC ledger (`ledger.ts`), live Oxylabs actions (`oxylabs.ts`), real-time Pro pulse (`wins.ts`), internal RPC (`http.ts`), and hourly hold cleanup (`crons.ts`) |
| [`extension/`](extension/) | Chrome MV3 popup, working-first ticket ordering (`popup-order.js`), service worker (Clerk Sync Host + background runners), Shadow DOM checkout panel, universal auto-try engine (`autotry/`), basket/product readers, and shared brand tokens |
| [`lib/`](lib/) | Shared Next.js backend helpers (`backend.ts`): Clerk Bearer JWT verification, CORS headers, Convex RPC + ActionCache routing |
| [`server/`](server/) | Reusable Oxylabs Web API client (`oxylabs.js`, `alternatives.js`), local HTML parser (`local-parser.js`), Convex store adapter (`convex-store.js`), SQLite test store (`store.js`), replay harness, and 219-test suite |
| [`scripts/`](scripts/) | Extension ZIP packager (`package-extension.js`), Convex demo seeder (`seed-convex-demo.js`), offline scan seeder (`seed-scan.js`), and Oxylabs usage reporter (`usage.js`) |

---

## Packaging for Production

Deploy the unified Next.js app (e.g. Vercel) connected to your production Convex deployment (`npx convex deploy`), configure the same production Clerk instance across all surfaces, and build the extension pointing to your deployed origin:

```bash
pnpm package:extension -- \
  --api-origin https://cartscout.example.com \
  --portal-origin https://cartscout.example.com \
  --sync-origin https://clerk.example.com
```

---

## 📜 Attribution and Use

Built by [Sonny Sangha](https://www.papareact.com/ztoh-form) as a teaching project. For questions or commercial licensing inquiries, email [team@papareact.com](mailto:team@papareact.com). Oxylabs, Clerk, Convex, Next.js, and Chrome are trademarks of their respective owners; CartScout is an independent project and is not officially affiliated with or endorsed by any of them.
