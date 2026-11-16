'use strict';
// Shared synthetic leg shape for tests.
const path = require('path');
const Scan = require(path.join(__dirname, '..', 'dist', 'scan.js'));

// Leg cross-section radius at axial height h (m) and angle th. Front of leg is +v.
function legRadius(h, th, leg) {
  const s = leg.scale;
  // Base circumference profile (m): malleoli bulge, narrow ankle, calf belly, tapering to knee.
  const c = s * (0.235
    + 0.030 * Math.exp(-(((h - 0.07) / 0.018) ** 2))   // malleoli
    - 0.025 * Math.exp(-(((h - 0.12) / 0.03) ** 2))    // narrowest ankle
    + 0.135 * Math.exp(-(((h - leg.calfH) / 0.11) ** 2)) // calf
    + 0.05 * Math.max(0, (h - 0.12) / 0.3));
  const r0 = c / (2 * Math.PI);
  const ellipse = 1 / Math.sqrt((Math.cos(th) / leg.ax) ** 2 + (Math.sin(th) / leg.ay) ** 2);
  // Achilles groove (back, concave) and tibial crest (front, convex).
  const back = -Math.PI / 2, front = Math.PI / 2;
  const dBack = Math.atan2(Math.sin(th - back), Math.cos(th - back));
  const dFront = Math.atan2(Math.sin(th - front), Math.cos(th - front));
  const groove = h < 0.2 ? -0.10 * Math.exp(-((dBack / 0.25) ** 2)) : 0;
  const crest = 0.04 * Math.exp(-((dFront / 0.2) ** 2));
  return r0 * ellipse * (1 + groove + crest);
}

function truthProfile(leg) {
  const out = [];
  for (let h = 0.04; h <= leg.cuffH; h += 0.0025) {
    const pts = [];
    for (let k = 0; k < 2000; k++) {
      const th = k / 2000 * 2 * Math.PI;
      const r = legRadius(h, th, leg);
      pts.push([r * Math.cos(th), r * Math.sin(th)]);
    }
    out.push({h, c: Scan.convexHullPerimeter(pts)});
  }
  return out;
}


module.exports = {legRadius, truthProfile};
