// Multi-language vocabulary for promo-code discovery, safety rules, totals, and shop responses.
// Covers 10 languages: EN, DE, FR, ES, IT, NL, PT, SV, DA, PL.
// All patterns expect text normalised via text.js `norm()` (lowercase, accents folded).

import { norm } from './text.js';

export const NOUN = new RegExp(`\\b(?:${[
  'coupons?(?: codes?)?', 'promo(?:tion(?:al)?)? ?codes?', 'promos?', 'discount ?codes?', 'vouchers? ?codes?', 'offer codes?',
  'gutschein-?codes?', 'rabatt-?codes?', 'aktions-?codes?', 'coupon-?codes?', 'rabattcoupons?',
  'codes? promo(?:tionnels?)?', 'codes? de (?:remise|reduction)', 'bons? de reduction',
  'cupon(?:es)?', 'codigos? promocional(?:es)?', 'codigos? de (?:descuento|cupon|desconto)', 'codigos? promocionais', 'codigos? do cupao',
  'codic[ei] promozional[ei]', 'codic[ei] sconto', 'codic[ei] coupon', 'buon[oi] sconto',
  'kortings-?codes?', 'promotie-?codes?', 'waardebon-?codes?', 'kortingsbon-?codes?', 'actie-?codes?',
  'cupa?o(?:es)?', 'cupo(?:m|ns)',
  'rabattkod(?:er|en)?', 'kampanjkod(?:er|en)?', 'kupongkod(?:er|en)?',
  'rabatkoder?', 'kampagnekoder?', 'rabatkupon(?:kode)?', 'kuponkoder?',
  'kod(?:y|u)? rabatow[yea]', 'kod(?:y|u)? promocyjn[yea]', 'kod(?:y|u)? kuponu', 'kupon(?:y|u)? rabatow[yea]',
].join('|')})\\b`);

// Words that can mean either a discount code or a gift voucher; need a second signal.
export const TWO_FACED = /\b(?:vouchers?|gutschein(?:e|s|en)?|waardebon(?:nen)?|bons?|cheques?|buon[oi]|kupon(?:y|u|er)?|coupons?)\b/;

export const DISCOUNT = /\b(?:discounts?|rabatt|rabat|remise|reduction|descuento|desconto|sconto|korting)\b/;
export const BARE_CODE = /\b(?:codes?|kod|kode|koden|codigo|codice)\b/;

