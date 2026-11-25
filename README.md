<img src="assets/icon.svg" width="64" height="64" alt="">

# CartScout

Created in [T3 Code](https://t3.codes).

## Chrome extension

CartScout is a Chrome Manifest V3 extension. Click its toolbar icon on a
store page. The popup reads the active tab's hostname, shows candidate checkout codes and
their sources, and lets you copy a code and report whether it worked.

### Run locally

1. Copy [.env.example](.env.example) to `.env` and set `OXYLABS_WEB_API_KEY` to an Oxylabs Web API key.
2. Run `npm start` with Node 24.14 or later.
3. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**.
   Select the [extension](extension) directory.
4. Open a store and click **CartScout** in Chrome's toolbar.

### Try codes in a Myprotein UK basket

With at least one item in the basket, open CartScout on `https://www.myprotein.com/basket/`
and click **Try codes at checkout**. CartScout submits up to 10 discovered codes to the
basket’s discount form in order. The popup shows progress and can stop after the current
attempt. It leaves an accepted code applied and shows the before and after subtotal when
it can confirm a saving. An existing promo code or text already
entered in the discount field blocks a new run. Reports stay manual.

### Find the same product at other retailers

Open a Myprotein UK basket and choose a country under **Shop in**. CartScout starts
with an estimate from your device time zone or browser language, and falls back to
the UK. You can change the country at any time.
Click **Find alternatives** to compare basket products. Larger baskets can be
checked in batches of four distinct products.
The lookup sends only product names, variants, the merchant hostname and the selected
country to CartScout, then uses a country-specific Oxylabs search and scrapes retailer
pages for prices and stock. Exact matches, different variants and unconfirmed variants
are labelled. Prices are shown in the retailer's local currency before delivery.

### Discovery and reports

The backend sends the merchant hostname to Oxylabs `/v1/search`, then uses `/v1/scrape` to
extract codes from up to four sources. It checks each code against explicitly labelled
text on the page before including it. This filters fragments shown behind reveal buttons. Candidate codes may have cart restrictions
and are confirmed only by trying them at checkout. The extension sends the hostname alone,
plus an anonymous installation token and any coupon report the user submits.

SQLite stores results across installations and server restarts. Successful positive lookups
are cached for 24 hours. Empty successful lookups are cached for two hours and partial
lookups for ten minutes. Previously discovered codes can remain visible for up to seven days,
unless their listed expiry has passed. An installation can change its report on a code. The
displayed totals count reports from the past 30 days.

### Share across installations

The local default uses one server on this Mac. To share results across devices, run one server
behind HTTPS with a persistent volume for `DATABASE_PATH`. Run `npm run package:extension -- --api-origin https://your-api.example.com` to produce
a ZIP in `dist/` with the matching API origin and host permission. The package command
uses the system `zip` executable. Run it without arguments for a local ZIP. Extract the
ZIP and load the directory unpacked for a demo. The provider key stays on the server. Set
`OXYLABS_LOCATION` if the backend should use a specific market. The cache and reports are
shared within that backend's market.

This prototype uses anonymous per-installation reports and a single server-wide discovery
budget. Public rollout should add authenticated or abuse-resistant reporting, durable
quotas, and a managed persistence and backup policy.

Run `npm test` for extraction, shared cache, vote changes, and persistence coverage.
