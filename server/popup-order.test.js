import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HEADINGS, SHORTCUTS_KEY, arrange, groupsFor, isWorking, leads, middleCut, othersDown, othersUp, printable,
  shortcutHints, shortcutPlace, shortcutsOn, shownTitles,
} from '../extension/popup-order.js';

const codes = (group) => group.map((coupon) => coupon.code);
const titles = (list, pro, pageCodes = []) => shownTitles(groupsFor(arrange(list, pageCodes), pro));

test('a single confirmed group still gets its heading on Pro', () => {
  // The two-account case: one code on the shop, confirmed by another member, none on the page.
  const list = [{ code: 'more', worked: 1, failed: 0, myReport: null }];
  const arranged = arrange(list);
  assert.deepEqual(codes(arranged.confirmed), ['MORE']);
  assert.deepEqual(arranged.rest, []);
  assert.deepEqual(titles(list, true), [HEADINGS.confirmed]);
  assert.equal(HEADINGS.confirmed, 'Worked for other members');
});

test('a single unconfirmed group on Pro needs no heading', () => {
  assert.deepEqual(titles([{ code: 'A1B2', worked: 0, failed: 0 }], true), []);
});

test('the shopper’s own thumbs-up alone does not make a code "worked for others"', () => {
  const own = { code: 'MORE', worked: 1, failed: 0, myReport: 1 };
  assert.equal(othersUp(own), 0);
  assert.equal(leads(own), false);
  assert.equal(isWorking(own, true), false);
  const arranged = arrange([own]);
  assert.deepEqual(arranged.confirmed, []);
  assert.deepEqual(codes(arranged.rest), ['MORE']);
  assert.deepEqual(titles([own], true), []);
  // One more member agreeing is what confirms it.
  assert.equal(isWorking({ ...own, worked: 2 }, true), true);
});

test('the shopper’s own thumbs-down alone does not hide a code others confirmed', () => {
  const mine = { code: 'SAVE10', worked: 1, failed: 1, myReport: 0 };
  assert.equal(othersDown(mine), 0);
  assert.equal(leads(mine), true);
  assert.equal(isWorking(mine, true), true);
  assert.deepEqual(codes(arrange([mine]).confirmed), ['SAVE10']);
  // Somebody else's thumbs-down does count against it.
  assert.equal(leads({ code: 'SAVE10', worked: 1, failed: 1, myReport: null }), false);
});

test('shared reports are a Pro feature: nothing is "working" on Free', () => {
  assert.equal(isWorking({ code: 'X', worked: 9, failed: 0 }, false), false);
  assert.equal(isWorking({ code: 'X', worked: 9, failed: 0 }, undefined), false);
});

test('confirmed codes are ordered by net support, then thumbs-up, then the server’s order', () => {
  const list = [
    { code: 'REST1', worked: 0, failed: 0 },
    { code: 'NET1', worked: 2, failed: 1 },
    { code: 'NET3-UP3', worked: 3, failed: 0 },
    { code: 'NET3-UP5', worked: 5, failed: 2 },
    { code: 'REST2', worked: 1, failed: 4 },
    { code: 'NET1-LATER', worked: 2, failed: 1 },
    // Three thumbs up, but one of them is the shopper's own: net support from others is 2.
    { code: 'NET2-MINE', worked: 3, failed: 0, myReport: 1 },
  ];
  const { confirmed, rest, onPage, listed } = arrange(list);
  assert.deepEqual(codes(confirmed), ['NET3-UP5', 'NET3-UP3', 'NET2-MINE', 'NET1', 'NET1-LATER']);
  assert.deepEqual(codes(rest), ['REST1', 'REST2']);
  assert.deepEqual(onPage, []);
  assert.equal(listed, 7);
  assert.deepEqual(titles(list, true), [HEADINGS.confirmed, HEADINGS.rest]);
});

