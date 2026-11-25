# CartScout 🛒

CartScout is a Chrome extension that helps you check a basket before you buy. Find public promo codes for the store you’re visiting, try them on a supported checkout, and compare the same basket items at other retailers.

**[Get started with the Oxylabs Web API](https://oxylabs.io/SONNY)** · Affiliate link. Using it supports the channel and helps fund more free builds.

## What you’ll build

- **Coupon codes.** CartScout reads the current store’s hostname. It discovers publicly listed codes, checks them against their source pages, and lets you copy a code or report whether it worked.
- **Checkout savings.** On a Myprotein UK basket, CartScout tries up to ten codes in order, keeps the accepted code applied, and shows the subtotal change when it can confirm one.
- **Other retailers.** On the same basket, compare products by country with price, stock, and variant details. CartScout labels different or unconfirmed variants and shows listing prices before delivery.
- **Free and Pro accounts.** Sign in with Clerk, check your scan balance in the popup, and open Clerk Billing from **Upgrade to Pro**.

| Plan | Coupon discovery | Cache |
| --- | --- | --- |
| Free | 5 live site scans per week | Private to your account, including coupon reports |
| Pro | Site scans with no personal weekly limit | Shared coupon results and reports across Pro accounts on the same backend |

Opening the popup on Free checks your private cache. Click **Scan this store** to spend a scan when the cache is cold. Fresh cached reads and provider failures do not use a scan. The allowance resets Mondays at 00:00 UTC. A scan that completes without finding a code still counts.

## Getting started

You need **Node.js 24.14 or newer**, **Chrome 120 or newer**, and the `zip` and `unzip` commands. Use an Oxylabs Web API key and a Clerk **development** instance for the tutorial. [Oxylabs Web API](https://oxylabs.io/products/web-api)

### 1. Install the dependencies

From the CartScout repository root, run:

```bash
npm ci
npm ci --prefix portal
test -e .env || cp .env.example .env
test -e portal/.env.local || cp portal/.env.example portal/.env.local
```

### 2. Set up Oxylabs and Clerk

1. Create an Oxylabs Web API key and add it as `OXYLABS_WEB_API_KEY` in `.env`.
2. Create a dedicated CartScout development app in Clerk. Enable an email sign-in method and keep the default free **user** plan. [Clerk Dashboard](https://dashboard.clerk.com/)
3. Enable Clerk Billing for **users**. Add a paid user plan with slug `pro` and set a test price. Use the development payment gateway for the walkthrough. [Clerk Billing for B2C](https://clerk.com/docs/guides/billing/for-b2c)
4. Set the following values in `.env` using the keys from that same Clerk instance.

```dotenv
OXYLABS_WEB_API_KEY=your_oxylabs_web_api_key
OXYLABS_LOCATION=GB
CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
CLERK_ALLOWED_ORIGINS=http://localhost:8788,chrome-extension://oiiahmlikdllbbbahedcpbojgohonhao
CLERK_PRO_PLAN=pro
```

5. Paste the same **publishable** key into `portal/.env.local`.

```dotenv
VITE_CLERK_PUBLISHABLE_KEY=pk_test_...
```

6. Register the extension origin with the CartScout Clerk application. The stable ID comes from the public key in [the manifest](extension/manifest.json). [Clerk Sync Host setup](https://clerk.com/docs/guides/sessions/sync-host)

On a new, dedicated **development** instance, you can set the allowlist from the repository root. This request replaces the instance’s allowed-origin list, so include any custom origins you need in `CLERK_ALLOWED_ORIGINS` first.

```bash
node --env-file=.env --input-type=module <<'JS'
const origins = process.env.CLERK_ALLOWED_ORIGINS.split(',').map((value) => value.trim());
if (!process.env.CLERK_SECRET_KEY?.startsWith('sk_test_')) {
  throw new Error('Use a Clerk development secret key for this tutorial.');
}
const response = await fetch('https://api.clerk.com/v1/instance', {
  method: 'PATCH',
  headers: {
    Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ allowed_origins: origins }),
});
if (!response.ok) throw new Error(`Clerk setup failed (HTTP ${response.status}).`);
console.log('CartScout origins registered.');
JS
```

The portal and packaged extension use the Clerk publishable key. The Oxylabs key and Clerk secret key belong in the backend environment.

### 3. Start the backend and portal

Run each command from the repository root in a separate terminal.

```bash
npm start
```

```bash
npm --prefix portal run dev
```

The API listens on port `8787` and the [account portal](http://localhost:8788/) on port `8788`. Check the API from another terminal.

```bash
curl -fsS http://localhost:8787/health
# Expected: {"ok":true}
```

### 4. Package and load the extension

```bash
npm run package:extension
unzip -o dist/cartscout-1.1.0-local.zip -d dist/cartscout-extension
```

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**, select **Load unpacked**, and choose `dist/cartscout-extension`. Use the packaged folder so Chrome loads the built Clerk client and correct origins.
3. Pin CartScout from Chrome’s **Extensions** menu. Open a store and click the CartScout icon.
4. Select **Sign in**, finish in the account tab, then return to the store and reopen CartScout. The bundled Clerk SDK uses Sync Host from the extension service worker to carry the web session into the popup.

## Follow the build

### Scan a store and try a coupon

1. Visit [Myprotein UK](https://www.myprotein.com/) or [Currys](https://www.currys.co.uk/), open CartScout, and check **Coupons**.
2. With a fresh Free account, click **Scan this store** and check your balance. Reopen the same store while the cache is fresh to see **Your cached scan** with no extra scan used.
3. To try a discovered code, open a [Myprotein UK basket](https://www.myprotein.com/basket/) with an item and an empty promo field. Click **Try codes at checkout**. You can stop after the current code and report the outcome once you’ve checked your basket.

Coupon discovery accepts public merchant hostnames. Automatic coupon attempts and basket reading currently support Myprotein UK. Code availability and basket eligibility can change.

### Compare your basket

From the Myprotein UK basket, switch to **Other retailers**, choose a country under **Shop in**, and click **Find alternatives**. A larger basket can be checked in batches of four distinct products. Each search includes the merchant, product names, variants, and selected country.

### Try a Pro upgrade

1. While signed in as Free, click **Upgrade to Pro** in the popup. This opens the account portal’s **Plans** view.
2. Subscribe to the `pro` plan using a Clerk Billing test card. Use a development instance for the walkthrough. [Clerk Billing test flows](https://clerk.com/docs/guides/billing/overview#how-can-i-test-clerk-billing-flows)
3. Return to the store and reopen the extension. Click **Refresh plan** if needed. With Pro, you can scan as many stores as you like and see codes CartScout has already found for other Pro members.

The development upgrade was exercised in Chrome. A Free scan moved the balance from five to four, reopening reused the private result, and the extension’s upgrade button opened the Clerk test checkout. Returning to CartScout showed **Pro**. This used the development payment gateway.

## How it fits together

| Folder | Role |
| --- | --- |
| [`extension/`](extension/) | Chrome Manifest V3 popup, Clerk Sync Host, Myprotein checkout adapter, and retailer comparison |
| [`portal/`](portal/) | React account portal with Clerk sign-in, plans, and billing management |
| [`server/`](server/) | Node API, Clerk session verification, scan limits, and SQLite coupon cache |
| [`scripts/`](scripts/) | Extension ZIP build with the configured API, portal, and Sync Host origins |

The backend uses Oxylabs Web API search to discover coupon sources and retailer listings. It scrapes candidate pages to check whether coupon codes are publicly shown and to extract retailer offers. SQLite persists coupon results, reports, and weekly scan usage. Positive complete scans stay fresh for 24 hours, empty complete scans for two hours, and partial scans for ten minutes.

## Verify or package for another environment

```bash
npm test
npm --prefix portal run build
```

For a shared deployment, host the account portal and API over HTTPS. Give the API persistent storage for `DATABASE_PATH`, configure the same Clerk instance across the portal, backend, and extension, and register the deployed origins. Configure production Billing and its gateway before offering a live subscription. [Clerk Chrome extension deployment](https://clerk.com/docs/guides/development/deployment/chrome-extension)

Use the actual deployed origins when building the distribution ZIP.

```bash
npm run package:extension -- \
  --api-origin https://api.example.com \
  --portal-origin https://account.example.com \
  --sync-origin https://clerk.example.com
```

The local ZIP targets your own machine. A hosted API with a persistent database lets eligible accounts on different installations share a Pro cache. The ZIP can be loaded unpacked for development. Chrome Web Store distribution is a separate submission.
