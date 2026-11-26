---
name: CartScout
description: A friendly coupon extension. Sticker yellow on white and warm ink, one rounded typeface, a small yellow cart called Scout, and confetti only when money was really saved.
colors:
  sticker-yellow: "#ffd23f"
  sticker-yellow-bright: "#ffdc66"
  sticker-yellow-deep: "#e2ae00"
  sticker-yellow-soft: "#fff0b3"
  sticker-yellow-faint: "#fffae0"
  ink: "#1f1b16"
  ink-muted: "#5d574d"
  ink-faint: "#726a5e"
  canvas: "#ffffff"
  surface: "#f6f4ef"
  ticket-paper: "#fffbe8"
  saved-green: "#0a7a50"
  saved-green-soft: "#daf5e6"
  saved-green-solid: "#11a26a"
  error-red: "#b3261e"
  error-red-soft: "#fde7e4"
  party-pink: "#ff6fa5"
  party-sky: "#4db8ff"
  party-mint: "#2fcf8f"
  night-canvas: "#171510"
  night-surface: "#211e17"
  night-paper: "#26221a"
  night-ink: "#fbf8ef"
  night-muted: "#b9b2a4"
  night-faint: "#b1ab9e"
  night-yellow-deep: "#b48a00"
  night-yellow-soft: "#4a3f17"
  night-yellow-faint: "#2c2715"
  night-green: "#7fdcae"
  night-green-soft: "#173527"
  night-green-solid: "#1f9a67"
  night-red: "#ff9d94"
  night-red-soft: "#45211e"
typography:
  display:
    fontFamily: Nunito
    fontSize: 2.5rem
    fontWeight: 900
    lineHeight: 1
    letterSpacing: -0.02em
    fontFeature: tabular-nums
  headline:
    fontFamily: Nunito
    fontSize: 1.375rem
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: -0.01em
  title:
    fontFamily: Nunito
    fontSize: 1.125rem
    fontWeight: 800
    lineHeight: 1.25
  body:
    fontFamily: Nunito
    fontSize: 0.84375rem
    fontWeight: 600
    lineHeight: 1.4
  label:
    fontFamily: Nunito
    fontSize: 0.9375rem
    fontWeight: 800
    lineHeight: 1.1
  code:
    fontFamily: JetBrains Mono
    fontSize: 1.1875rem
    fontWeight: 800
    lineHeight: 1.2
  subtitle:
    fontFamily: Nunito
    fontSize: 1.0625rem
    fontWeight: 800
    lineHeight: 1.25
  meta:
    fontFamily: Nunito
    fontSize: 0.78125rem
    fontWeight: 600
    lineHeight: 1.35
  small:
    fontFamily: Nunito
    fontSize: 0.75rem
    fontWeight: 600
    lineHeight: 1.35
  display-long:
    fontFamily: Nunito
    fontSize: 2.375rem
    fontWeight: 900
    lineHeight: 1.2
    fontFeature: tabular-nums
  welcome:
    fontFamily: Nunito
    fontSize: 1.5625rem
    fontWeight: 900
    lineHeight: 1.15
  saved-headline:
    fontFamily: Nunito
    fontSize: 1.25rem
    fontWeight: 900
    lineHeight: 1.2
rounded:
  xs: 4px
  sm: 8px
  md: 14px
  lg: 20px
  full: 999px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
components:
  button-primary:
    backgroundColor: "{colors.sticker-yellow}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: 0 20px
    height: 44px
  button-primary-hover:
    backgroundColor: "{colors.sticker-yellow-bright}"
    textColor: "{colors.ink}"
  button-secondary:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: 0 20px
    height: 44px
  ticket:
    backgroundColor: "{colors.ticket-paper}"
    textColor: "{colors.ink}"
    typography: "{typography.code}"
    rounded: "{rounded.md}"
  ticket-stub:
    backgroundColor: "{colors.sticker-yellow}"
    textColor: "{colors.ink}"
  ticket-stub-copied:
    backgroundColor: "{colors.sticker-yellow-soft}"
    textColor: "{colors.ink}"
  tab-selected:
    backgroundColor: "{colors.sticker-yellow}"
    textColor: "{colors.ink}"
    rounded: "{rounded.full}"
  panel:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    width: 360px
  panel-saved:
    backgroundColor: "{colors.sticker-yellow}"
    textColor: "{colors.ink}"
---

# Design System: CartScout

The source of truth for how CartScout looks, moves and talks. The values above are normative and live in [`extension/brand.css`](extension/brand.css), which every surface imports.

## Overview

**Creative North Star: "The Yellow Sticker"**

