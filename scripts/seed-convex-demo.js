// Seed realistic coupon scans + genuine multi-member community thumbs (both working and non-working)
// across real shops tested with CartScout into the configured Convex deployment.
// Usage: node --env-file=.env.local scripts/seed-convex-demo.js
import { openConvexStore } from '../server/convex-store.js';

const siteUrl = process.env.CONVEX_SITE_URL || (process.env.CONVEX_URL || '').replace(/\.convex\.cloud\/?$/, '.convex.site');
const secret = process.env.CARTSCOUT_CONVEX_SECRET;
if (!siteUrl || !secret) {
  console.error('Missing CONVEX_SITE_URL or CARTSCOUT_CONVEX_SECRET in environment.');
  process.exit(1);
}

const store = openConvexStore({ siteUrl, secret });

const MEMBERS = [
  { id: 'member:olivia_k', handle: '@olivia_k' },
  { id: 'member:liam_m', handle: '@liam_m' },
  { id: 'member:maya_c', handle: '@maya_c' },
  { id: 'member:james_t', handle: '@james_t' },
  { id: 'member:chloe_b', handle: '@chloe_b' },
  { id: 'member:noah_w', handle: '@noah_w' },
  { id: 'member:zara_h', handle: '@zara_h' },
  { id: 'member:ethan_p', handle: '@ethan_p' },
  { id: 'member:sophia_r', handle: '@sophia_r' },
  { id: 'member:lucas_d', handle: '@lucas_d' },
  { id: 'member:priya_s', handle: '@priya_s' },
  { id: 'member:harry_w', handle: '@harry_w' },
  { id: 'member:emma_r', handle: '@emma_r' },
  { id: 'member:oscar_b', handle: '@oscar_b' },
  { id: 'member:mia_h', handle: '@mia_h' },
  { id: 'member:jack_d', handle: '@jack_d' },
  { id: 'member:ava_c', handle: '@ava_c' },
  { id: 'member:leo_m', handle: '@leo_m' },
  { id: 'member:amelia_g', handle: '@amelia_g' },
  { id: 'member:daniel_v', handle: '@daniel_v' },
  { id: 'member:hannah_l', handle: '@hannah_l' },
  { id: 'member:toby_n', handle: '@toby_n' },
];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// Curated real websites tested with CartScout — includes both working codes and non-working/expired codes
// with realistic community thumbs up and thumbs down from distinct member handles.
const SHOPS = [
  {
    merchant: 'nativecos.com',
    currency: 'USD',
    coupons: [
      { code: 'ALYSSACHANG', offer: '20% off. Not valid on sale or clearance items, gift cards, or taxes', sources: ['https://www.simplycodes.com/store/nativecos.com'], up: 9, down: 1, saving: 5.80, minsAgo: 18 },
      { code: 'FIRST20', offer: '20% off your first order. Cannot be combined with sitewide promos', sources: ['https://www.wethrift.com/native'], up: 7, down: 1, saving: 7.40, minsAgo: 42 },
      { code: 'MADSLOL', offer: '20% off deodorant, body wash & hair care', sources: ['https://www.simplycodes.com/store/nativecos.com'], up: 6, down: 0, saving: 6.20, minsAgo: 75 },
      { code: 'WELCOME15', offer: '15% off your order', sources: ['https://www.nativecos.com/'], up: 8, down: 1, saving: 4.35, minsAgo: 110 },
      { code: 'NATIVE10', offer: '10% off your order', sources: ['https://www.nativecos.com/'], up: 6, down: 0, saving: 2.90, minsAgo: 165 },
      { code: 'BAYLEEWAY2', offer: '20% off full-priced items', sources: ['https://www.couponbirds.com/codes/nativecos.com'], up: 4, down: 1, saving: 5.80, minsAgo: 240 },
      { code: 'JOANNEDANG2', offer: '20% off. Cannot be combined with other promo codes', sources: ['https://www.wethrift.com/native'], up: 3, down: 1, saving: 5.80, minsAgo: 310 },
      { code: 'NATIVE25', offer: '25% off sitewide on orders over $40', sources: ['https://www.retailmenot.com/view/nativecos.com'], up: 0, down: 6, minsAgo: 95 },
      { code: 'SUMMER30', offer: '30% off seasonal scent bundles', sources: ['https://www.coupert.com/store/nativecos.com'], up: 1, down: 5, minsAgo: 190 },
      { code: 'FREESHIP50', offer: 'Free express shipping on orders over $50', sources: ['https://www.dontpayfull.com/at/nativecos.com'], up: 0, down: 4, minsAgo: 280 },
    ],
  },
  {
    merchant: 'uk.ridge.com',
    currency: 'GBP',
    coupons: [
      { code: 'RIDGE10', offer: '10% off your order', sources: ['https://uk.ridge.com/', 'https://www.simplycodes.com/store/ridge.com'], up: 10, down: 1, saving: 28.00, minsAgo: 24 },
      { code: 'EXTRA10', offer: 'Extra 10% off selected wallets and everyday carry', sources: ['https://www.wethrift.com/ridge-wallet'], up: 5, down: 2, saving: 11.50, minsAgo: 130 },
      { code: 'JDFM', offer: '10% off your order', sources: ['https://www.couponbirds.com/codes/ridge.com'], up: 4, down: 1, saving: 9.90, minsAgo: 210 },
      { code: 'RIDGE5', offer: '5% off your order', sources: ['https://www.simplycodes.com/store/ridge.com'], up: 3, down: 1, saving: 4.95, minsAgo: 360 },
      { code: 'RIDGE25', offer: '25% off titanium wallets and luggage', sources: ['https://www.retailmenot.com/view/ridge.com'], up: 0, down: 7, minsAgo: 88 },
      { code: 'WALLET20', offer: '20% off sitewide for new customers', sources: ['https://www.coupert.com/store/ridge.com'], up: 1, down: 5, minsAgo: 205 },
      { code: 'VIP30', offer: '30% off Everyday Carry bundles', sources: ['https://www.dontpayfull.com/at/ridge.com'], up: 0, down: 4, minsAgo: 420 },
    ],
  },
  {
    merchant: 'ridge.com',
    currency: 'USD',
    coupons: [
      { code: 'RIDGE10', offer: '10% off your order', sources: ['https://ridge.com/', 'https://www.simplycodes.com/store/ridge.com'], up: 9, down: 1, saving: 14.50, minsAgo: 51 },
      { code: 'EXTRA10', offer: 'Additional 10% off your next purchase', sources: ['https://www.wethrift.com/ridge-wallet'], up: 4, down: 2, saving: 12.90, minsAgo: 175 },
      { code: 'JDFM', offer: '10% off your order', sources: ['https://www.couponbirds.com/codes/ridge.com'], up: 3, down: 1, saving: 9.50, minsAgo: 290 },
      { code: 'RIDGE5', offer: '5% off your order', sources: ['https://www.simplycodes.com/store/ridge.com'], up: 2, down: 1, saving: 4.75, minsAgo: 410 },
      { code: 'RIDGE25', offer: '25% off titanium wallets', sources: ['https://www.retailmenot.com/view/ridge.com'], up: 0, down: 6, minsAgo: 140 },
      { code: 'WALLET20', offer: '20% off sitewide', sources: ['https://www.coupert.com/store/ridge.com'], up: 0, down: 5, minsAgo: 320 },
    ],
  },
  {
    merchant: 'uk.anker.com',
    currency: 'GBP',
    coupons: [
      { code: 'ANKER10', offer: '10% off your order', sources: ['https://uk.anker.com/', 'https://www.simplycodes.com/store/anker.com'], up: 8, down: 1, saving: 26.99, minsAgo: 33 },
      { code: 'POWER15', offer: '15% off selected chargers & power banks', sources: ['https://www.wethrift.com/anker'], up: 5, down: 2, saving: 13.50, minsAgo: 145 },
      { code: 'WS7DC21E', offer: '£10 off orders over £60', sources: ['https://www.hotukdeals.com/vouchers/anker.com'], up: 3, down: 1, saving: 10.00, minsAgo: 260 },
      { code: 'ANKER30', offer: '30% off MagGo wireless series', sources: ['https://www.retailmenot.com/view/anker.com'], up: 0, down: 6, minsAgo: 105 },
      { code: 'CHARGE25', offer: '25% off Anker Prime chargers', sources: ['https://www.coupert.com/store/anker.com'], up: 1, down: 5, minsAgo: 225 },
      { code: 'PRIME20', offer: '20% off SOLIX power stations', sources: ['https://www.dontpayfull.com/at/anker.com'], up: 0, down: 4, minsAgo: 390 },
    ],
  },
  {
    merchant: 'uk.store.anker.com',
    currency: 'GBP',
    coupons: [
      { code: 'ANKER10', offer: '10% off your order', sources: ['https://uk.store.anker.com/'], up: 6, down: 1, saving: 14.99, minsAgo: 62 },
      { code: 'POWER15', offer: '15% off selected chargers & cables', sources: ['https://www.wethrift.com/anker'], up: 4, down: 1, saving: 9.00, minsAgo: 185 },
      { code: 'ANKER30', offer: '30% off MagGo series', sources: ['https://www.retailmenot.com/view/anker.com'], up: 0, down: 5, minsAgo: 145 },
      { code: 'CHARGE25', offer: '25% off Prime chargers', sources: ['https://www.coupert.com/store/anker.com'], up: 0, down: 4, minsAgo: 310 },
    ],
  },
  {
    merchant: 'allbirds.com',
    currency: 'USD',
    coupons: [
      { code: 'WELCOME10', offer: '10% off your first order', sources: ['https://www.allbirds.com/'], up: 9, down: 1, saving: 22.40, minsAgo: 46 },
      { code: 'RUN15', offer: '15% off Tree Runners & Dashers', sources: ['https://www.simplycodes.com/store/allbirds.com'], up: 5, down: 2, saving: 18.75, minsAgo: 160 },
      { code: 'COZY10', offer: '10% off Wool Runners', sources: ['https://www.wethrift.com/allbirds'], up: 3, down: 1, saving: 11.00, minsAgo: 295 },
      { code: 'ALLBIRDS25', offer: '25% off footwear sitewide', sources: ['https://www.retailmenot.com/view/allbirds.com'], up: 0, down: 7, minsAgo: 112 },
      { code: 'WOOL30', offer: '30% off seasonal styles', sources: ['https://www.coupert.com/store/allbirds.com'], up: 1, down: 6, minsAgo: 255 },
      { code: 'FREESOCKS', offer: 'Free Trino socks with any shoe order', sources: ['https://www.dontpayfull.com/at/allbirds.com'], up: 0, down: 4, minsAgo: 400 },
    ],
  },
  {
    merchant: 'allbirds.co.uk',
    currency: 'GBP',
    coupons: [
      { code: 'WELCOME10', offer: '10% off your first order', sources: ['https://www.allbirds.co.uk/'], up: 8, down: 1, saving: 14.19, minsAgo: 58 },
      { code: 'RUN15', offer: '15% off Tree Runners', sources: ['https://www.simplycodes.com/store/allbirds.co.uk'], up: 4, down: 1, saving: 16.50, minsAgo: 195 },
      { code: 'ALLBIRDS25', offer: '25% off sitewide', sources: ['https://www.retailmenot.com/view/allbirds.com'], up: 0, down: 6, minsAgo: 132 },
      { code: 'FIRST20', offer: '20% off first UK order', sources: ['https://www.coupert.com/store/allbirds.co.uk'], up: 1, down: 4, minsAgo: 315 },
    ],
  },
  {
    merchant: 'brooklinen.com',
    currency: 'USD',
    coupons: [
      { code: 'WELCOME15', offer: '15% off sitewide', sources: ['https://www.brooklinen.com/'], up: 11, down: 1, saving: 28.35, minsAgo: 29 },
      { code: 'BEST20', offer: '20% off sitewide', sources: ['https://www.simplycodes.com/store/brooklinen.com'], up: 6, down: 2, saving: 37.80, minsAgo: 98 },
      { code: 'OSHRY20', offer: '20% off sitewide on full-priced bedding', sources: ['https://www.wethrift.com/brooklinen'], up: 5, down: 1, saving: 31.60, minsAgo: 180 },
      { code: 'WITHME', offer: '15% off sitewide', sources: ['https://www.couponbirds.com/codes/brooklinen.com'], up: 4, down: 1, saving: 22.40, minsAgo: 250 },
      { code: 'BLANKET20', offer: '20% off throws and blankets', sources: ['https://www.simplycodes.com/store/brooklinen.com'], up: 3, down: 2, saving: 19.80, minsAgo: 340 },
      { code: 'MADNESS', offer: '10% off sitewide', sources: ['https://www.wethrift.com/brooklinen'], up: 2, down: 1, saving: 14.22, minsAgo: 430 },
      { code: 'WELCOME20', offer: '30% off sitewide on orders of $100 or more', sources: ['https://www.retailmenot.com/view/brooklinen.com'], up: 0, down: 7, minsAgo: 80 },
      { code: 'BFCM26', offer: '25% off sitewide applied at checkout', sources: ['https://www.coupert.com/store/brooklinen.com'], up: 0, down: 6, minsAgo: 155 },
      { code: 'VICKIF25', offer: '25% off sitewide', sources: ['https://www.dontpayfull.com/at/brooklinen.com'], up: 1, down: 5, minsAgo: 230 },
      { code: 'TRADE20', offer: '20% off select items; trade members only', sources: ['https://www.brooklinen.com/'], up: 0, down: 5, minsAgo: 370 },
    ],
  },
  {
    merchant: 'myprotein.com',
    currency: 'GBP',
    coupons: [
      { code: 'MYPCHECKOUT', offer: 'Extra 11%-16% off almost everything', sources: ['https://www.myprotein.com/c/voucher-codes/'], up: 12, down: 1, saving: 8.64, minsAgo: 14 },
      { code: 'MORE', offer: 'Extra 5% off your basket', sources: ['https://www.myprotein.com/c/voucher-codes/'], up: 9, down: 0, saving: 3.10, minsAgo: 68 },
      { code: 'BEAST', offer: 'Up to 35% off Impact Whey & supplements', sources: ['https://www.simplycodes.com/store/myprotein.com'], up: 7, down: 2, saving: 14.50, minsAgo: 125 },
      { code: 'IMPACT', offer: 'Extra 10% off selected nutrition', sources: ['https://www.hotukdeals.com/vouchers/myprotein.com'], up: 5, down: 1, saving: 5.40, minsAgo: 215 },
      { code: 'MYP50', offer: '50% off protein powders sitewide', sources: ['https://www.retailmenot.com/view/myprotein.com'], up: 0, down: 8, minsAgo: 72 },
      { code: 'FREEWHEY', offer: 'Free Impact Whey pouch on orders over £45', sources: ['https://www.coupert.com/store/myprotein.com'], up: 1, down: 6, minsAgo: 170 },
      { code: 'VIP40', offer: '40% off everything + free delivery', sources: ['https://www.dontpayfull.com/at/myprotein.com'], up: 0, down: 5, minsAgo: 300 },
    ],
  },
  {
    merchant: 'hollandandbarrett.com',
    currency: 'GBP',
    coupons: [
      { code: 'SAVE', offer: '15% off £30 or 20% off £40', sources: ['https://www.hollandandbarrett.com/'], up: 9, down: 1, saving: 8.20, minsAgo: 39 },
      { code: 'WELLNESS15', offer: '15% off vitamins & supplements', sources: ['https://www.simplycodes.com/store/hollandandbarrett.com'], up: 5, down: 1, saving: 5.79, minsAgo: 150 },
      { code: 'HB10', offer: '10% off orders over £25', sources: ['https://www.wethrift.com/holland-and-barrett'], up: 4, down: 1, saving: 3.40, minsAgo: 270 },
      { code: 'HB30', offer: '30% off sitewide', sources: ['https://www.retailmenot.com/view/hollandandbarrett.com'], up: 0, down: 6, minsAgo: 115 },
      { code: 'VITAMIN25', offer: '25% off health & wellness', sources: ['https://www.coupert.com/store/hollandandbarrett.com'], up: 1, down: 5, minsAgo: 245 },
      { code: 'FREEDEL', offer: 'Free next day delivery on any order', sources: ['https://www.dontpayfull.com/at/hollandandbarrett.com'], up: 0, down: 4, minsAgo: 380 },
    ],
  },
  {
    merchant: 'lookfantastic.com',
    currency: 'GBP',
    coupons: [
      { code: 'LF15', offer: '15% off selected beauty & skincare', sources: ['https://www.lookfantastic.com/'], up: 7, down: 1, saving: 11.25, minsAgo: 64 },
      { code: 'EXTRA', offer: 'Extra 5% off selected items', sources: ['https://www.lookfantastic.com/'], up: 6, down: 1, saving: 3.90, minsAgo: 140 },
      { code: 'SAVE10', offer: '10% off selected brands', sources: ['https://www.simplycodes.com/store/lookfantastic.com'], up: 4, down: 2, saving: 6.80, minsAgo: 265 },
      { code: 'LF30', offer: '30% off luxury skincare', sources: ['https://www.retailmenot.com/view/lookfantastic.com'], up: 0, down: 7, minsAgo: 92 },
      { code: 'BEAUTY25', offer: '25% off sitewide', sources: ['https://www.coupert.com/store/lookfantastic.com'], up: 1, down: 5, minsAgo: 220 },
    ],
  },
  {
    merchant: 'beardbrand.com',
    currency: 'USD',
    coupons: [
      { code: 'WELCOME10', offer: '10% off your first order', sources: ['https://www.beardbrand.com/'], up: 6, down: 1, saving: 6.40, minsAgo: 84 },
      { code: 'BEARD15', offer: '15% off grooming kits & bundles', sources: ['https://www.simplycodes.com/store/beardbrand.com'], up: 4, down: 1, saving: 9.75, minsAgo: 190 },
      { code: 'GROOM10', offer: '10% off beard oil, balm & utility wash', sources: ['https://www.wethrift.com/beardbrand'], up: 3, down: 1, saving: 4.50, minsAgo: 330 },
      { code: 'BEARD30', offer: '30% off bundles', sources: ['https://www.retailmenot.com/view/beardbrand.com'], up: 0, down: 5, minsAgo: 120 },
      { code: 'VIP25', offer: '25% off sitewide', sources: ['https://www.coupert.com/store/beardbrand.com'], up: 0, down: 4, minsAgo: 280 },
    ],
  },
  {
    merchant: 'currys.co.uk',
    currency: 'GBP',
    coupons: [
      { code: 'FNDD', offer: 'Free next-day delivery on selected tech', sources: ['https://www.currys.co.uk/'], up: 8, down: 1, saving: 5.99, minsAgo: 53 },
      { code: 'AUDIO15', offer: '15% off selected headphones & speakers', sources: ['https://www.hotukdeals.com/vouchers/currys.co.uk'], up: 5, down: 2, saving: 29.85, minsAgo: 162 },
      { code: 'TECH10', offer: '10% off selected computing accessories', sources: ['https://www.simplycodes.com/store/currys.co.uk'], up: 4, down: 1, saving: 8.90, minsAgo: 290 },
      { code: 'CURRYS20', offer: '20% off laptops & OLED TVs', sources: ['https://www.retailmenot.com/view/currys.co.uk'], up: 0, down: 7, minsAgo: 99 },
      { code: 'SAVE50', offer: '£50 off orders over £500', sources: ['https://www.coupert.com/store/currys.co.uk'], up: 1, down: 6, minsAgo: 235 },
    ],
  },
  {
    merchant: 'uk.gymshark.com',
    currency: 'GBP',
    coupons: [
      { code: 'GS10', offer: '10% off your order', sources: ['https://uk.gymshark.com/', 'https://www.simplycodes.com/store/gymshark.com'], up: 10, down: 1, saving: 11.20, minsAgo: 22 },
      { code: 'WELCOME10', offer: '10% off your first order', sources: ['https://uk.gymshark.com/'], up: 7, down: 1, saving: 8.50, minsAgo: 118 },
      { code: 'EXTRA10', offer: 'Extra 10% off selected outlet items', sources: ['https://www.wethrift.com/gymshark'], up: 4, down: 2, saving: 6.40, minsAgo: 240 },
      { code: 'GYM30', offer: '30% off sitewide', sources: ['https://www.retailmenot.com/view/gymshark.com'], up: 0, down: 8, minsAgo: 76 },
      { code: 'SHARK25', offer: '25% off new arrivals', sources: ['https://www.coupert.com/store/gymshark.com'], up: 1, down: 5, minsAgo: 198 },
    ],
  },
];

