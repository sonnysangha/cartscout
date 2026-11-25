const matchLabels = {
  exact: 'Exact match',
  different_variant: 'Different variant',
  unconfirmed: 'Variant unconfirmed',
};

const matchTones = { exact: 'positive', different_variant: 'caution' };

function withText(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

export function createRetailerOffer(offer) {
  const row = document.createElement('li');
  row.className = 'retailer-offer';

  const link = document.createElement('a');
  link.className = 'retailer-link';
  link.href = offer.url;
  link.target = '_blank';
  link.rel = 'noreferrer';

  const shop = withText('span', 'retailer-name', offer.retailer);
  const price = new Intl.NumberFormat(navigator.language, {
    style: 'currency', currency: offer.currency,
  }).format(offer.price);
  const priceLabel = withText('span', 'retailer-price', price);
  priceLabel.append(withText('small', 'retailer-currency', offer.currency));
  link.append(shop, priceLabel);
  row.append(link, withText('p', 'retailer-title', offer.title));

  if (offer.variant) row.append(withText('p', 'retailer-variant', offer.variant));

  const inStock = offer.availability === 'in_stock';
  const details = document.createElement('p');
  details.className = 'offer-details';
  details.append(
    withText('span', `offer-label ${matchTones[offer.match] ?? ''}`.trim(), matchLabels[offer.match] ?? matchLabels.unconfirmed),
    withText('span', inStock ? 'offer-label positive' : 'offer-label', inStock ? 'Listed in stock' : 'Stock unconfirmed'),
  );
  row.append(details);
  return row;
}
