'use strict';
const assert = require('assert');
const {fitStocking, fitRanges, fitPreviewSVG} = require('../dist/fit.js');

const m = {ankle: 21.5, calf: 39.0, length: 38.4};
const fit = fitStocking(m);
const ranges = fitRanges(m, fit);
assert.deepStrictEqual(ranges.map(r => r.size), ['Small', 'Wide', 'Regular']);
assert.strictEqual(ranges[0].low, 17); assert.strictEqual(ranges[0].high, 22);
assert(Math.abs(ranges[0].position - 0.9) < 1e-9);          // 21.5 in 17–22
assert(Math.abs(ranges[1].position - 0.125) < 1e-9);        // 39 in 38–46
assert(ranges.every(r => r.position >= 0 && r.position <= 1));

const svg = fitPreviewSVG(m, fit);
assert(svg.startsWith('<svg') && svg.endsWith('</svg>'));
assert(!/NaN|undefined|Infinity/.test(svg), 'no bad numbers in the drawing');
for (const text of ['Small', 'Wide', 'Regular', '21.5 cm', '39.0 cm', '38.4 cm']) assert(svg.includes(text), text);

// No preview outside the chart.
assert.strictEqual(fitRanges({ankle: 40, calf: 60, length: 38}, fitStocking({ankle: 40, calf: 60, length: 38})), null);
assert.strictEqual(fitPreviewSVG({ankle: 40, calf: 60, length: 38}, fitStocking({ankle: 40, calf: 60, length: 38})), '');

// Every chart combination draws cleanly.
for (const [ankle, calf, length] of [[18, 28, 31], [24, 55, 49], [29, 63, 44], [17, 38, 37]]) {
  const f = fitStocking({ankle, calf, length});
  if (f.band && f.cut && f.length) assert(!/NaN|undefined/.test(fitPreviewSVG({ankle, calf, length}, f)));
}
console.log('fit preview ok');
