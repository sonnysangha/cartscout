import assert from 'node:assert/strict';
import test from 'node:test';
import { formatMoney, moneyFromMinor, parseMoney, sameCurrency } from '../extension/autotry/money.js';

test('parseMoney handles major international formats, separators and currency symbols', () => {
  const cases = [
    ['£49.99', 49.99, 'GBP'],
    ['£1,249.50', 1249.5, 'GBP'],
    ['$19.95', 19.95, ''],
    ['US$ 120.00', 120, 'USD'],
    ['CA$84.50', 84.5, 'CAD'],
    ['AU$ 1,299.00', 1299, 'AUD'],
    ['€49,90', 49.9, 'EUR'],
    ['1.234,56 €', 1234.56, 'EUR'],
    ['1 234,56 €', 1234.56, 'EUR'],
    ['1\u00a0234,56 €', 1234.56, 'EUR'],
    ['CHF 1\'234.50', 1234.5, 'CHF'],
    ['CHF 1’234.50', 1234.5, 'CHF'],
    ['149,00 zł', 149, 'PLN'],
    ['1 299 kr', 1299, ''],
    ['SEK 499,00', 499, 'SEK'],
    ['DKK 349,50', 349.5, 'DKK'],
    ['¥12,800', 12800, 'JPY'],
    ['￥12,800', 12800, 'JPY'],
    ['₹1,499.00', 1499, 'INR'],
    ['R$ 249,90', 249.9, 'BRL'],
    ['1 490 Kč', 1490, 'CZK'],
    ['12.345 KWD', 12.345, 'KWD'],
    ['GBP £62.00', 62, 'GBP'],
    ['89,95 EUR', 89.95, 'EUR'],
    ['$1,200', 1200, ''],
  ];

  for (const [text, expectedValue, expectedCurrency] of cases) {
    const parsed = parseMoney(text);
    assert.ok(parsed, `failed to parse: ${text}`);
    assert.equal(parsed.value, expectedValue, text);
    assert.equal(parsed.currency, expectedCurrency, text);
  }
});

test('parseMoney rejects non-totals, negative numbers, percentages, instalments and multiple prices', () => {
  for (const bad of [
    '',
    '   ',
    'Free',
    '-£10.00',
    '−€5,00',
    '£-10.00',
    '£0.00',
    '0.00 EUR',
    '20% off',
    '£10.00 £20.00',
    '£15.00/mo with Klarna',
    '4 interest-free payments of £12.50',
    '3 instalments of €20,00',
    '123456',
  ]) {
    assert.equal(parseMoney(bad), null, `should reject: ${bad}`);
  }
});

test('parseMoney accepts bare numbers only when allowBare is explicitly set', () => {
  assert.equal(parseMoney('49.99'), null);
  const bare = parseMoney('49.99', { allowBare: true, currency: 'GBP' });
  assert.deepEqual([bare.value, bare.currency], [49.99, 'GBP']);
});

test('formatMoney mirrors the shop formatting and moneyFromMinor converts integer minor units', () => {
  const eur = parseMoney('1.234,56 €');
  assert.equal(formatMoney(12.4, eur.format, eur.currency), '12,40 €');

  const gbp = parseMoney('£62.00');
  assert.equal(formatMoney(12.4, gbp.format, gbp.currency), '£12.40');

  const chf = parseMoney("CHF 1'234.50");
  assert.equal(formatMoney(1000.5, chf.format, chf.currency), "CHF 1'000.50");

  const jpy = moneyFromMinor(12800, 'JPY');
  assert.equal(jpy.value, 12800);
  assert.equal(jpy.text, '¥12,800');

  const kwd = moneyFromMinor(12345, 'KWD');
  assert.equal(kwd.value, 12.345);
  assert.equal(kwd.currency, 'KWD');

  const usd = moneyFromMinor(4995, 'USD');
  assert.equal(usd.value, 49.95);
  assert.equal(usd.text, '$49.95');
});

test('sameCurrency checks currency compatibility strictly when both sides know currency', () => {
  assert.equal(sameCurrency({ currency: 'GBP' }, { currency: 'GBP' }), true);
  assert.equal(sameCurrency({ currency: 'GBP' }, { currency: 'EUR' }), false);
  assert.equal(sameCurrency({ currency: 'GBP', format: { prefix: '£', suffix: '' } }, { currency: '', format: { prefix: '£', suffix: '' } }), true);
  assert.equal(sameCurrency({ currency: '', format: { prefix: '$', suffix: '' } }, { currency: '', format: { prefix: '$', suffix: '' } }), true);
});