In UK shops a yellow sticker means "this just got cheaper". CartScout is a sheet of them: bright, rounded, tactile and quick. **Scout, a small yellow shopping cart, goes and finds the codes so you don't have to.** Fun comes from Scout and from motion at real wins; the reading surface stays calm and honest.

Key characteristics:

- One saturated colour does the talking. Yellow marks the one thing worth pressing and the thing you just saved.
- One rounded typeface, heavy where it matters. Codes are the only monospace.
- Things you can press feel pressable. Tickets look like tickets.
- Nothing moves unless the shopper moved it or something real happened.
- Dark mode is a first-class theme: most people who install this browse in the dark.

## Colors

Roles, not decoration. Light and dark values are both in `brand.css`.

- **Primary: sticker yellow** (`--sun`). The one primary action in a view, Scout, the highlighter, the selected tab. `--sun-soft` and `--sun-faint` are ticket stubs and gentle highlights. `--sun-deep` is the button's lower edge.
- **Neutral: warm ink on white** (`--ink`, `--muted`, `--faint` on `--canvas`, `--surface`, `--paper`). All text is ink. `--faint` only on `--canvas` or `--paper`. On yellow, secondary text is ink at reduced strength, never grey.
- **Secondary: saved green** (`--green`, `--green-soft`, `--green-solid`). A confirmed saving, an applied code, a thumbs-up that leads. Nothing else.
- **Tertiary: party colours** (`--pink`, `--sky`, `--mint`). Confetti, Scout's pennant and the tickets in Scout's basket. Never text or controls.
- **Error red** (`--red`, `--red-soft`). Errors and rejected codes only.

**The One Yellow Rule.** One yellow primary button per view. Everything else is secondary or quiet. The only other place yellow lives is on the things themselves: a ticket's stub (bright while the code is unused, soft once copied), the selected tab, Scout and the highlighter.

**The Ink Reads Rule.** Yellow never carries text on a light surface. On dark surfaces yellow text is allowed for small accents such as the Pro badge.

## Typography

- **Nunito** (variable, bundled) for everything people read: 600 body, 700 emphasis, 800 headings and buttons, 900 hero numbers.
- **JetBrains Mono** 700 to 800 for coupon codes only.
- Popup scale in rem: `.75` small print, `.78125` meta, `.84375` body, `.9375` buttons, `1.0625` subtitle, `1.125` title, `1.1875` codes, `1.25` the saved headline in the pinned bar, `1.375` section hero, `1.5625` the welcome headline, `2.5` money hero (`2.375` when the amount is long, so it never wraps). Nothing under 12px.
- `font-variant-numeric: tabular-nums` on any number that changes. `text-wrap: balance` on headings and short messages.
- Fonts are local files with `font-display: block` and a preload, so text never swaps.

## Layout

- **The popup is a fixed stage: 380 × 560 CSS px.** Header, tab bar and footer have fixed heights; only `main` scrolls, with a stable scrollbar gutter. On a screen too short for Chrome to give it 560px, the stage takes the height it is given (never under 320px): header, tab bar, pinned bar and footer keep their heights and only `main` gets shorter.
- **The coupon list** is tight on purpose so three tickets show above the pinned bar: 6px between tickets, 14px group headings.
- **The in-page panel** is 360px wide and never changes size. It sits in a corner of the shop page with a 16px inset: the corner that leaves the promo field, the subtotal and the pay button uncovered. It keeps that corner for the whole run.
- **The portal** is a single centred column up to 70rem with one shared left edge for header and content, and no horizontal scroll from 320px.
- Spacing sits on a 4px base. Tight inside a group, generous between groups.

**The Stay Put Rule.** Every async region reserves its final box. Skeletons match the real thing exactly. Things appear by fading or sliding inside reserved space or on an overlay layer; nothing is inserted above content already on screen; a button keeps its width when its label changes; images and SVG carry their dimensions.

## Elevation & Depth

Flat by default. Two kinds of depth exist:

- **The pressed edge**: primary and secondary buttons sit on a 3px lower edge and sink 2px when pressed.
- **`--shadow-pop`**: a soft, offset shadow for things that float over someone else's web page (the in-page panel) and for menus.

No gradients, glass, glow or coloured shadows anywhere.

## Shapes

- Radii: 4px for small marks, 8px small, 14px medium, 20px large, pill. Marks under 8px may soften their corners by 1px.
- **Tickets**: coupon codes are perforated tickets with real notches, a `--paper` body and a sticker-yellow stub. Every ticket is the same height.
- Dividers are 1px `--line`. Secondary controls use a 2px `--edge` outline.
- Icons are drawn outlines in one 1.6 stroke. No emoji.

## Components

