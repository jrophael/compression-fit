'use strict';
const assert = require('assert');
const {shoeToEU, footFit} = require('../dist/fit.js');
// Reference pairs from common conversion charts (within half a size).
const cases = [[8,'UK',42], [9,'USM',42], [10,'USW',42], [8,'AUM',42], [10,'AUW',42], [42,'EU',42], [5,'UK',38], [11,'UK',46]];
for (const [size, system, eu] of cases) {
  const got = shoeToEU(size, system);
  assert(Math.abs(got - eu) <= 0.5, `${system} ${size} → EU ${got.toFixed(2)}, expected ${eu}`);
}
assert.strictEqual(footFit(8, 'UK').size, 'M');
assert.strictEqual(footFit(11, 'UK').size, 'L');
assert.strictEqual(footFit(NaN, 'UK'), null);
console.log('shoe size conversions ok');
