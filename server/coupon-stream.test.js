import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeProgressCoupons, readCouponStream } from '../extension/coupon-stream.js';

const encode = (frame) => new TextEncoder().encode(frame);

test('a coupon progress frame is consumed before the final response arrives', async () => {
  let send;
  const body = new ReadableStream({ start(controller) { send = controller; } });
  let received;
  const firstUpdate = new Promise(resolve => { received = resolve; });
  const result = readCouponStream(body, received);
  send.enqueue(encode('{"type":"connected"}\n{"type":"pro'));
  send.enqueue(encode('gress","checked":1,"total":20,"coupons":[{"code":"SAVE10"}]}\n'));
  assert.deepEqual(await firstUpdate, { type: 'progress', checked: 1, total: 20, coupons: [{ code: 'SAVE10' }] });

  const final = { type: 'result', status: 200, data: { coupons: [{ code: 'SAVE10' }, { code: 'SAVE20' }] } };
  send.enqueue(encode(`${JSON.stringify(final)}\n`));
  assert.deepEqual(await result, final);
});

test('an interrupted coupon stream cannot be mistaken for a finished scan', async () => {
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(encode('{"type":"connected"}\n'));
    controller.close();
  } });
  await assert.rejects(readCouponStream(body, () => {}), /closed before CartScout sent the result/);
});

test('progress keeps saved votes and terms while appending new provisional codes', () => {
  const saved = { code: 'SAVE10', offer: 'On orders over £50', worked: 2, sources: ['https://shop.example.com'] };
  const duplicate = { code: 'save10', offer: '10% off', sources: ['https://coupon.example.org'] };
  const fresh = { code: 'SAVE20', offer: '20% off shoes', sources: ['https://coupon.example.org'] };
  assert.deepEqual(mergeProgressCoupons([saved], [duplicate, fresh]), [
    { ...saved, expiresOn: undefined, sources: [...saved.sources, ...duplicate.sources] },
    { ...fresh, pending: true },
  ]);
});
