'use strict';
const assert = require('assert');
const {recommendProfile, fitStocking, fitPreviewSVG} = require('../dist/fit.js');

const base = {mobility: 'active', donning: false, swelling: false, flags: []};
const rec = extra => recommendProfile(Object.assign({}, base, extra));

assert.strictEqual(recommendProfile({}), null);
assert.strictEqual(recommendProfile(null), null);

// Safety screens win, in order.
assert.strictEqual(rec({goal: 'travel', flags: ['clot', 'circulation']}).kind, 'urgent');
assert.strictEqual(rec({goal: 'travel', flags: ['clot']}).sell, false);
assert.strictEqual(rec({goal: 'heavy', flags: ['diabetes']}).kind, 'refer');
assert.strictEqual(rec({goal: 'heavy', flags: ['circulation']}).preview, null);
const ulcer = rec({goal: 'heavy', donning: true, flags: ['ulcer']});
assert.strictEqual(ulcer.kind, 'refer'); assert.strictEqual(ulcer.preview, 'graduated');
assert.strictEqual(rec({goal: 'heavy', mobility: 'immobile'}).kind, 'refer');
assert.strictEqual(rec({goal: 'prescribed'}).kind, 'prescribed');

// Needs-based profiles.
const travel = rec({goal: 'travel'});
assert.strictEqual(travel.kind, 'graduated'); assert.strictEqual(travel.grade, 'High');
assert.strictEqual(travel.cls, 'Light, 15–20 mmHg'); assert.strictEqual(travel.length, 'Below knee');
assert.strictEqual(rec({goal: 'travel', donning: true}).kind, 'graduated');
assert.strictEqual(rec({goal: 'heavy', swelling: true, donning: true}).kind, 'graduated');
const easy = rec({goal: 'heavy', donning: true});
assert.strictEqual(easy.kind, 'progressive'); assert.strictEqual(easy.preview, 'progressive');
assert(easy.refs.some(r => r.includes('81.3%')));
assert.strictEqual(rec({goal: 'heavy'}).kind, 'either');
assert.strictEqual(rec({goal: 'work'}).kind, 'either');
assert.strictEqual(rec({goal: 'work', donning: true}).preview, 'progressive');
assert.strictEqual(rec({goal: 'sport'}).kind, 'either');
for (const r of [travel, easy, rec({goal: 'work'}), rec({goal: 'sport'})]) {
  assert(r.sell && r.refs.length && r.reason && r.grade);
}

// The preview follows the profile.
const m = {ankle: 21.5, calf: 39.0, length: 38.4};
const fit = fitStocking(m);
const g = fitPreviewSVG(m, fit), p = fitPreviewSVG(m, fit, 'progressive');
assert(g.includes('graduated stocking') && g.includes('lightest') && !/NaN/.test(g));
assert(p.includes('progressive stocking') && !p.includes('lightest') && p.includes('firmest') && !/NaN/.test(p));
console.log('profile selector ok');
