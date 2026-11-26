# Replay folder

Saved answers the API gives back when it runs with `OXYLABS_MODE=replay`. In that mode the server never calls Oxylabs and needs no Oxylabs key.

```bash
npm run start:replay
```

That command reads `.env.clerk` only, so the Oxylabs key in `.env` is never loaded. Set `PORT`, `HOST` or `DATABASE_PATH` in front of it if you changed them in `.env`.

## What replay answers from

1. **The database.** A scan is answered from the most recent saved scan of that shop by any member, however old. A price lookup is answered from the saved lookup for the same shop, country, product name and variant.
2. **This folder**, when the database has nothing. Every `.json` file here is one saved answer. Files are read again when they change, so you can add one without restarting the server.

Anything that is in neither place takes the same path as a shop or retailer that could not be read: the member sees the usual “couldn’t check” message, and nothing is sent.

Use another folder with `OXYLABS_REPLAY_DIR=/path/to/folder`.

## File formats

A file is recognised by its shape, not its name.

### A price lookup

The body `POST /v1/alternatives` returns. `lookup-vanilla-900g.json` is a real answer saved on 25 November 2026.

```json
{
  "country": "GB",
  "results": [
    {
      "name": "Myprotein Impact Whey Protein Powder",
      "variant": "Vanilla, 30 servings / 900g",
      "offers": [
        {
          "title": "Myprotein Impact Whey Protein Powder",
          "variant": "Vanilla, 30 servings / 900g",
          "match": "exact",
          "retailer": "amazon.co.uk",
          "url": "https://www.amazon.co.uk/…",
          "price": 33.14,
          "currency": "GBP",
          "stockText": "In stock",
          "availability": "in_stock"
        }
      ],
      "partial": true
    }
  ]
}
```

It answers a lookup with the same `country`, product `name` and `variant` (capital letters and extra spaces do not matter). Add `"merchant": "myprotein.com"` at the top to make it answer for that shop only. Without it, the file answers wherever the product is asked about.

### A shop scan

The body `POST /v1/coupons` returns, or a shorter form with only what matters:

```json
{
  "merchant": "example-shop.com",
  "fetchedAt": "2026-11-25T21:33:03.000Z",
  "coupons": [
    { "code": "WELCOME10", "offer": "10% off your first order", "sources": ["https://example-shop.com/offers"], "expiresOn": null }
  ]
}
```

`fetchedAt` is when the pages were read. Leave it out and the file’s own date is used. Add `"partial": true` for a scan that could not read every source.

## Codes without a file

To put codes for a shop straight into the database, use the seed tool. It writes nothing to this folder, and what it writes is marked as seeded.

```bash
npm run seed:scan -- example-shop.com WELCOME10="10% off your first order" FREESHIP
```
