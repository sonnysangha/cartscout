# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **The shopper at the basket.** Has a full basket on a UK shop, sees an empty promo code box, and would rather not spend ten minutes on coupon sites. Wants a code that works or a clear "there isn't one", in under a minute.
- **The comparison shopper.** Wants to know whether the same basket is cheaper at another retailer before paying.
- **The builder following the tutorial.** A developer who installs CartScout from this repository to learn how the Oxylabs Web API, Clerk and a Chrome extension fit together. Reads the code as closely as the screen.

## Product Purpose

CartScout is a Chrome extension that checks a basket before you buy. It finds publicly listed promo codes for the shop you are on, tries them at a supported checkout, keeps the one that works, and can compare the same basket at other retailers.

## Positioning

A friendly, honest alternative to coupon extensions that interrupt and overpromise. CartScout only acts when asked, says where a code came from, and says so plainly when nothing works.

## Operating Context

- Opened from the Chrome toolbar on a shop page, usually mid-purchase, often in dark mode, for a few seconds at a time.
- The toolbar popup closes the moment the page is clicked, so anything long-running has to live on the page itself.
- A scan can take up to a minute. Trying codes takes a few seconds per code.

## Capabilities and Constraints

- Coupon discovery and automatic coupon trying work on public HTTPS shops (26 built-in platform recipes, 10-language heuristic detection, and a shopper-picked box fallback). Whole-basket reading for Other retailers works on Myprotein UK today.
- Free accounts get five live scans a week (resets Mondays 00:00 UTC) with a private cache. Pro accounts scan without a personal limit and share finds with other Pro accounts.
- The extension asks for `activeTab` and `scripting` only. It never runs on a page until the shopper opens it there.
- Codes are public finds, not guarantees. A code can be listed and still be refused by a basket.
- Sign-in, plans and billing are Clerk components hosted in the account portal.

## Brand Commitments

- **Scout does the legwork.** The mascot, a small yellow shopping cart called Scout, stands for the work the product does on the shopper's behalf.
- **Honest about what it knows.** "Possible codes", never "guaranteed savings". A null result is stated as reassurance, not hidden.
- **Celebrate real money only.** Confetti is for a saving confirmed against the basket total, or for unlocking Pro. Nothing else.
- **Never in the way.** No pop-ups the shopper did not ask for, nothing covering the shop's own controls, every sequence can be stopped.

## Evidence on Hand

- The generic auto-try engine (recipes, 10-language finder, multi-currency parser, evidence verdicts, worker reload loop, and THG Myprotein parity) is covered by automated tests.
- Plan limits, Oxylabs spend budgets/replay, cache freshness and reports are covered by server tests.
- No user research or conversion data exists yet.

## Product Principles

1. **One obvious next step.** Every state shows a single primary action or none.
2. **Show the work, truthfully.** Name the code being tried and how many remain. Never invent progress.
3. **Stay put.** Nothing on screen moves unless the shopper moved it.
4. **Friendly, not noisy.** Personality lives in Scout and at real wins; the reading surface stays calm.
5. **Useful when it fails.** Errors and empty results say what happened and what to try next.

## Accessibility & Inclusion

- WCAG 2.2 AA: 4.5:1 text contrast in light and dark, visible focus, full keyboard access, 24px minimum targets (32px for anything pressed often).
- `prefers-reduced-motion` keeps every state change and removes the movement, including confetti.
- Status changes are announced with live regions. Colour is never the only signal.
- British English throughout.
