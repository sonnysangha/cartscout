// Plain-data platform recipes (D1, MV3 compliant: zero functions, selectors & flags only).
// Order matters: matched top to bottom. Provenance in `facts` keeps recalled-only selectors
// out of automatic thumbs (D7).

export const BEST_MODE = true;

const WOO_STATE = {
  from: 'fetch',
  url: '/wp-json/wc/store/v1/cart',
  total: 'totals.total_price',
  minor: 'totals.currency_minor_unit',
  currency: 'totals.currency_code',
  codes: 'coupons[].code',
};

export const RECIPES = [
  // ---- Shopify ------------------------------------------------------------------------------
  {
    id: 'shopify-checkout',
    platform: 'shopify',
    detect: { any: ['meta[name="serialized-checkoutLayout"]', 'link[href*="/cdn/shopifycloud/checkout-web/assets/"]'] },
    reveal: [{ click: 'button[data-event-name="order_summary_show"][aria-controls="disclosure_details"]' }],
    input: ['input[name="reductions"]', 'input[id^="ReductionsInput"]'],
    apply: ['button[type="submit"][data-event-name="apply_discount"]'],
    press: 'full',
    busy: ['button[data-event-name="apply_discount"][aria-busy="true"]', '[role="cell"][aria-busy="true"]'],
    zone: 'section',
    error: { at: ['[id^="error-for-ReductionsInput"]', '[role="status"]', '[role="alert"]'] },
    applied: { at: ['div[id^="tag-"][role="group"]'], code: 'text' },
    remove: { at: 'div[id^="tag-"][role="group"] button[data-event-name="remove_discount_code"]', matchCodeInRow: true },
    total: { special: 'shopify-checkout-total', kind: 'total' },
    multi: true,
    best: true,
    reloads: 'never',
    facts: { input: 'L', error: 'S', applied: 'S' },
  },
  {
    id: 'shopify-cart-api',
    platform: 'shopify',
    detect: {
      any: ['meta[name="shopify-digital-wallet"]', 'script#shopify-features', 'script[src*="/cdn/shopifycloud/"]', '.shopify-section'],
      none: ['meta[name="serialized-checkoutLayout"]'],
    },
    endpoint: { kind: 'shopify-cart' },
    cart: '/cart',
    best: true,
    reloads: 'never',
    facts: { input: 'L', error: 'L', applied: 'S' },
  },
  {
    id: 'shopify-horizon-cart',
    platform: 'shopify',
    detect: { any: ['cart-discount-component'] },
    scope: 'cart-discount-component',
    reveal: [{ open: 'accordion-custom.cart-discount > details' }],
    input: ['input#cart-discount[name="discount"]', 'input.cart-discount__input[name="discount"]'],
    apply: ['button.cart-discount__button[type="submit"]'],
    busy: ['cart-discount-component[aria-busy="true"]'],
    error: { at: ['.cart-discount__error:not(.hidden) .cart-discount__error-text:not(.hidden)'] },
    noEffectText: ['shipping discounts are shown at checkout after adding an address'],
    applied: { at: ['li.cart-discount__pill[data-discount-code="{code}"]', 'li.cart-discount__pill'], code: 'attr:data-discount-code' },
    remove: { at: 'li.cart-discount__pill[data-discount-code="{code}"] button.cart-discount__pill-remove' },
    total: { at: ['.cart-totals__total-value[data-testid="cart-total-value"]', 'text-component[data-cart-subtotal]', '.cart__total-value'], kind: 'total' },
    cart: '/cart',
    multi: true,
    best: true,
    reloads: 'never',
    facts: { input: 'L', error: 'S', applied: 'S' },
  },

  // ---- BigCommerce --------------------------------------------------------------------------
  {
    id: 'bigcommerce-checkout',
    platform: 'bigcommerce',
    detect: { any: ['div#checkout-app', 'script[src*="microapps.bigcommerce.com/checkout-js/"]'] },
    scope: 'article.cart[data-test="cart"]',
    reveal: [{ click: 'a.redeemable-label[data-test="redeemable-label"][aria-expanded="false"]' }, { click: 'a[data-test="redeemable-label"]' }],
    input: ['input#redeemableCode[name="redeemableCode"]', 'input[data-test="redeemableEntry-input"]'],
    apply: ['button#applyRedeemableButton[data-test="redeemableEntry-submit"]', '#applyRedeemableButton'],
    busy: ['#applyRedeemableButton.is-loading'],
    error: { at: ['.applied-coupons-list .alertBox--error ul.applied-coupon-error-message li span', '.redeemable-entry .alertBox--error .alertBox-message'] },
    applied: { at: ['.applied-coupons-list .coupon-tag-wrapper ul li', '[data-test="cart-coupon"]'], code: 'text' },
    remove: { at: '.coupon-tag-wrapper li svg.remove-coupon-icon', matchCodeInRow: true },
    total: { at: ['[data-test="cart-total"] [data-test="cart-price-value"]'], kind: 'total' },
    multi: true,
    best: true,
    reloads: 'never',
    facts: { input: 'S', error: 'S', applied: 'S' },
  },
  {
    id: 'bigcommerce-cart',
    platform: 'bigcommerce',
    detect: { any: ['meta[name="platform"][content="bigcommerce.stencil"]', 'link[data-stencil-stylesheet]'] },
    page: { any: ['[data-cart]'] },
    reveal: [{ click: 'a.cart-coupon-link[data-coupon-trigger]' }, { click: 'button.coupon-code-add' }],
    input: ['#couponcode[name="couponcode"]'],
    apply: ['form.coupon-form input[type="submit"]', 'form.coupon-form button[type="submit"]'],
    busy: ['[data-cart] .loadingOverlay'],
    error: { at: ['#alert-modal .modal-content span'], dismiss: '#alert-modal .confirm' },
    applied: { at: ['ul.cart-coupon-list > li.cart-coupon-item .cart-coupon-name'], code: 'text' },
    remove: { at: 'li.cart-coupon-item a.cart-coupon-remove[href]', navigates: true },
    total: { at: ['.cart-total-grandTotal .cart-total-amount', '.cart-total-grandTotal span'], kind: 'total' },
    cart: '/cart.php',
    multi: true,
    best: true,
    reloads: 'never',
    facts: { input: 'L', error: 'S', applied: 'S' },
  },

  // ---- Squarespace --------------------------------------------------------------------------
  {
    id: 'squarespace-checkout',
    platform: 'squarespace',
    detect: { any: ['body.checkout.commerce-checkout', 'script[src*="assets.squarespace.com/commerce-checkout/"]'] },
    reveal: [{ click: 'button[class*="GiftPromoCode-discountInputPillButton"]' }],
    input: ['input[name="OrderSummaryCodeInput"]'],
    apply: ['button[class*="CodeInput-inputApplyButton"]'],
    busy: ['input[name="OrderSummaryCodeInput"]:disabled'],
    error: { at: ['[class*="CodeInput-codeInputWrapper"] [role="alert"]'] },
    applied: { at: ['[class*="AppliedGiftPromoBox-appliedCodeTitle"]'] },
    remove: { at: 'button[data-testid="remove-promo-gift-card"]' },
    total: { at: ['[data-testid="grandTotal"]', '[data-testid="amountDue"]'], kind: 'total' },
    where: 'checkout',
    best: true,
    reloads: 'never',
    facts: { input: 'S', error: 'S', applied: 'S' },
  },

  // ---- Wix ----------------------------------------------------------------------------------
  {
    id: 'wix-checkout',
    platform: 'wix',
    detect: { any: ['meta[name="generator"][content="Wix.com Website Builder"]', '[data-hook="CheckoutAppPageDataHook.root"]'] },
    page: { any: ['[data-hook="CheckoutAppPageDataHook.root"]'] },
    scope: '[data-hook="SummaryDataHooks.couponSectionInput"]',
    reveal: [{ click: '[data-hook="FoldableSummarySectionDataHooks.root"]' }, { click: '[data-hook="CodeInputSection.EnterACodeButton"]' }],
    input: ['input[data-hook="CodesInput.TextInput"]'],
    apply: ['[data-hook="CodesInput.Button"]'],
    busy: ['[data-hook="CodesInput.ThreeDotsLoader"]', '[data-hook="TotalUpdateSkeletonDataHooks.Loader"]'],
    error: { at: ['[data-hook="errormessagewrapper-message"]'] },
    applied: { at: ['input[data-hook="CodesInput.TextInput"]:disabled', '[data-hook="TotalsSectionDataHooks.DiscountRow"]'], code: 'value' },
    remove: { at: '[data-hook="CodesInput.Button"]', sameAsApply: true },
    total: { at: ['[data-hook="TotalsSectionDataHooks.TotalRowValue"]'], kind: 'total' },
    best: true,
    reloads: 'never',
    facts: { input: 'S', error: 'S', applied: 'S' },
  },
  {
    id: 'wix-cart',
    platform: 'wix',
    detect: { any: ['meta[name="generator"][content="Wix.com Website Builder"]', '[data-hook="CartAppDataHook.root"]'] },
    page: { any: ['[data-hook="CartAppDataHook.root"]'] },
    scope: '[data-hook="Coupon.Root"]',
    reveal: [{ click: '[data-hook="Coupon.EnterACouponButton"][aria-expanded="false"]' }, { click: '[data-hook="Coupon.EnterACouponButton"]' }],
    input: ['input[data-hook="CodesInput.TextInput"]'],
    apply: ['[data-hook="CodesInput.Button"]'],
    busy: ['[data-hook="CodesInput.Button"][aria-busy="true"]', '[data-hook="TotalUpdateSkeletonDataHooks.Loader"]'],
    error: { at: ['[data-hook="errormessagewrapper-message"]'] },
    applied: { at: ['input[data-hook="CodesInput.TextInput"]:disabled'], code: 'value' },
    remove: { at: '[data-hook="CodesInput.Button"]', sameAsApply: true },
    total: { at: ['dd[data-hook="Total.Value"]', '#total-sum'], kind: 'total' },
    cart: '/cart-page',
    best: true,
    reloads: 'never',
    facts: { input: 'S', error: 'S', applied: 'S' },
  },

  // ---- Ecwid (recalled markers: never auto-files thumbs) ------------------------------------
  {
    id: 'ecwid-cart',
    platform: 'ecwid',
    detect: { any: ['script[src*="app.ecwid.com/script.js"]', '.ec-store', 'meta[name="generator"][content="ec-instant-site"]'] },
    scope: '.ec-cart-coupon',
    reveal: [{ click: '.ec-cart-coupon .ec-link' }],
    input: ['.ec-cart-coupon__input input'],
    apply: ['.ec-cart-coupon__button--apply'],
    error: { at: ['.ec-cart-coupon--refused .form__msg--error'] },
    applied: { at: ['.ec-cart-coupon--applied'] },
    total: { at: ['.ec-cart-summary__row--total .ec-cart-summary__price'], kind: 'total' },
    best: false,
    reloads: 'never',
    facts: { input: 'R', error: 'R', applied: 'R' },
  },

  // ---- WooCommerce --------------------------------------------------------------------------
  {
    id: 'woo-blocks',
    platform: 'woocommerce',
    detect: { any: ['.wp-block-woocommerce-cart', '.wp-block-woocommerce-checkout'] },
    scope: '.wc-block-components-totals-coupon',
    reveal: [
      { click: '.wc-block-components-checkout-order-summary__title:not(.is-open)' },
      { click: '.wc-block-components-totals-coupon .wc-block-components-panel__button[aria-expanded="false"]' },
      { click: 'a.wc-block-components-totals-coupon-link' },
    ],
    input: ['[id^="wc-block-components-totals-coupon__input"]'],
    apply: ['button.wc-block-components-totals-coupon__button'],
    busy: ['.wc-block-components-totals-coupon .wc-block-components-loading-mask'],
    error: { at: ['.wc-block-components-totals-coupon .wc-block-components-validation-error[role="alert"] p'] },
    applied: { at: ['.wc-block-components-totals-discount__coupon-list .wc-block-components-chip__text'], code: 'text' },
    remove: { at: '.wc-block-components-chip button.wc-block-components-chip__remove[aria-label*="{code}" i]' },
    total: { at: ['.wc-block-components-totals-footer-item .wc-block-components-totals-item__value'], kind: 'total' },
    state: WOO_STATE,
    cleanup: 'clear-box',
    multi: true,
    best: true,
    reloads: 'never',
    facts: { input: 'S', error: 'S', applied: 'S' },
  },
  {
    id: 'woo-classic-checkout',
    platform: 'woocommerce',
    detect: { any: ['body.woocommerce-checkout', 'form.checkout_coupon'] },
    page: { any: ['form.checkout_coupon'] },
    reveal: [{ click: '.woocommerce-form-coupon-toggle a.showcoupon' }],
    input: ['form.checkout_coupon #coupon_code'],
    apply: ['form.checkout_coupon button[name="apply_coupon"]'],
    press: 'click',
    busy: ['form.checkout_coupon.processing', '.woocommerce-checkout-review-order-table .blockUI'],
    error: { at: ['#coupon-error-notice', 'ul.woocommerce-error li', '.wc-block-components-notice-banner.is-error'] },
    applied: { at: ['.woocommerce-checkout-review-order-table tr.cart-discount a.woocommerce-remove-coupon[data-coupon="{code}" i]', '.woocommerce-checkout-review-order-table tr.cart-discount a.woocommerce-remove-coupon'], code: 'attr:data-coupon' },
    remove: { at: '.woocommerce-checkout-review-order-table a.woocommerce-remove-coupon[data-coupon="{code}" i]' },
    total: { at: ['.woocommerce-checkout-review-order-table tfoot tr.order-total td .woocommerce-Price-amount'], kind: 'total' },
    state: WOO_STATE,
    multi: true,
    best: true,
    reloads: 'maybe',
    facts: { input: 'L', error: 'S', applied: 'S' },
  },
  {
    id: 'woo-classic-cart',
    platform: 'woocommerce',
    detect: { any: ['body.woocommerce-cart', 'form.woocommerce-cart-form'] },
    input: ['form.woocommerce-cart-form .coupon #coupon_code', 'form.woocommerce-cart-form #coupon_code'],
    apply: ['form.woocommerce-cart-form button[name="apply_coupon"]'],
    press: 'click',
    busy: ['form.woocommerce-cart-form.processing', 'div.cart_totals.processing'],
    error: { at: ['#coupon-error-notice', '.woocommerce-notices-wrapper ul.woocommerce-error li', '.wc-block-components-notice-banner.is-error'] },
    applied: { at: ['.cart_totals tr.cart-discount a.woocommerce-remove-coupon[data-coupon="{code}" i]', '.cart_totals tr.cart-discount a.woocommerce-remove-coupon'], code: 'attr:data-coupon' },
    remove: { at: '.cart_totals a.woocommerce-remove-coupon[data-coupon="{code}" i]' },
    total: { at: ['.cart_totals tr.order-total td .woocommerce-Price-amount'], kind: 'total' },
    state: WOO_STATE,
    cart: '/cart/',
    multi: true,
    best: true,
    reloads: 'never',
    facts: { input: 'L', error: 'S', applied: 'S' },
  },

  // ---- Magento 2 & Hyva ---------------------------------------------------------------------
  {
    id: 'magento-hyva-cart',
    platform: 'magento',
    detect: { all: ['section.cart-form[data-checkout-config]'], none: ['body[data-container="body"]'] },
    reveal: [{ open: 'details.coupon-form' }, { click: '#discount-form-toggle' }],
    input: ['#discount-coupon-form #coupon_code'],
    apply: ['#discount-coupon-form button[type="submit"]'],
    error: { at: ['section#messages .message.error span', 'section#messages .message.error'] },
    applied: { at: ['#discount-coupon-form #coupon_code[disabled]'], code: 'value' },
    remove: { at: '#discount-coupon-form button[type="submit"]', sameAsApply: true },
    total: {
      json: { from: 'attr', at: 'section.cart-form', attr: 'data-checkout-config', total: 'totalsData.grand_total' },
      kind: 'total',
    },
    cart: '/checkout/cart/',
    best: true,
    reloads: 'never',
    facts: { input: 'L', error: 'L', applied: 'S' },
  },
  {
    id: 'magento-luma-checkout',
    platform: 'magento',
    detect: { all: ['body[data-container="body"]'] },
    page: { any: ['.payment-option.discount-code', '#discount-form'] },
    reveal: [{ click: '.discount-code:not(._active) .payment-option-title[data-role="title"]' }],
    input: ['form#discount-form #discount-code'],
    apply: ['#discount-form button.action.action-apply'],
    busy: ['.loading-mask[data-role="loader"]'],
    error: { at: ['.discount-code [data-role="checkout-messages"] .message-error'] },
    applied: { at: ['#discount-form #discount-code[disabled]'], code: 'value' },
    remove: { at: '#discount-form button.action.action-cancel' },
    total: { at: ['.opc-block-summary tr.grand.totals td.amount .price'], kind: 'total' },
    best: true,
    reloads: 'never',
    facts: { input: 'S', error: 'S', applied: 'S' },
  },
  {
    id: 'magento-luma-cart',
    platform: 'magento',
    detect: { all: ['body[data-container="body"]'] },
    page: { any: ['#discount-coupon-form'] },
    reveal: [{ click: '#block-discount:not(.active) > .title[data-role="title"]' }],
    input: ['#discount-coupon-form #coupon_code'],
    apply: ['#discount-coupon-form button.action.apply'],
    press: 'click',
    error: { at: ['div.page.messages [data-ui-id="message-error"]'] },
    applied: { at: ['#discount-coupon-form .fieldset.coupon.applied', '#discount-coupon-form #coupon_code[disabled]'], code: 'value' },
    remove: { at: '#discount-coupon-form button.action.cancel', navigates: true },
    total: { at: ['#cart-totals tr.grand.totals td.amount .price'], kind: 'total' },
    cart: '/checkout/cart/',
    best: true,
    reloads: 'always',
    facts: { input: 'S', error: 'S', applied: 'S' },
  },

  // ---- PrestaShop ---------------------------------------------------------------------------
  {
    id: 'prestashop',
    platform: 'prestashop',
    detect: { script: ['var prestashop = {'], any: ['.js-cart[data-refresh-url*="action=refresh"]', 'form[data-link-action="add-voucher"]'] },
    scope: '.cart-voucher',
    reveal: [
      { click: '.promo-code-button a.collapse-button[href="#promo-code"]' },
      { click: 'button.accordion-button[data-bs-target="#promo-code"]' },
    ],
    input: ['form[data-link-action="add-voucher"] input[name="discount_name"]'],
    apply: ['form[data-link-action="add-voucher"] button[type="submit"]'],
    error: { at: ['.cart-voucher .js-error .js-error-text'] },
    applied: { at: ['ul.promo-name li.cart-summary-line', 'ul.cart-voucher__list li', '#cart-subtotal-discount'] },
    remove: { at: 'a[data-link-action="remove-voucher"]' },
    total: {
      at: ['.cart-summary-totals .cart-total .value', '.cart-summary-line.cart-total .value', '.js-cart-summary-totals .cart-summary__line .cart-summary__value'],
      kind: 'total',
    },
    multi: true,
    best: true,
    reloads: 'maybe',
    facts: { input: 'L', error: 'S', applied: 'S' },
  },

  // ---- OpenCart -----------------------------------------------------------------------------
  {
    id: 'opencart-4-cart',
    platform: 'opencart',
    detect: { any: ['form#form-coupon[data-oc-toggle="ajax"]'] },
    reveal: [{ click: 'button.accordion-button[data-bs-target="#collapse-coupon"]' }],
    input: ['#input-coupon'],
    apply: ['button[form="form-coupon"][formaction*="coupon.save"]', '#form-coupon button[type="submit"]'],
    error: { at: ['#alert .alert.alert-danger'] },
    applied: { at: ['#alert .alert.alert-success'] },
    remove: { at: 'button[form="form-coupon"][formaction*="coupon.remove"]' },
    total: { special: 'opencart-total', at: ['#shopping-cart tfoot#checkout-total', '#shopping-cart table'], kind: 'total' },
    where: 'cart',
    best: true,
    reloads: 'never',
    facts: { input: 'S', error: 'S', applied: 'S' },
  },
  {
    id: 'opencart-3-cart',
    platform: 'opencart',
    detect: { any: ['script[src*="catalog/view/javascript/"]', '#checkout-cart'] },
    page: { any: ['#checkout-cart #input-coupon', '#collapse-coupon'] },
    reveal: [{ click: 'a.accordion-toggle[href="#collapse-coupon"]' }],
    input: ['#input-coupon'],
    apply: ['#button-coupon'],
    error: { at: ['.alert.alert-danger'] },
    applied: { at: ['#checkout-cart > .alert.alert-success'] },
    total: { special: 'opencart-total', at: ['#content table.table-bordered'], kind: 'total' },
    where: 'cart',
    replace: true,
    best: true,
    reloads: 'onSuccess',
    facts: { input: 'L', error: 'L', applied: 'S' },
  },

  // ---- Shopware 6 ---------------------------------------------------------------------------
  {
    id: 'shopware-cart',
    platform: 'shopware',
    detect: { any: ['form[action$="/checkout/promotion/add"]', 'form[action*="/checkout/promotion/add"]'] },
    input: ['#addPromotionInput', '#addPromotionOffcanvasCartInput'],
    apply: ['#addPromotion', '#addPromotionOffcanvasCart'],
    press: 'click',
    error: { at: ['.flashbags .alert-danger .alert-content'] },
    noEffect: { at: ['.flashbags .alert-info .alert-content'] },
    applied: { at: ['li.line-item.line-item-promotion'] },
    remove: { at: 'li.line-item-promotion .line-item-remove-button', navigates: true },
    total: { at: ['dd.checkout-aside-summary-value.checkout-aside-summary-total'], kind: 'total' },
    cart: '/checkout/cart',
    where: 'cart',
    multi: true,
    best: true,
    reloads: 'always',
    facts: { input: 'L', error: 'S', applied: 'S' },
  },

  // ---- Salesforce Commerce Cloud ------------------------------------------------------------
  {
    id: 'sfra-cart',
    platform: 'sfcc',
    detect: { any: ['form.promo-code-form', 'form[action*="Cart-AddCoupon"]'] },
    reveal: [{ click: 'p.optional-promo' }],
    input: ['form.promo-code-form input.coupon-code-field', 'input[name="couponCode"]'],
    apply: ['form.promo-code-form button.promo-code-btn'],
    busy: ['body > div.veil'],
    error: { at: ['span.coupon-error-message'], noise: ['span.coupon-missing-error'] },
    applied: { at: ['.coupons-and-promos .coupon-price-adjustment span.coupon-applied'], matchCodeInRow: true },
    noEffect: { at: ['.coupons-and-promos .coupon-price-adjustment span.coupon-not-applied'] },
    remove: { at: 'button.remove-coupon[data-code="{code}" i]', confirm: '#removeCouponModal button.delete-coupon-confirmation-btn' },
    total: { at: ['p.grand-total'], kind: 'total' },
    cleanup: 'remove-unapplied',
    multi: true,
    best: true,
    reloads: 'never',
    facts: { input: 'L', error: 'L', applied: 'S' },
  },
  {
    id: 'sitegenesis-cart',
    platform: 'sfcc',
    detect: { any: ['form#cart-items-form input[name$="_couponCode"]'] },
    input: ['.cart-coupon-code input[name$="_couponCode"]'],
    apply: ['button#add-coupon[name$="_addCoupon"]'],
    press: 'click',
    error: { at: ['.cart-coupon-code div.error'] },
    applied: { at: ['tr.rowcoupons .cartcoupon span.value'], code: 'text' },
    noEffect: { at: ['tr.rowcoupons span.not-applied'] },
    remove: { at: 'tr.rowcoupons button[name$="_deleteCoupon"]', matchCodeInRow: true, navigates: true },
    total: { at: ['tr.order-total td.order-value'], kind: 'total' },
    multi: true,
    best: true,
    reloads: 'always',
    facts: { input: 'S', error: 'S', applied: 'S' },
  },
  {
    id: 'sf-headless-cart',
    platform: 'sfcc',
    detect: { any: ['form[data-testid="promo-code-form"]', '[data-testid="sf-order-summary"]'] },
    scope: '[data-testid="sf-order-summary"]',
    reveal: [{ find: 'reveal' }],
    input: ['form[data-testid="promo-code-form"] input'],
    apply: ['form[data-testid="promo-code-form"] button[type="submit"]'],
    applied: { at: ['[data-testid="applied-coupons"]'], matchCodeInRow: true },
    remove: { at: 'button[aria-label="Remove {code}" i]' },
    total: { label: ['Estimated Total', 'Order Total', 'Total'], inScope: true, kind: 'total' },
    best: false,
    reloads: 'never',
    facts: { input: 'S', error: 'R', applied: 'R' },
  },

  // ---- SAP Commerce -------------------------------------------------------------------------
  {
    id: 'spartacus-cart',
    platform: 'sap',
    detect: { any: ['cx-cart-coupon'] },
    input: ['cx-cart-coupon input.input-coupon-code'],
    apply: ['cx-cart-coupon button.apply-coupon-button'],
    busy: ['cx-cart-coupon button.apply-coupon-button[disabled]'],
    error: { at: ['cx-global-message .alert-danger'] },
    applied: { at: ['cx-cart-coupon cx-applied-coupons .cx-cart-coupon-code'], code: 'text' },
    remove: { at: '.cx-coupon-apply > button.close', matchCodeInRow: true },
    total: { at: ['cx-order-summary .cx-summary-total .cx-summary-amount'], kind: 'total' },
    multi: true,
    best: true,
    reloads: 'never',
    facts: { input: 'S', error: 'S', applied: 'S' },
  },
  {
    id: 'sap-accelerator-cart',
    platform: 'sap',
    detect: { any: ['#applyVoucherForm', 'script[src*="/_ui/responsive/common/js/acc."]'] },
    page: { any: ['#js-voucher-code-text'] },
    input: ['#js-voucher-code-text'],
    apply: ['#js-voucher-apply-btn'],
    press: 'click',
    error: { at: ['.js-voucher-respond.has-error .js-voucher-validation-container'] },
    applied: { at: ['#js-applied-vouchers span[id="voucher-code-{code}" i]', '#js-applied-vouchers .js-release-voucher'], code: 'text' },
    remove: { at: 'span[id="voucher-code-{code}" i] .js-release-voucher-remove-btn', navigates: true },
    total: { at: ['.cart-totals-right.grand-total'], kind: 'total' },
    cart: '/cart',
    multi: true,
    best: true,
    reloads: 'always',
    facts: { input: 'S', error: 'S', applied: 'S' },
  },

  // ---- THG Ingenuity (Myprotein UK parity + Lookfantastic) ----------------------------------
  {
    id: 'thg-nutrition',
    platform: 'thg',
    label: { hostHas: 'myprotein', name: 'Myprotein' },
    detect: {
      any: ['#promo-code-input', '#promo-code-remove', 'main basket-item', '[data-e2e="basket-remove_item_button"]'],
      orHostHas: 'myprotein',
      none: ['button.promo-code-add-button', '[data-e2e="basket-promo-apply"]'],
    },
    page: { path: '^/(?:basket/?|my\\.basket)$' },
    input: ['#promo-code-input'],
    apply: ['#promo-code-add'],
    press: 'click',
    busy: ['#promo-code-add[disabled]', '#promo-code-add[aria-disabled="true"]', '#promo-code-add[aria-busy="true"]'],
    error: { at: ['#promo-error-message'] },
    applied: { at: ['#promo-code-remove'] },
    remove: { at: '#promo-code-remove' },
    total: { label: ['Basket subtotal:'], kind: 'subtotal', hidden: true },
    empty: {
      none: ['main basket-item', 'main [data-e2e="basket-remove_item_button"]'],
      text: ['basket is empty', 'basket is currently empty', 'no items in your basket', 'no items added to your basket'],
    },
    answerMs: 5_000,
    settleCapMs: 3_000,
    buttonMs: 500,
    paceMs: 0,
    holdMs: 0,
    lateTotalMs: 0,
    cart: '/basket/',
    best: true,
    afterWin: true,
    strictTotal: true,
    reloads: 'never',
    facts: { input: 'L', error: 'L', applied: 'Y' },
  },
  {
    id: 'thg-luxury',
    platform: 'thg',
    detect: { all: ['#promo-code-input'], any: ['button.promo-code-add-button', '[data-e2e="basket-promo-apply"]'] },
    input: ['#promo-code-input'],
    apply: ['button.promo-code-add-button', '[data-e2e="basket-promo-apply"]'],
    press: 'click',
    zone: 'div.flex-col',
    error: { at: ['.text-red-600'] },
    applied: { at: ['button.remove-discount[data-e2e="basket-remove-discount"]', 'button.remove-discount'] },
    remove: { at: 'button.remove-discount[data-e2e="basket-remove-discount"], button.remove-discount' },
    total: { label: ['SUBTOTAL'], kind: 'subtotal' },
    cart: '/basket/',
    best: true,
    afterWin: true,
    reloads: 'never',
    facts: { input: 'L', error: 'L', applied: 'Y' },
  },
];