test('Free shows no member headings', () => {
  const list = [
    { code: 'UP', worked: 4, failed: 0 },
    { code: 'PLAIN', worked: 0, failed: 0 },
  ];
  assert.deepEqual(titles(list, false), []);
  const withPage = titles(list, false, [{ code: 'EXTRA', offer: '5% off' }]);
  assert.deepEqual(withPage, [HEADINGS.page, HEADINGS.web]);
  for (const title of [HEADINGS.confirmed, HEADINGS.rest]) assert.ok(!withPage.includes(title));
  // The web codes are one group on Free, in the same order a run tries them.
  const [, [, web]] = groupsFor(arrange(list, [{ code: 'EXTRA', offer: '5% off' }]), false);
  assert.deepEqual(codes(web), ['UP', 'PLAIN']);
});

test('Pro shows all three headings when the page has codes too', () => {
  const list = [{ code: 'UP', worked: 4, failed: 0 }, { code: 'PLAIN', worked: 0, failed: 0 }];
  assert.deepEqual(titles(list, true, [{ code: 'EXTRA', offer: '' }]), [HEADINGS.page, HEADINGS.confirmed, HEADINGS.rest]);
  assert.deepEqual(titles([], true, [{ code: 'EXTRA', offer: '' }]), [HEADINGS.page]);
});

test('page codes come first and merge with a server row of the same code in either letter case', () => {
  for (const spelling of ['extra', 'EXTRA', 'Extra']) {
    const list = [
      { code: 'TOP', worked: 6, failed: 0 },
      { code: spelling, offer: '', worked: 2, failed: 0, myReport: null, sources: ['https://codes.example/x'] },
    ];
    const arranged = arrange(list, [{ code: 'EXTRA', offer: 'Extra 5% off' }, { code: 'PAGEONLY', offer: '10% off' }]);
    const order = [...arranged.onPage, ...arranged.confirmed, ...arranged.rest];
    assert.deepEqual(codes(order), ['EXTRA', 'PAGEONLY', 'TOP'], spelling);
    const [merged, pageOnly] = arranged.onPage;
    // One ticket, the server's: its thumbs and its own spelling for reports, with the page's offer filling the gap.
    assert.equal(merged.reportCode, spelling);
    assert.equal(merged.worked, 2);
    assert.equal(merged.offer, 'Extra 5% off');
    assert.equal(merged.onPage, true);
    assert.equal(merged.pageOnly, undefined);
    assert.deepEqual(pageOnly, { code: 'PAGEONLY', reportCode: 'PAGEONLY', offer: '10% off', worked: 0, failed: 0, onPage: true, pageOnly: true });
    assert.equal(arranged.listed, 2);
  }
});

test('a server offer wins over the page’s when both state one', () => {
  const { onPage } = arrange([{ code: 'EXTRA', offer: 'From the web' }], [{ code: 'EXTRA', offer: 'From the page' }]);
  assert.equal(onPage[0].offer, 'From the web');
});

test('the same code in two casings is one ticket, keeping the one with more thumbs', () => {
  const printed = printable([
    { code: 'save10', worked: 0, failed: 0 },
    { code: 'SAVE10', worked: 3, failed: 1 },
    { code: '', worked: 1 },
    { code: 42 },
    null,
  ]);
  assert.equal(printed.length, 1);
  assert.deepEqual({ code: printed[0].code, reportCode: printed[0].reportCode, worked: printed[0].worked }, { code: 'SAVE10', reportCode: 'SAVE10', worked: 3 });
  assert.deepEqual(printable(undefined), []);
});

test('a code that worked for the shopper alone sits under a heading that stays true', () => {
  // The run filed the shopper's own thumbs-up. Nobody else has confirmed the code, and the heading says exactly that:
  // it never calls the code unconfirmed, only unconfirmed by other members.
  const list = [
    { code: 'SHARED', worked: 3, failed: 0, myReport: null },
    { code: 'MINE', worked: 1, failed: 0, myReport: 1 },
  ];
  const groups = groupsFor(arrange(list), true);
  const [title, group] = groups.find(([, coupons]) => coupons.some(({ code }) => code === 'MINE'));
  assert.equal(title, HEADINGS.rest);
  assert.equal(HEADINGS.rest, 'Not confirmed by other members');
  assert.deepEqual(codes(group), ['MINE']);
  assert.doesNotMatch(HEADINGS.rest, /yet$/);
});