export const GIFT = /\b(?:gift ?cards?|gift ?certificates?|gift ?vouchers?|e-?gift|gift ?codes?|certificates?|store credit|geschenk(?:karte|gutschein|code)\w*|gutscheinkarte|cartes? cadeaux?|cheques?[- ]cadeaux?|bons? d'achat|tarjetas? (?:de )?regalo|cheques? regalo|cart[ae] regalo|buon[oi] regalo|cadeau(?:kaart|bon)\w*|cart(?:ao|oes)[- ]presente|vales?[- ]presente|cheques?[- ]prenda|presentkort|gavekort|kart[ay] podarunkow[aey]|bon(?:y)? podarunkow[ye])\b/;

export const PIN = /\b(?:pin|security code|sicherheitscode|code de securite|codigo de seguridad|codice di sicurezza|cvv|cvc)\b/;

// Field attributes (id, name, autocomplete) that rule out a field unconditionally.
export const FIELD_KIND = new RegExp(`\\b(?:${[
  'e ?mail', 'mail', 'password', 'passwd', 'pwd', 'tel', 'phone', 'mobile', 'zip', 'zipcode', 'postal', 'postcode', 'postalcode', 'plz', 'cep',
  'qty', 'quantity', 'quantities', 'search', 'query', 'keywords?', 'card ?number', 'credit ?card', 'card ?holder', 'ccnumber', 'cc', 'cvv', 'cvc', 'csc', 'security ?code', 'verification', 'expiry', 'expiration', 'expdate',
  'otp', 'captcha', 'recaptcha', 'grecaptcha', 'username', 'login', 'firstname', 'lastname', 'fullname', 'givenname', 'familyname', 'surname',
  'city', 'town', 'state', 'region', 'province', 'county', 'country', 'street', 'address\\d?', 'housenumber', 'birthday', 'dob', 'vat', 'taxid', 'iban', 'bic',
  'pin', 'message', 'notes?', 'comments?', 'instructions', 'honeypot', 'url', 'website', 'subject', 'newsletter', 'subscribe',
  '(?:first|last|full|given|family|sur|user|company|holder|your) ?name', 'organization', 'company',
].join('|')})\\b`);

export const EXACT_NAMES = new Set(['q', 's', 'name', 'k', 'w', 'term', 'text']);

export const SECTION = /\b(?:billing|shipping|delivery|order|reference|tracking|wishlist|sku|product|item|article|review|contact|account|register|signup|estimate|calc)\b/;
export const GIFT_ATTR = /\b(?:gift\w*|cert|certs|certcode|certificate\w*|egift|storecredit)\b/;
export const ATTR_NOUN = /\b(?:coupons?|couponcode|promos?|promocode|promotions?|promotioncode|promotional|discounts?|discountcode|vouchers?|vouchercode|redeem\w*|redemption|reductions?|gutschein\w*|rabatt\w*|rabat\w*|kortings?\w*|kupon\w*|cupon\w*|cupom|cupao|aktionscode|actiecode|kampanjkod|kampagnekode|waardebon\w*)\b/;

// Phrases in labels/placeholders naming non-promo fields (stripped before checking bare "code").
export const OTHER_LABEL = new RegExp(`\\b(?:${[
  'search\\w*', 'such\\w+', 'recherch\\w*', 'busca\\w*', 'busqueda', 'cerca', 'ricerca', 'zoek\\w*', 'pesquis\\w*', 'procurar', 'sok', 'sog', 'szukaj', 'wyszukaj',
  'newsletter', 'subscribe', 'sign ?up', 'abonn\\w*', 'inscri\\w*', 'suscri\\w*', 'iscriviti', 'nieuwsbrief', 'nyhetsbrev', 'nyhedsbrev',
  'e-?mail\\w*', 'post ?codes?', 'postal ?codes?', 'zip(?: ?codes?)?', 'postleitzahl', 'plz', 'codes? posta(?:l|ux|les)', 'codigos? posta(?:l|is|les)', 'codic[ei] postal[ei]', 'postnummer', 'kod(?:y)? pocztow[ye]', 'cep', 'cap',
  'phone', 'telefon\\w*', 'telephone', 'first name', 'last name', 'full name', 'your name', 'vorname', 'nachname', 'prenom', 'apellidos?', 'cognome', 'nazwisko',
  'address\\w*', 'adresse', 'direccion', 'indirizzo', 'street', 'city', 'town', 'suburb', 'password', 'passwort', 'mot de passe', 'contrasena', 'wachtwoord',
  'card number', 'kartennummer', 'numero de carte', 'security codes?', 'verification codes?', 'one[- ]time', 'sms codes?', 'access codes?', 'country codes?', 'area codes?', 'sort codes?',
  'quantity', 'qty', 'menge', 'anzahl', 'quantite', 'cantidad', 'order (?:number|notes?|reference)', 'bestellnummer', 'tracking\\w*', 'reference', 'referenz',
  'message', 'notes?', 'comment\\w*', 'instructions', 'wishlist', 'product ?numbers?', 'produktnummer\\w*', 'artikelnummer\\w*', 'sku', 'item numbers?',
].join('|')})\\b`, 'g');

// Buttons Scout must NEVER press as an apply control (order-placing, navigation, auth, destructive).
export const DANGER = new RegExp(`\\b(?:${[
  'pay(?: now)?', 'place (?:your |my )?order', 'buy(?: now)?', 'purchase', 'complete (?:order|purchase|checkout|payment)', 'check ?out(?: now)?', 'proceed\\w*', 'continue\\w*', 'next',
  'confirm(?: order| and pay)?', 'submit order', 'order now', 'subscribe', 'sign ?in', 'log ?in', 'register', 'create account', 'add to (?:cart|basket|bag)', 'remove\\w*', 'delete', 'clear',
  'update(?: cart| basket)?', 'empty (?:cart|basket)', 'cancel\\w*', 'close', 'search', 'estimate\\w*', 'calculate\\w*',
  'bezahlen', 'zahlen', '(?:jetzt )?kaufen', '(?:kostenpflichtig|zahlungspflichtig) bestellen', 'bestellen', 'bestellung \\w+', 'zur kasse', 'kasse', 'weiter', 'fortfahren', 'bestatigen', 'anmelden', 'einloggen', 'registrieren', 'abonnieren', 'in den warenkorb', 'entfernen', 'loschen', 'suchen', 'aktualisieren', 'abbrechen',
  'payer', 'commander', 'passer (?:la )?commande', 'acheter', 'valider (?:la|ma) commande', 'finaliser', 'continuer', 'suivant', 'poursuivre', 'confirmer', 'se connecter', "s'inscrire", "s'abonner", 'ajouter au panier', 'supprimer', 'retirer', 'rechercher', 'mettre a jour', 'annuler',
  'pagar', 'comprar', 'realizar pedido', 'finalizar \\w+', 'tramitar pedido', 'continuar', 'siguiente', 'confirmar', 'iniciar sesion', 'registrarse', 'suscribirse', 'anadir al carrito', 'anadir a la cesta', 'eliminar', 'quitar', 'buscar', 'actualizar', 'cancelar',
  'paga(?:re)?', 'acquista', 'compra', 'ordina', 'effettua ordine', 'completa \\w+', 'procedi', 'continua', 'avanti', 'conferma', 'accedi', 'registrati', 'iscriviti', 'aggiungi al carrello', 'rimuovi', 'elimina', 'cerca', 'aggiorna', 'annulla',
  'betalen', 'afrekenen', 'bestelling plaatsen', 'kopen', 'nu kopen', 'doorgaan', 'verder', 'volgende', 'bevestigen', 'inloggen', 'registreren', 'abonneren', 'in winkelwagen', 'verwijderen', 'zoeken', 'bijwerken', 'annuleren',
  'concluir', 'seguinte', 'proximo', 'entrar', 'iniciar sessao', 'registar', 'registrar', 'subscrever', 'adicionar ao carrinho', 'remover', 'pesquisar', 'atualizar',
  'betala', 'kop(?: nu)?', 'slutfor \\w+', 'lagg bestallning', 'till kassan', 'kassa', 'fortsatt', 'nasta', 'bekrafta', 'logga in', 'registrera', 'prenumerera', 'lagg i varukorg\\w*', 'ta bort', 'radera', 'uppdatera', 'avbryt',
  'betal', 'kob(?: nu)?', 'gennemfor \\w+', 'afgiv ordre', 'til kassen', 'kasse', 'fortsaet', 'naeste', 'bekraeft', 'log ind', 'tilmeld', 'laeg i kurv\\w*', 'fjern', 'slet', 'opdater', 'annuller',
  'zaplac', 'kup(?: teraz)?', 'zamawiam', 'zloz zamowienie', 'zamow', 'do kasy', 'kasa', 'dalej', 'kontynuuj', 'nastepny', 'potwierdz', 'zaloguj', 'zarejestruj', 'subskrybuj', 'dodaj do koszyka', 'usun', 'aktualizuj', 'anuluj',
].join('|')})\\b`);

export const APPLY = /\b(?:apply|applies|redeem|add|submit|use|activate|ok|go|enter|anwenden|einlosen|hinzufugen|aktivieren|ubernehmen|appliquer|ajouter|valider|utiliser|envoyer|aplicar|anadir|agregar|canjear|usar|validar|applica|aggiungi|usa|invia|convalida|riscatta|toepassen|toevoegen|inwisselen|gebruiken|verzilveren|adicionar|resgatar|tillampa|lagg till|anvand|los in|aktivera|anvend|tilfoj|brug|indlos|aktiver|zastosuj|wykorzystaj|dodaj|dodac|uzyj|aktywuj|zrealizuj)\b/;

export const REMOVE_WORD = /\b(?:remove|delete|cancel|clear|entfernen|loschen|abbrechen|supprimer|retirer|annuler|eliminar|quitar|cancelar|rimuovi|elimina|annulla|verwijderen|annuleren|remover|ta bort|radera|fjern|slet|usun|anuluj)\b/;

// Order summary rows.
export const TOTAL = /\b(?:(?:order|grand|estimated|basket|cart)? ?totale?s?(?: to pay| due)?|amount due|gesamtsumme|gesamtbetrag|gesamt|bestellsumme|summe|zu zahlen|endsumme|total (?:estime|ttc|a payer|de la commande|del pedido|estimado|do pedido|ordine|stimato)|montant (?:total|final)|totaal(?:bedrag)?|ordertotaal|geschat totaal|totalt|summa|att betala|totalsumma|i alt|samlet|totalbelob|suma|razem|do zaplaty|lacznie)\b/;
export const SUBTOTAL = /\b(?:sub-?total\w*|zwischensumme|sous-?total|subtotale|totale parziale|subtotaal|delsumma|suma czesciowa|suma posrednia|kwota)\b/;
export const NOT_THE_TOTAL = /\b(?:shipping|delivery|postage|versand\w*|lieferung|livraison|envio|spedizione|verzend\w*|frakt|fragt|levering|dostawa|discount\w*|savings?|saved|you save|rabatt\w*|remise|economi\w*|descuento|sconto|risparmi\w*|korting|desconto|oszczedz\w*|ersparnis\w*|gespart|before|items?|artikel|points?|rewards?|instal?ments?|payments? of|per month|monthly|weight|quantity|free|gift\w*)\b/;
export const TAX = /\b(?:tax(?:es)?|vat|mwst|ust|tva|iva|btw|moms|podatek)\b/;
export const WITH_TAX = /\b(?:incl\w*|inkl\w*|ttc|con iva|iva incl\w*|med moms|brutto)\b/;
export const MONEY_HINT = /(?:[£$€¥₹₩₽₺₪₫฿₴₦₱]|\b(?:zl|kr|kc|ft|lei|chf|sek|nok|dkk|pln|eur|usd|gbp|cad|aud|nzd|czk|huf|ron|rs|aed|sar|kwd)\b\.?)\s?-?\d|\d[\d.,' ]*\s?(?:[£$€¥₹₩₽₺₪₫฿₴₦₱]|(?:zl|kr|kc|ft|lei|chf|sek|nok|dkk|pln|eur|usd|gbp|cad|aud|nzd|czk|huf|ron)\b)/;

// Controls that reveal a collapsed promo box.
export const REVEAL = new RegExp(`(?:${[
  '\\b(?:have|got|do you have|add|apply|enter|use|redeem|click here to enter)\\b.{0,24}\\b(?:coupons?|promo(?:tion)?(?: ?codes?)?|discount(?: ?codes?)?|vouchers?|codes?)\\b',
  '^(?:coupons?(?: ?codes?)?|promo(?:tion)? ?codes?|discount(?: ?codes?)?|vouchers?(?: ?codes?)?|discount or gift card|coupon ?/ ?gift certificate|gift card or discount code)\\W*$',
  '\\b(?:hast du|haben sie|du hast|sie haben)\\b.{0,30}\\b(?:gutschein\\w*|rabattcode|aktionscode|coupon)',
  '\\b(?:gutschein\\w*|rabattcode|aktionscode)\\b.{0,20}\\b(?:eingeben|einlosen|hinzufugen)\\b',
  '\\b(?:avez-vous|vous avez)\\b.{0,30}\\b(?:code|bon)\\b',
  '\\bajouter\\b.{0,20}\\b(?:code|bon)',
  '\\b(?:tienes|tiene)\\b.{0,30}\\b(?:cupon|codigo)',
  '\\banadir\\b.{0,20}\\bcupon',
  '\\bhai un\\b.{0,30}\\b(?:codice|coupon)',
  '\\baggiungi\\b.{0,24}\\b(?:codic[ei]|coupon)',
  '\\bheb je\\b.{0,30}\\b(?:kortingscode|waardebon|promotiecode)',
  '\\b(?:waardebon\\w*|kortingscode) toevoegen',
  '\\b(?:tem|tens|voce tem)\\b.{0,30}\\b(?:cupao|cupom|codigo)',
  '\\badicionar\\b.{0,20}\\bcup',
  '\\bhar du en\\b.{0,30}\\b(?:rabattkod|kampanjkod|rabatkode|kampagnekode|rabatkupon)',
  '\\blagg till rabattkod',
  '\\btilfoj rabatkod',
  '\\b(?:masz|czy masz)\\b.{0,30}\\b(?:kupon|kod)',
  '\\bdodaj kupon',
].join('|')})`);

// Rate limit / security check / pause wording (10 languages).
export const PAUSE_WORDS = new RegExp(`(?:${[
  'too many (?:discount |promo(?:tion)? |voucher |coupon )?(?:codes|attempts|tries|requests)',
  'try again later', 'please wait', 'security check', 'verify you are human', 'rate limit',
  "couldn't apply your code right now", 'could not apply your code right now',
  'zu viele versuche', 'spater erneut versuchen', 'sicherheitsprufung',
  'trop de tentatives', 'reessayez plus tard', 'verification de securite',
  'demasiados intentos', 'intentalo mas tarde',
  'troppi tentativi', 'riprova piu tardi',
  'te veel pogingen', 'probeer het later opnieuw',
  'muitas tentativas', 'tente novamente mais tarde',
  'for manga forsok', 'forsoek igen senare',
  'for mange forsog', 'prov igen senere',
  'zbyt wiele prob', 'sprobuj pozniej',
].join('|')})`);

// Multi-language refusal classification. Order matters: basket/shopper-specific reasons come before generic invalid.
export const REFUSAL_PATTERNS = [
  ['better', /\b(?:better offer (?:is |has )?already (?:been )?applied|higher[- ]value discount)\b/],
  ['combine', /\b(?:cannot be combined|not combinable|in conjunction with other|couldn't be used with your existing|cumulable|cumuler|kombinierbar|combinar)\b/],
  ['shopper', /\b(?:already (?:been )?(?:used|redeemed|applied|in your cart)|first[- ]time buyers? only|bereits (?:angewendet|verwendet|eingelost)|deja (?:applique|utilise)|ya (?:se ha aplicado|esta aplicado|utilizado)|gia (?:applicato|utilizzato)|al toegepast|ja (?:esta aplicado|foi utilizado)|redan (?:anvants|tillampad)|allerede (?:anvendt|brugt)|zostal juz (?:zastosowany|uzyty))\b/],
  ['basket', /\b(?:not applicable|doesn't apply|does not apply|not eligible for this|customer not eligible|not valid for (?:sale|selected)|minimum (?:spend|order|amount|total|purchase)|maximum spend|requirements|cart contents|only valid for (?:specific|orders above)|selected products|shipping discounts are shown|gilt nicht fur|nicht auf .* anwendbar|mindestbestellwert|ne s'applique pas|pas applicable|minimum de depense|no (?:se puede aplicar|es aplicable)|minimo gastado|non e applicabile|spesa minima|niet van toepassing|minimale bestelbedrag|nao (?:e aplicavel|se aplica)|gasto minimo|kan inte anvandas|minsta belopp|kan .* ikke benyttes|gaelder ikke|minimumsforbruget|nie dotyczy|nie ma zastosowania|minimalna kwota)\b/],
  ['expired', /\b(?:expired|has ended|no longer available|no longer valid|abgelaufen|a expire|ha caducado|e scaduto|verlopen|expirou|har lopt ut|er udlobet|stracil waznosc|wygasl)\b/],
  ['usedUp', /\b(?:max redemptions|usage limit|exceeded the number of times|nutzungslimit|anzahl der verwendungen|limite d'utilisation|limite del cupon|supero la cantidad|limite di utilizzo|gebruiksbeperking|excedeu o numero|anvandningsgransen|graensen for brug|limit wykorzystania|przekroczyl dozwolona)\b/],
  ['invalid', /\b(?:invalid|invalide|not valid|isn't valid|not recogni[sz]ed|does not exist|doesn't exist|no such|enter a valid|ungultig|nicht gultig|existiert nicht|non valide|pas valide|n'existe pas|no valido|no es valido|no existe|non valido|non esiste|ongeldig|niet geldig|niet bestaat|invalido|nao e valido|nao existe|ogiltig|inte finns|ugyldig|ikke gyldig|ikke findes|nieprawidlowy|bledny|niepoprawny|niewazny|nie istnieje)\b/],
  ['generic', /\b(?:couldn't be applied|could not be applied|cannot be applied|can't be applied|cannot be added|unable to apply|cannot currently be added|check the code and try again|kann nicht angewendet|impossible d'appliquer|impossible d'ajouter|no se puede aplicar|non puo essere applicato|non puo essere aggiunto|kan niet worden toegepast|nao pode ser aplicado|kan inte tillampas|kan ikke anvendes|nie moze zostac wykorzystany)\b/],
];

/** Classify normalised shop refusal text into { pause } or { reason } or null. */
export function classifyMessageText(rawText) {
  const text = norm(rawText);
  if (!text) return null;
  if (PAUSE_WORDS.test(text)) return { kind: 'pause' };
  for (const [reason, pattern] of REFUSAL_PATTERNS) {
    if (pattern.test(text)) return { kind: 'error', reason };
  }
  return null;
}

export const EMPTY_BASKET_WORDS = /\b(?:(?:your )?(?:basket|cart|bag) is (?:currently )?empty|no items (?:in|added to) your (?:basket|cart|bag)|warenkorb ist leer|panier est vide|carrito esta vacio|carrello e vuoto|winkelwagen is leeg|carrinho esta vazio|varukorg(?:en)? ar tom|kurv(?:en)? er tom|koszyk jest pusty)\b/;

export const CONFIRMATION_WORDS = /\b(?:thank you for your order|order confirmed|order confirmation|your order has been placed|vielen dank fur ihre bestellung|merci pour votre commande|gracias por tu pedido|grazie per il tuo ordine|bedankt voor je bestelling|obrigado pelo seu pedido|tack for din bestallning|tak for din ordre|dziekujemy za zamowienie)\b/;

export const CART_PATH = /\b(?:cart|basket|bag|checkout|checkouts|warenkorb|kasse|panier|commande|carrito|cesta|carrello|cassa|winkelwagen|winkelmand|afrekenen|carrinho|varukorg|kundvagn|kurv|koszyk|zamowienie)\b/;
export const CHECKOUT_PATH = /\b(?:checkout|checkouts|kasse|commande|cassa|afrekenen|zamowienie)\b/;
export const CART_ONLY_PATH = /\b(?:cart|basket|bag|warenkorb|panier|carrito|cesta|carrello|winkelwagen|winkelmand|carrinho|varukorg|kundvagn|kurv|koszyk)\b/;