export function recipeTrust(recipe, field) {
  const mark = recipe?.facts?.[field];
  if (mark === 'L' || mark === 'S' || mark === 'Y') return 'verified';
  if (mark === 'R') return 'recalled';
  return 'none';
}

export function recipeLabel(recipe, host) {
  if (!recipe?.label) return '';
  return String(host ?? '').toLowerCase().includes(recipe.label.hostHas) ? recipe.label.name : '';
}

function hasInlineScript(doc, needles) {
  if (!needles?.length) return true;
  const scripts = [...doc.querySelectorAll('script:not([src])')];
  return scripts.some((s) => needles.some((needle) => (s.textContent ?? '').includes(needle)));
}

function matchesRule(doc, loc, rule) {
  if (!rule) return true;
  const hostMatched = rule.orHostHas && String(loc?.hostname ?? '').toLowerCase().includes(rule.orHostHas);
  if (rule.all && !rule.all.every((sel) => !!doc.querySelector(sel))) return false;
  if (rule.any && !hostMatched && !rule.any.some((sel) => !!doc.querySelector(sel))) return false;
  if (rule.none && rule.none.some((sel) => !!doc.querySelector(sel))) return false;
  if (rule.script && !hasInlineScript(doc, rule.script)) return false;
  if (rule.path && !new RegExp(rule.path, 'i').test(loc?.pathname ?? '')) return false;
  return true;
}

/** Return every recipe whose `detect` and `page` match this document, in priority order. */
export function matchRecipes(doc, loc = globalThis.location) {
  return RECIPES.filter((recipe) => matchesRule(doc, loc, recipe.detect) && matchesRule(doc, loc, recipe.page));
}

/** Find a recipe by id. */
export function recipeById(id) {
  return RECIPES.find((r) => r.id === id) ?? null;
}

/** Platform-level hints (`cart` path or `where`) even when the current page isn't the cart/checkout yet. */
export function platformHints(doc, loc = globalThis.location) {
  for (const recipe of RECIPES) {
    if (!matchesRule(doc, loc, recipe.detect)) continue;
    if (recipe.cart || recipe.where) return { cart: recipe.cart ?? null, where: recipe.where ?? null, platform: recipe.platform };
  }
  return { cart: null, where: null, platform: null };
}