- **Pressable buttons** (`.primary`, `.secondary` in `brand.css`). Quiet buttons are plain text with a fill on hover.
- **Ticket**: the code (mono), the offer (two lines), and one line of small print: thumbs up and thumbs down with their counts, then where the code was seen and when it ends. The stub copies the code, then asks "Did it work?" with the same two thumbs.
- **Tab bar**: "Coupons" and "Other retailers", always present, yellow thumb.
- **Pinned bar**: the basket action ("Try N codes at checkout") and the run card live in one overlay bar at the bottom of the list.
- **In-page panel**: tries codes on the shop's own page and celebrates the saving there. The result ticket carries the same two thumbs as the popup's, so a code can be rated without opening the popup. A scan that finishes after the popup has closed is announced in the same corner by a small notice. After a stop, or when the shop gave no clear answer, the panel offers a secondary "Try the rest" beside Done; it is never offered while a code is on the basket or the shop has asked for a pause.
- **Highlighter** (`.swipe`): a swipe of yellow under the words that matter.
- **Scout**: see below.

## Do's and Don'ts

Do:

- Give every state a single obvious next step, or none.
- Name the code being tried and how many remain. Show real progress only.
- Celebrate a confirmed saving and unlocking Pro. Use `sparkle()` for small wins such as fresh codes or a thumbs-up.
- Keep every pose and state change when motion is reduced; remove only the movement.

Don't:

- Nest cards, add side-stripe borders, put icons in decorative circles, or place a small label above a heading.
- Fire confetti on page load, on a copy, or for anything that is not money saved or Pro unlocked.
- Promise a code will work. They are public finds, not guarantees.
- Let anything pulse or loop when nothing is loading.

## Voice

- Short, plain, warm. Second person. British English (basket, colour).
- Scout is the helper: "Scout found 3 codes". CartScout is the product name. Scout never speaks in speech bubbles.
- Honest about uncertainty: "possible codes", "couldn't confirm the total". Never "guaranteed".
- Buttons are verb + object: "Scan this shop", "Try codes at checkout", "Copy".
- Errors say what happened and what to do next, in one or two sentences.
- At most one exclamation mark per screen, and only at a real win.

## Scout

Markup in [`extension/scout.js`](extension/scout.js), motion in [`extension/scout.css`](extension/scout.css). Use `mountScout(element, { mood, tile, sticker })` into an element whose size is already set in CSS. `tile` is the brand mark on the ink tile (the toolbar icon and the portal header). `sticker` gives Scout a white die-cut edge and is the only way Scout appears on a yellow surface.

| Mood | When |
| --- | --- |
| `idle` | Resting |
| `wave` | First hello: signed out, portal welcome |
| `search` | Scanning a shop, comparing prices |
| `work` | Trying codes at checkout |
| `happy` | Codes found, a thumbs-up |
| `party` | A confirmed saving, Pro unlocked |
| `shrug` | No codes, no saving |
| `oops` | Something failed |

One Scout per view. In the popup header Scout mirrors what the app is doing. A large Scout (96 to 128px) carries empty, waiting and celebration states.

Scout only keeps moving while work is happening: `search` and `work` loop for as long as the scan or the run lasts. Every other mood plays a fixed number of times and then rests.

## Motion

Motion explains where things came from, rewards real wins, and never makes anyone wait.

- Animate `transform`, `translate`, `scale`, `rotate` and `opacity` only. Never animate layout.
- Content is usable within 300ms of opening. Every sequence can be interrupted.
- `--quick` 140ms for presses and hovers, `--base` 240ms for state changes, `--slow` 420ms for entrances. Exits are faster than entrances.
- `--ease-out` for entrances, `--ease-in-out` for moves, `--ease-pop` only for stickers, badges and Scout.

Signature moves (helpers in [`extension/motion.js`](extension/motion.js), confetti in [`extension/confetti.js`](extension/confetti.js)):

1. **Deal in**: lists arrive one after another, 55ms apart, rising 12px (`dealIn`).
2. **Sticker press**: badges and hero art land slightly large and tilted, then settle (`stickOn`).
3. **Highlighter**: a yellow swipe draws under the words that matter (`drawSwipe`).
4. **Count up**: money counts to its value in about 900ms (`countUp`).
5. **Departure board**: the code being tried rolls into place (`rollText`).
6. **Confetti**: `celebrate()` and `sparkle()`, in the brand's own colours.

## Surfaces

- **Popup** (`extension/popup.*`): the main tool. Scan, copy, vote, try, compare.
- **In-page panel** (`extension/panel/*`): floats in a clear corner of the shop's page while Scout tries codes, and stays after the popup closes.
- **Account portal** (`portal/`): sign in, plans and billing with Clerk components themed to this system.
