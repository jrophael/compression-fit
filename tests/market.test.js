'use strict';
const assert = require('assert');
const {defaultMarket, marketRules, arTools, allowedFields} = require('../dist/fit.js');

// Default market: URL parameter first, then the device time zone.
assert.strictEqual(defaultMarket('Australia/Melbourne', ''), 'au');
assert.strictEqual(defaultMarket('Australia/Perth', ''), 'au');
assert.strictEqual(defaultMarket('Europe/Dublin', ''), 'ie');
assert.strictEqual(defaultMarket('Europe/London', ''), 'ie');
assert.strictEqual(defaultMarket('', ''), 'ie');
assert.strictEqual(defaultMarket('Europe/Dublin', '?market=au'), 'au');
assert.strictEqual(defaultMarket('Australia/Sydney', '?app=ios&market=IE'), 'ie');
assert.strictEqual(defaultMarket('Australia/Sydney', '?market=xx'), 'au');

// Australia: tape-derived girths only. No video, scan or AR girth.
assert.deepStrictEqual(marketRules('au').modes, ['tape', 'ar']);
assert.strictEqual(marketRules('au').imageGirth, false);
assert.deepStrictEqual(arTools('au'), ['guide', 'length']);
assert.deepStrictEqual(allowedFields('au', 'tape'), ['ankle', 'calf', 'length']);
assert.deepStrictEqual(allowedFields('au', 'guided'), ['ankle', 'calf', 'length']);
for (const source of ['video', 'scan', 'ar', 'depth']) {
  assert.deepStrictEqual(allowedFields('au', source), ['length'], source);
}

// Ireland, UK and EU: every method.
assert.deepStrictEqual(arTools('ie'), ['guide', 'length', 'girth', 'truedepth']);
for (const source of ['video', 'scan', 'ar', 'tape', 'guided']) {
  assert.deepStrictEqual(allowedFields('ie', source), ['ankle', 'calf', 'length'], source);
}
for (const mode of ['tape', 'ar', 'assisted', 'self', 'lidar']) {
  assert(marketRules('ie').modes.includes(mode), mode);
}

// An unknown market falls back to the stricter Australian rules.
assert.strictEqual(marketRules('nz').imageGirth, false);

console.log('market rules ok');
