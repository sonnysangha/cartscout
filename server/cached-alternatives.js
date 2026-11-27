// Read shared product comparisons without starting or retrying a retailer lookup.
export async function cachedAlternatives(store, merchant, { country, items }, now = Date.now()) {
  const results = await Promise.all(items.map(async (item) => {
    const saved = await store.lookup(merchant, country, item);
    if (!saved || saved.freshUntil <= now || !saved.offers.length) return null;
    return {
      ...item,
      offers: saved.offers,
      partial: saved.partial,
      fetchedAt: new Date(saved.fetchedAt).toISOString(),
      freshUntil: new Date(saved.freshUntil).toISOString(),
    };
  }));
  return { country, results: results.filter(Boolean) };
}