test('shortcuts are on unless they were switched off', () => {
  assert.equal(SHORTCUTS_KEY, 'copyShortcuts');
  // Nothing stored, or anything that is not an explicit "off", leaves them on.
  for (const stored of [undefined, null, true, 'false', 0, '']) assert.equal(shortcutsOn(stored), true, String(stored));
  assert.equal(shortcutsOn(false), false);
});

test('C is the top ticket and 1 to 9 are the tickets in those places', () => {
  const press = (key, more = {}) => shortcutPlace({ key, ...more });
  assert.equal(press('c'), 1);
  assert.equal(press('C'), 1);
  assert.deepEqual(['1', '2', '5', '9'].map((key) => press(key)), [1, 2, 5, 9]);
  for (const key of ['0', 'x', 'Enter', ' ', 'Tab', '10', 'F1', '']) assert.equal(press(key), 0, key);
});

test('a key press is never a shortcut while a modifier is held, a key repeats or text is being composed', () => {
  for (const held of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey', 'repeat', 'isComposing', 'defaultPrevented']) {
    assert.equal(shortcutPlace({ key: 'c', [held]: true }), 0, held);
    assert.equal(shortcutPlace({ key: '3', [held]: true }), 0, held);
  }
  assert.equal(shortcutPlace(undefined), 0);
  assert.equal(shortcutPlace({}), 0);
});

test('switched off, no key is a shortcut and no ticket hints at one', () => {
  for (const key of ['c', 'C', '1', '9']) assert.equal(shortcutPlace({ key }, false), 0, key);
  for (const index of [0, 1, 8]) assert.deepEqual(shortcutHints(index, false), { keys: '', title: '' });
});

test('the first nine tickets name their key, and only the first carries the tooltip', () => {
  const first = shortcutHints(0);
  assert.equal(first.keys, 'C 1');
  assert.match(first.title, /press C to copy this code, or 1 to 9/);
  assert.deepEqual(shortcutHints(1), { keys: '2', title: '' });
  assert.deepEqual(shortcutHints(8), { keys: '9', title: '' });
  // A tenth ticket has no key, and neither has anything that is not a place in the list.
  for (const index of [9, 12, -1, 1.5, undefined]) assert.deepEqual(shortcutHints(index), { keys: '', title: '' });
});

test('a long code is cut in the middle and keeps both its ends', () => {
  const long = 'STUDENT-EXTRA-25-NOVEMBER-NEWCUSTOMER-XY';
  assert.equal(long.length, 40);
  assert.equal(middleCut(long, 20), 'STUDENT-EX…STOMER-XY');
  assert.equal(middleCut(long, 20).length, 20);
  assert.equal(middleCut(long, 11), 'STUDE…ER-XY');
  // Every length a sentence might be given leaves the first and last characters in place.
  for (let limit = 5; limit < long.length; limit += 1) {
    const cut = middleCut(long, limit);
    assert.equal(cut.length, limit, String(limit));
    assert.equal(cut[0], 'S');
    assert.equal(cut.at(-1), 'Y');
    assert.equal(cut.split('…').length, 2);
  }
});

test('a code that fits is never cut, and a cut never goes below five characters', () => {
  assert.equal(middleCut('SAVE45', 20), 'SAVE45');
  assert.equal(middleCut('ABCDEFGHIJKLMNOPQRST', 20), 'ABCDEFGHIJKLMNOPQRST');
  assert.equal(middleCut('ABCDEFGHIJKLMNOPQRSTU', 20), 'ABCDEFGHIJ…MNOPQRSTU');
  assert.equal(middleCut('ABCDEFGHIJ', 2), 'AB…IJ');
  assert.equal(middleCut('ABCDEFGHIJ', undefined), 'AB…IJ');
  assert.equal(middleCut('ABCDEFGHIJ', Infinity), 'ABCDEFGHIJ');
  assert.equal(middleCut(12345678, 5), '12…78');
});
