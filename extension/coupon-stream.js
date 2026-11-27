export const COUPON_STREAM_TYPE = 'application/x-ndjson';

export async function readCouponStream(body, onProgress) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        const event = JSON.parse(line);
        if (event.type === 'progress') onProgress(event);
        if (event.type === 'result') return event;
      }
    }
    throw new Error('The scan connection closed before CartScout sent the result.');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function mergeProgressCoupons(saved, found) {
  const byCode = new Map(saved.map(coupon => [coupon.code.toUpperCase(), coupon]));
  for (const coupon of found) {
    const code = coupon.code.toUpperCase();
    const previous = byCode.get(code);
    byCode.set(code, previous ? {
      ...coupon,
      ...previous,
      offer: previous.offer || coupon.offer,
      expiresOn: previous.expiresOn ?? coupon.expiresOn,
      sources: [...new Set([...(previous.sources ?? []), ...coupon.sources])],
    } : { ...coupon, pending: true });
  }
  return [...byCode.values()];
}