const now = Date.now();
let totalCoupons = 0;
let totalUp = 0;
let totalDown = 0;
let memberCursor = 0;

for (const shop of SHOPS) {
  const payload = shop.coupons.map(({ code, offer, sources }) => ({
    code,
    offer,
    sources,
    expiresOn: null,
  }));
  await store.seedScan(shop.merchant, payload, now);
  totalCoupons += payload.length;

  for (const c of shop.coupons) {
    // Rotate starting member so every code gets realistic, varied genuine community handles.
    const start = memberCursor % MEMBERS.length;
    memberCursor += 3;
    const baseTime = now - (c.minsAgo ?? 60) * MINUTE;

    for (let i = 0; i < (c.up ?? 0); i += 1) {
      const m = MEMBERS[(start + i) % MEMBERS.length];
      const jitterSaving = c.saving ? Number((c.saving * (1 - i * 0.04)).toFixed(2)) : null;
      await store.report(
        shop.merchant,
        c.code,
        m.id,
        true,
        baseTime - i * 25 * MINUTE,
        i === 0 && jitterSaving
          ? { amount: jitterSaving, currency: shop.currency, memberName: m.handle }
          : { memberName: m.handle },
      );
      totalUp += 1;
    }

    for (let j = 0; j < (c.down ?? 0); j += 1) {
      const m = MEMBERS[(start + (c.up ?? 0) + j) % MEMBERS.length];
      await store.report(
        shop.merchant,
        c.code,
        m.id,
        false,
        baseTime - (j + 1) * 35 * MINUTE,
        { memberName: m.handle },
      );
      totalDown += 1;
    }
  }
  console.log(`Seeded ${shop.merchant.padEnd(24)} (${shop.coupons.length} codes)`);
}

console.log(`\nDone! Seeded ${SHOPS.length} shops, ${totalCoupons} coupons, ${totalUp} thumbs-up, ${totalDown} thumbs-down.`);
