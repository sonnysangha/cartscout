// Reads the product a shop page is selling, so CartScout can look for it at other retailers.
// It runs inside the page through chrome.scripting.executeScript({ func }), so everything it needs is inside the function.
// Order of trust: the shop's own structured data (JSON-LD, then microdata), then Open Graph, then the page heading.
// When that data does not say which size or flavour is showing, the options selected on screen fill in the variant.
export function readPageProduct(root = document, place = location) {
  // Never treat a basket, cart or checkout page as a single product page.
  if (/(?:^|\/)(?:cart|basket|my\.basket|bag|checkout|checkouts|warenkorb|kasse|panier|carrito|cesta|carrello|winkelwagen)(?:\/|$)/i.test(String(place?.pathname ?? ''))) {
    return null;
  }
  const text = (value, limit) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '');
  const list = (value) => (value == null ? [] : [].concat(value));
  const currencyCode = (value) => (typeof value === 'string' && /^[A-Za-z]{3}$/.test(value.trim()) ? value.trim().toUpperCase() : '');

  const isOffscreen = (element) => {
    if (!element) return true;
    const styleOf = root.defaultView?.getComputedStyle?.bind(root.defaultView) ?? globalThis.getComputedStyle;
    for (let node = element, steps = 0; node && steps < 6; node = node.parentElement, steps += 1) {
      if (node.hidden || node.getAttribute?.('aria-hidden') === 'true') return true;
      const cls = String(node.getAttribute?.('class') ?? '');
      if (/\b(?:a-offscreen|sr-only|visually-hidden|screen-reader(?:-text|-only)?|offscreen)\b/i.test(cls)) return true;
      if (typeof styleOf === 'function') {
        try {
          const st = styleOf(node);
          if (st?.display === 'none' || st?.visibility === 'hidden') return true;
          const w = parseFloat(st?.width);
          const h = parseFloat(st?.height);
          if (w > 0 && w <= 2 && h > 0 && h <= 2 && st?.overflow === 'hidden') return true;
        } catch { /* ignore */ }
      }
    }
    const rect = element.getBoundingClientRect?.();
    const bodyRect = root.body?.getBoundingClientRect?.();
    if (bodyRect?.width > 0 && rect && rect.width <= 1 && rect.height <= 1) return true;
    return false;
  };
  const isBoilerplateHeading = (raw) => /\b(?:keyboard shortcut|presents key product information|skip to (?:main|content)|your (?:shopping )?(?:basket|cart|bag))\b/i.test(raw);
  const pickVisibleHeading = () => {
    const direct = root.querySelector('#productTitle, [data-testid="product-title"], [data-test="product-title"]');
    if (direct && !isOffscreen(direct)) {
      const t = text(direct.textContent, 300);
      if (t.length >= 3 && !isBoilerplateHeading(t)) return { element: direct, title: t };
    }
    const allH1 = [...(root.querySelectorAll?.('h1') ?? [])];
    const h1s = allH1.length ? allH1 : [root.querySelector?.('h1')].filter(Boolean);
    for (const h1 of h1s) {
      if (isOffscreen(h1)) continue;
      const t = text(h1.textContent, 300);
      if (t.length >= 3 && !isBoilerplateHeading(t)) return { element: h1, title: t };
    }
    return null;
  };

  // "1,299.00" and "1.299,00" both mean 1299: a final separator followed by one or two digits is the decimal point,
  // and so is a lone dot followed by four or more ("34.9900"). Two numbers ("9.99-19.99", "£49.99 £39.99") are a
  // range or a pair of prices, never one amount.
  const amount = (value) => {
    if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
    if (typeof value !== 'string') return null;
    // "1 299,00": a space can separate thousands.
    const numbers = value.replace(/(\d)[ \u00a0\u202f](?=\d{3}(?:\D|$))/g, '$1').match(/\d[\d.,]*/g);
    if (!numbers || numbers.length !== 1) return null;
    const digits = numbers[0].replace(/[.,]+$/, '');
    const decimal = digits.match(/[.,](\d{1,2})$/) ?? (/^\d+\.\d{4,}$/.test(digits) ? digits.match(/\.(\d+)$/) : null);
    const whole = (decimal ? digits.slice(0, decimal.index) : digits).replace(/[.,]/g, '');
    if (!whole && !decimal) return null;
    const parsed = Number((whole || '0') + (decimal ? `.${decimal[1]}` : ''));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };

  // The shop's own name is the label before its public suffix: "gymshark" in uk.gymshark.com, "shop" in www.shop.co.uk.
  const labels = String(place.hostname ?? '').toLowerCase().split('.').filter(Boolean);
  const suffixed = labels.length >= 3 && labels.at(-1).length === 2 && /^(?:co|com|org|net|ac|gov|ne|or)$/.test(labels.at(-2));
  const siteName = (labels.at(suffixed ? -3 : -2) ?? labels[0] ?? '').replace(/[^a-z0-9]/g, '');
  // "Sony WH-1000XM5 | Currys" names the shop last; the shop is not part of the product. The last part has to be the
  // shop's name ("Currys", "Amazon.co.uk", "Myprotein UK"), not merely contain a few of its letters: "Rust" is a colour.
  const withoutSite = (title) => {
    const parts = title.split(/\s+[|–—-]\s+/);
    const last = parts.at(-1).replace(/[^a-z0-9]/gi, '').toLowerCase();
    const isShop = siteName.length >= 3 && last.length >= 3
      && (last === siteName || (siteName.length >= 4 && last.startsWith(siteName)) || (last.length >= 4 && siteName.startsWith(last)));
    return parts.length > 1 && isShop ? parts.slice(0, -1).join(' - ') : title;
  };

  const product = (name, variant, price, currency, source, from = false) => {
    const cleanName = text(withoutSite(text(name, 400)), 140);
    return cleanName.length >= 3
      ? { name: cleanName, variant: text(variant, 100), price: amount(price), currency: currencyCode(currency), from, source }
      : null;
  };

  const priced = (offers) => {
    const found = [];
    for (const offer of list(offers).slice(0, 200)) {
      if (!offer || typeof offer !== 'object') continue;
      const specification = list(offer.priceSpecification)[0];
      const price = amount(offer.price ?? offer.lowPrice ?? specification?.price);
      if (price) {
        found.push({
          price,
          currency: currencyCode(offer.priceCurrency ?? specification?.priceCurrency),
          // The lowest price of a range is not the price of the size or colour on screen.
          from: offer.price == null && offer.lowPrice != null && amount(offer.highPrice) !== price,
        });
      } else {
        const nested = offer.offers ? priced(offer.offers) : null;
        if (nested) found.push(nested);
      }
    }
    if (!found.length) return null;
    // Several offers at different prices are one per size or per seller: the lowest is only where prices start.
    const lowest = found.reduce((low, next) => (next.price < low.price ? next : low));
    return found.some(({ price }) => price !== lowest.price) ? { ...lowest, from: true } : found[0];
  };

  // The price a product page prints largest, when exactly one stands out. Struck-through "was" prices and anything
  // below the range's lowest price are ignored, and a dollar sign is only trusted when the shop's data names the currency.
  const shownPrice = (lowest, knownCurrency) => {
    const styleOf = root.defaultView?.getComputedStyle?.bind(root.defaultView) ?? globalThis.getComputedStyle;
    if (typeof styleOf !== 'function') return null;
    const symbols = { '£': 'GBP', '€': 'EUR', $: knownCurrency };
    const candidates = [];
    for (const element of root.querySelectorAll('span, p, div, strong, b, ins')) {
      if (candidates.length >= 60) break;
      if (element.children.length) continue;
      const written = /^\s*([£$€])\s?(\d[\d,]*(?:\.\d{2})?)\s*$/.exec(element.textContent ?? '');
      if (!written) continue;
      const currency = symbols[written[1]];
      const price = amount(written[2]);
      if (!currency || (knownCurrency && currency !== knownCurrency) || !price || (lowest && price < lowest)) continue;
      const box = element.getBoundingClientRect();
      const style = styleOf(element);
      if (!box.width || box.top > 1600 || /line-through/.test(style.textDecorationLine ?? '') || element.closest('s, del')) continue;
      const named = element.getAttributeNames().some((name) => /price/i.test(name) || /price/i.test(element.getAttribute(name) ?? ''));
      candidates.push({ price, currency, size: parseFloat(style.fontSize) || 0, named });
    }
    const pool = candidates.some(({ named }) => named) ? candidates.filter(({ named }) => named) : candidates;
    const largest = Math.max(0, ...pool.map(({ size }) => size));
    const top = pool.filter(({ size }) => size === largest);
    return top.length && top.every(({ price }) => price === top[0].price) ? top[0] : null;
  };

  // The options chosen on screen ("Vanilla, 1kg"), for shops whose structured data does not say which variant is showing.
  // Two things are trusted: the selected control of a group labelled with an option kind (a checked radio, an ARIA
  // selected state, a <select>, a dropdown button showing its choice, or the usual selected class), and a visible line
  // that prints the choice beside its label ("Flavour: Vanilla"). Anything unclear gives no variant at all, because a
  // half-known variant would let a different size pass as the same product.
  const chosenOptions = (named = '') => {
    const ranks = { flavour: 0, colour: 0, scent: 0, shade: 0, strength: 1, size: 2, amount: 2, weight: 2, 'pack size': 2, count: 3 };
    const labelled = /^(?:(?:select|choose|pick)\s+(?:an?\s+|your\s+|the\s+)?)?(flavou?r|colou?r|scent|shade|strength|pack size|size|amount|weight|count)\s*(?:(?::\s*|\s+[–—-]\s+)(.*))?$/i;
    const elsewhere = /mini[-_ ]?(?:basket|cart|bag)|(?:basket|cart|bag)[-_ ]?(?:drawer|items?|lines?|summary|popup|modal|flyout|preview)|review|recommend|reccs|related|similar|also[-_ ]?(?:bought|like|viewed)|upsell|cross[-_ ]?sell|carousel|bundle|frequently|facet|filter|refine|footer|wish[-_ ]?list|recently|compar/i;
    const attribute = (element, name) => element.getAttribute?.(name) ?? '';
    const tag = (element) => String(element?.tagName ?? '').toUpperCase();
    const everything = (within) => [...within.querySelectorAll('*')];
    const all = everything(root).slice(0, 20000);
    if (!all.length) return '';

    const heading = pickVisibleHeading()?.element ?? all.find((element) => tag(element) === 'H1');
    const above = [];
    for (let node = heading; node; node = node.parentElement) above.push(node);
    const mainAt = above.findLastIndex((node) => tag(node) === 'MAIN' || attribute(node, 'role') === 'main');
    const main = above[mainAt] ?? null;
    const aroundHeading = new Set(main ? above.slice(0, mainAt + 1) : above);
    // Baskets, recommendations, reviews, filters, footers and specification tables name sizes and flavours too.
    // Whatever holds the product's own heading is the product area, even when a shop builds it as an <aside>.
    const outside = (element) => {
      for (let node = element, steps = 0; node && steps < 40; node = node.parentElement, steps += 1) {
        if (aroundHeading.has(node)) return false;
        if (/^(?:FOOTER|NAV|ASIDE|TABLE|DL)$/.test(tag(node))) return true;
        if (elsewhere.test(`${attribute(node, 'id')} ${attribute(node, 'class')} ${attribute(node, 'aria-label')} ${attribute(node, 'data-testid')}`)) return true;
      }
      return !!main;
    };

    const tidy = (raw) => {
      let value = text(raw, 160).replace(/\(?\bselected\b\)?:?/gi, ' ').replace(/\s*[-–—+(]?\s*[£$€]\s?\d.*$/, '')
        .replace(/\s+/g, ' ').replace(/^[\s:–—-]+|[\s:,–—-]+$/g, '');
      if (!value || value.length > 40
        || /^(?:select|choose|please|pick|runs|fits|true to|see|view|find|check|guide|chart|what|which|help|info|required|none|n\/a)\b/i.test(value)) return '';
      // "30 SERVINGS / 900G" is a label style, not a name.
      if (value.length > 3 && !/[a-z]/.test(value)) value = value.toLowerCase().replace(/^[a-z]/, (letter) => letter.toUpperCase());
      return value;
    };
    const ownText = (element) => text([...(element.childNodes ?? [])].filter((node) => node.nodeType === 3)
      .map((node) => node.textContent).join(' '), 200);
    // The first words a control shows, skipping hidden notes such as "Out of stock" and trailing badges.
    const firstText = (element, depth = 0) => {
      for (const child of element.childNodes ?? []) {
        if (child.nodeType === 3) {
          const words = text(child.textContent, 160);
          if (words) return words;
        } else if (child.nodeType === 1 && depth < 6 && child.getAttribute('hidden') == null
          && attribute(child, 'aria-hidden') !== 'true' && !/^(?:SCRIPT|STYLE|SVG)$/.test(tag(child))) {
          const words = firstText(child, depth + 1);
          if (words) return words;
        }
      }
      return '';
    };
    const shown = (control) => firstText(control) || attribute(control, 'aria-label') || attribute(control, 'title');

    const labelFor = new Map();
    for (const element of all) {
      if (tag(element) === 'LABEL' && attribute(element, 'for')) labelFor.set(attribute(element, 'for'), element);
    }
    const chosenIn = (select) => {
      const option = select.selectedOptions?.[0];
      const placeholder = !option || option.disabled || option.value === '';
      return placeholder ? '' : tidy(option.textContent);
    };
    const opensList = (element) => /^(?:listbox|dialog|menu|true)$/.test(attribute(element, 'aria-haspopup'))
      || attribute(element, 'role') === 'combobox';
    // "selected", "is-active" and the hashed kind ("Options-module_active__tY95l"), but never "not-selected" or "inactive".
    const marked = /(?:^|[\s_-])(?<!(?:not|non|un|in|de)[_-])(?:is[_-])?(?:selected|active|checked|current)(?:$|[\s_-])/i;
    // What looks selected inside a container: [] when nothing does, '' for a selection that cannot be read.
    const selectedIn = (container) => {
      if (tag(container) === 'SELECT') return [chosenIn(container)];
      const members = [container, ...everything(container).slice(0, 800)];
      const openers = members.filter((element) => opensList(element) && tag(element) !== 'SELECT');
      const stated = [];
      const styled = [];
      for (const element of members) {
        const name = tag(element);
        if (name === 'SELECT') stated.push(chosenIn(element));
        else if (name === 'INPUT') {
          if (attribute(element, 'type') !== 'radio' || !element.checked) continue;
          let label = labelFor.get(attribute(element, 'id'));
          for (let node = element.parentElement, steps = 0; !label && node && steps < 3; node = node.parentElement, steps += 1) {
            if (tag(node) === 'LABEL') label = node;
          }
          const beside = element.nextElementSibling;
          stated.push(tidy(label ? shown(label) : attribute(element, 'aria-label') || (tag(beside) === 'LABEL' ? shown(beside) : '')));
        } else if (attribute(element, 'role') !== 'tab' && element !== container
          && (['aria-checked', 'aria-pressed', 'aria-selected'].some((state) => attribute(element, state) === 'true')
            || /^(?:true|page)$/.test(attribute(element, 'aria-current')))) {
          stated.push(tidy(shown(element)));
        } else if (element !== container && /^(?:BUTTON|A|LI|LABEL)$/.test(name) && (marked.test(attribute(element, 'class'))
          || attribute(element, 'data-selected') === 'true' || /^(?:checked|on|selected)$/.test(attribute(element, 'data-state')))) {
          styled.push(tidy(shown(element)));
        }
      }
      if (openers.length === 1) stated.push(tidy(firstText(openers[0])));
      return stated.length ? stated : styled;
    };

    const seen = new Map();
    const note = (word, values) => {
      const kind = word.toLowerCase().replace(/\s+/g, ' ').replace('flavor', 'flavour').replace('color', 'colour');
      if (!seen.has(kind)) seen.set(kind, []);
      seen.get(kind).push(...values);
    };
    const lineTags = /^(?:LEGEND|LABEL|H2|H3|H4|H5|H6|P|SPAN|STRONG|B|DIV)$/;
    const groupRoles = /^(?:radiogroup|listbox|group)$/;
    for (const element of all) {
      const name = tag(element);
      if (name === 'FIELDSET' || name === 'SELECT' || groupRoles.test(attribute(element, 'role'))) {
        const describedBy = attribute(element, 'aria-labelledby') && root.getElementById?.(attribute(element, 'aria-labelledby'));
        const legend = name === 'FIELDSET' ? [...(element.children ?? [])].find((child) => tag(child) === 'LEGEND') : null;
        const title = attribute(element, 'aria-label') || text(describedBy?.textContent, 80) || text(legend?.textContent, 80)
          || (name === 'SELECT' && labelFor.has(attribute(element, 'id')) ? ownText(labelFor.get(attribute(element, 'id'))) : '');
        const match = labelled.exec(text(title, 80));
        if (match && !outside(element)) note(match[1], selectedIn(element));
      }
      if (!lineTags.test(name)) continue;
      const own = ownText(element);
      if (!own || own.length > 60) continue;
      const match = labelled.exec(own);
      if (!match || outside(element) || element.getBoundingClientRect?.().width === 0) continue;
      const values = [];
      if (match[2]) values.push(tidy(match[2]));
      else {
        const whole = text(element.textContent, 200);
        const inside = element.children?.length && whole.length <= 80 ? labelled.exec(whole)?.[2] : '';
        if (inside) values.push(tidy(inside));
      }
      const parent = element.parentElement;
      const next = element.nextElementSibling ?? (parent?.children?.length === 1 ? parent.nextElementSibling : null);
      if (next) {
        const picked = selectedIn(next);
        const plain = !picked.length && /:$/.test(own) && !everything(next).some((inner) => /^(?:BUTTON|INPUT|SELECT|A|OPTION)$/.test(tag(inner)));
        values.push(...picked, ...(plain && !/^(?:BUTTON|INPUT|A)$/.test(tag(next)) ? [tidy(next.textContent)] : []));
      }
      if (!values.length && parent && text(parent.textContent, 200).length <= 80) {
        const around = labelled.exec(text(parent.textContent, 200))?.[2];
        if (around) values.push(tidy(around));
      }
      note(match[1], values);
    }

    const words = (value) => new Set(value.toLowerCase().replace(/(\d)\s+(?=[a-z])/g, '$1').split(/[^a-z0-9.]+/).filter(Boolean));
    const options = [];
    for (const [kind, values] of seen) {
      // An option the page offers but nothing readable is chosen for, or two different choices at once: say nothing.
      if (!values.length || values.includes('')) return '';
      const fullest = values.reduce((best, value) => (words(value).size > words(best).size ? value : best));
      const known = words(fullest);
      if (!values.every((value) => [...words(value)].every((word) => known.has(word)))) return '';
      if (!options.some((option) => option.value.toLowerCase() === fullest.toLowerCase())) options.push({ rank: ranks[kind] ?? 9, value: fullest });
    }
    // A variant's own name may already say "454g"; only what it leaves out is added.
    const inName = words(typeof named === 'string' ? named : '');
    return options.sort((a, b) => a.rank - b.rank).slice(0, 3).map(({ value }) => value)
      .filter((value) => ![...words(value)].every((word) => inName.has(word))).join(', ');
  };

  const isType = (node, type) => list(node?.['@type'])
    .some((value) => typeof value === 'string' && value.replace(/^https?:\/\/schema\.org\//, '') === type);
  const nodes = [];
  const collect = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 6 || nodes.length > 400) return;
    if (Array.isArray(value)) {
      for (const item of value) collect(item, depth + 1);
      return;
    }
    nodes.push(value);
    collect(value['@graph'], depth + 1);
    collect(value.mainEntity, depth + 1);
  };
  for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      collect(JSON.parse(script.textContent));
    } catch {
      // A shop's malformed structured data just means we look elsewhere.
    }
  }
  const listed = nodes.find((node) => isType(node, 'Product')) ?? nodes.find((node) => isType(node, 'ProductGroup'));
  if (listed) {
    // Which size or colour is on screen? Shops name it in the address (?variation=123, /p/name/123/) or in the
    // selected option's value, and give each variant the same id in their structured data.
    const query = new URLSearchParams(place.search ?? '');
    const inAddress = new Set([...query.values(), ...String(place.pathname ?? '').split('/')].filter(Boolean));
    const picked = new Set([...root.querySelectorAll('input[type="radio"]:checked, option:checked')].slice(0, 40)
      .map((control) => String(control.value ?? '')).filter(Boolean));
    const ids = (node) => [node?.sku, node?.productID, node?.mpn, node?.gtin13]
      .filter((id) => typeof id === 'string' || typeof id === 'number').map(String).filter((id) => id.length >= 4);
    const variants = list(listed.hasVariant).filter((variant) => variant && typeof variant === 'object');
    const named = variants.filter((variant) => ids(variant).some((id) => inAddress.has(id)));
    // An address that fits several variants names a colourway or a style, not a size. Only what those variants agree
    // on is known: taking the first of them would report a size nobody chose.
    const agreed = (field) => {
      const values = new Set(named.map((variant) => (typeof variant[field] === 'string' ? variant[field].trim() : '')));
      return values.size === 1 ? [...values][0] : '';
    };
    const costs = named.map((variant) => priced(variant.offers)).filter(Boolean);
    const lowest = costs.reduce((low, next) => (!low || next.price < low.price ? next : low), null);
    const several = named.length > 1 && {
      name: agreed('name') || undefined, color: agreed('color'), size: agreed('size'),
      cost: lowest && { ...lowest, from: lowest.from || costs.some(({ price }) => price !== lowest.price) },
    };
    const onScreen = variants.find((variant) => ids(variant).some((id) => query.get('variation') === id || picked.has(id)))
      ?? (several || named[0]);

    const brand = text(typeof listed.brand === 'string' ? listed.brand : listed.brand?.name, 60);
    const name = text(typeof onScreen?.name === 'string' ? onScreen.name : listed.name, 300);
    const own = priced(listed.offers);
    const chosen = onScreen ? (onScreen.cost ?? priced(onScreen.offers)) : null;
    const offer = chosen ?? own ?? priced(variants.flatMap((variant) => list(variant.offers)));
    const variant = [onScreen?.color || listed.color, onScreen?.size || listed.size]
      .filter((value) => typeof value === 'string' && value.trim()).join(', ') || chosenOptions(name);
    // Exact when it is the variant on screen or the product's one price; otherwise it is only a starting price,
    // and the one price the page shows largest is the price of the size on screen.
    const starting = !!offer && (chosen ? chosen.from : offer.from || !own);
    const shown = starting || !offer ? shownPrice(offer?.price ?? null, offer?.currency ?? '') : null;
    const found = product(
      brand && !name.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${name}` : name,
      variant, shown?.price ?? offer?.price, offer?.currency || shown?.currency, 'structured', shown ? false : starting,
    );
    if (found) return found;
  }

  const scope = root.querySelector('[itemtype*="schema.org/Product"]');
  // A grid of product cards is a listing, not a product: several separate products and none of them holds the heading.
  const cards = [...root.querySelectorAll('[itemtype*="schema.org/Product"]')].slice(0, 60)
    .filter((card) => card !== scope && !scope?.contains?.(card));
  const heading = root.querySelector('h1');
  const listing = cards.length >= 2 && !(heading && scope?.contains?.(heading));
  if (scope && !listing) {
    // A related product nested inside this one has a name and a price of its own: only this product's count.
    const ownProperty = (element) => !element?.closest || element.closest('[itemtype*="schema.org/Product"]') === scope;
    const property = (name) => {
      const candidates = scope.querySelectorAll
        ? [...scope.querySelectorAll(`[itemprop="${name}"]`)].slice(0, 40)
        : [scope.querySelector(`[itemprop="${name}"]`)];
      const element = candidates.find((candidate) => candidate && ownProperty(candidate));
      return element ? element.getAttribute('content') ?? element.textContent : '';
    };
    const found = product(property('name'), chosenOptions(property('name')), property('price'), property('priceCurrency'), 'structured');
    if (found) return found;
  }

  const meta = (name) => root.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.getAttribute('content') ?? '';
  const metaPrice = meta('product:price:amount') || meta('og:price:amount');
  if (metaPrice || /product/i.test(meta('og:type'))) {
    const found = product(
      meta('og:title'), chosenOptions(meta('og:title')), metaPrice,
      meta('product:price:currency') || meta('og:price:currency'), 'page',
    );
    if (found) return found;
  }

  // Last resort: a page with one heading and a way to buy is very likely a product page.
  // A product page has one or two such buttons (the second is often a sticky copy); a page with a row of them
  // is a listing with quick-add buttons, and its heading names a category.
  const buyButtons = [...root.querySelectorAll('button, [role="button"], input[type="submit"]')].slice(0, 400)
    .filter((control) => /\badd to (?:basket|bag|cart|trolley)\b|\bbuy now\b/i
      .test(control.textContent || control.value || control.getAttribute('aria-label') || ''));
  const pickedHeading = pickVisibleHeading();
  const title = pickedHeading?.title;
  if (!title || buyButtons.length < 1 || buyButtons.length > 3) return null;
  const shown = shownPrice(null, '');
  return product(title, chosenOptions(title), shown?.price ?? null, shown?.currency ?? '', 'heading');
}
