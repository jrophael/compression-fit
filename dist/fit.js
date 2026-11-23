'use strict';

const chart = [
  {band:'Small', ankle:[17,22], cuts:[['Standard',27,38], ['Wide',38,46], ['Extra wide',46,53]]},
  {band:'Medium', ankle:[22,26], cuts:[['Standard',30,42], ['Wide',42,50], ['Extra wide',50,58]]},
  {band:'Large', ankle:[26,30], cuts:[['Standard',34,46], ['Wide',46,56], ['Extra wide',56,64]]}
];
const lengths = [['Short',30,37], ['Regular',37,43], ['Long',43,50]];
const fields = ['ankle','calf','length'];

// Shoe size → EU size, via the standard last-length rules (last ≈ foot length + 1.5 cm).
// EU (Paris point) = 1.5 × last cm; UK = 3 × last inches − 25; US men = UK + 1; US/AU women = UK + 2; AU men = UK.
const shoeSystems = {
  EU: {label:'EU', toUK: eu => 3 * (eu / 1.5) / 2.54 - 25},
  UK: {label:'UK', toUK: uk => uk},
  AUM: {label:'AU men', toUK: au => au},
  AUW: {label:'AU women', toUK: au => au - 2},
  USM: {label:'US men', toUK: us => us - 1},
  USW: {label:'US women', toUK: us => us - 2}
};
// Provisional pilot foot sizes (EU ranges); replace with the chosen maker's chart.
const footSizes = [['S',35,39], ['M',39,43], ['L',43,47], ['XL',47,51]];

function shoeToEU(size, system) {
  const convert = shoeSystems[system];
  if (!convert || !Number.isFinite(size)) return null;
  const lastInches = (convert.toUK(size) + 25) / 3;
  return 1.5 * lastInches * 2.54;
}

function footFit(size, system) {
  const eu = shoeToEU(size, system);
  if (eu === null) return null;
  const rounded = Math.round(eu * 2) / 2;
  const band = footSizes.find(([,low,high]) => inBand(rounded, low, high));
  return {eu: rounded, footLength: eu / 1.5 - 1.5, size: band?.[0] ?? null, range: band ? band[1] + '–' + (band[2] - 1) : null};
}
// Markets. In Australia the ankle and calf circumferences come only from a physical tape
// (typed in, or placed with the AR tape guide). Camera- and scan-derived girths are offered
// only in Ireland, the UK and the EU, so in Australia those modes are hidden and refused.
const markets = {
  au: {label:'Australia', imageGirth:false, modes:['tape','ar']},
  ie: {label:'Ireland, UK or EU', imageGirth:true, modes:['tape','ar','assisted','self','lidar']}
};

function defaultMarket(timeZone = '', search = '') {
  const param = /[?&]market=(au|ie)(?:&|$)/i.exec(search || '');
  if (param) return param[1].toLowerCase();
  return /^Australia\//.test(timeZone || '') ? 'au' : 'ie';
}

const marketRules = market => markets[market] ?? markets.au;
const arTools = market => marketRules(market).imageGirth ? ['guide','length','girth','truedepth'] : ['guide','length'];

// Fields a measurement source may fill in a market: tape (typed or AR-guided) fills all three;
// camera, AR ruler and scan results fill only the length where image girths are not offered.
function allowedFields(market, source) {
  if (source === 'tape' || source === 'guided' || marketRules(market).imageGirth) return fields.slice();
  return ['length'];
}

const isNear = (value, limits) => limits.some(limit => Math.abs(value - limit) <= 1);
const inBand = (value, low, high) => value >= low && value < high;

function fitStocking(measurements, videoFields = []) {
  const {ankle, calf, length} = measurements;
  const band = chart.find(row => inBand(ankle, ...row.ankle));
  const cut = band?.cuts.find(([,low,high]) => inBand(calf, low, high));
  const lengthBand = lengths.find(([,low,high]) => inBand(length, low, high));
  const bounds = {
    ankle:chart.flatMap(row => row.ankle),
    calf:band?.cuts.flatMap(row => row.slice(1)) ?? [],
    length:lengths.flatMap(row => row.slice(1))
  };
  const checks = videoFields.filter(field => isNear(measurements[field], bounds[field]));
  return {band:band?.band, cut:cut?.[0], length:lengthBand?.[0], checks};
}

// ---------- Stocking-fit preview ----------
// The size ranges a fit falls in, and where each measurement sits within its range (0–1).
function fitRanges(measurements, fit) {
  const band = chart.find(row => row.band === fit.band);
  const cut = band?.cuts.find(([name]) => name === fit.cut);
  const length = lengths.find(([name]) => name === fit.length);
  if (!band || !cut || !length) return null;
  const position = (value, low, high) => Math.min(1, Math.max(0, (value - low) / (high - low)));
  return [
    {field:'ankle', label:'Ankle band', size:band.band, low:band.ankle[0], high:band.ankle[1], value:measurements.ankle},
    {field:'calf', label:'Calf', size:cut[0], low:cut[1], high:cut[2], value:measurements.calf},
    {field:'length', label:'Length', size:length[0], low:length[1], high:length[2], value:measurements.length}
  ].map(range => ({...range, position:position(range.value, range.low, range.high)}));
}

// Smooth closed outline through points (Catmull-Rom → cubic Bézier).
function smoothPath(points) {
  const n = points.length;
  let d = 'M' + points[0].map(v => v.toFixed(1)).join(' ');
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n], p1 = points[i], p2 = points[(i + 1) % n], p3 = points[(i + 2) % n];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ' C' + [...c1, ...c2, ...p2].map(v => v.toFixed(1)).join(' ');
  }
  return d + 'Z';
}

// A front-view hologram of the leg drawn to the person's own measurements (4 px per cm,
// widths from circumference ÷ π), wearing the recommended stocking with graduated shading.
// Numbers only: no user text is placed in the markup.
function fitPreviewSVG(measurements, fit) {
  const ranges = fitRanges(measurements, fit);
  if (!ranges) return '';
  const {ankle, calf, length} = measurements;
  const px = 4, floor = 262, cx = 110;
  const y = h => floor - h * px;
  const half = circumference => circumference / Math.PI / 2 * px * 1.1;
  const calfHeight = Math.min(length - 5, Math.max(20, length * 0.72));
  const a = half(ankle), c = half(calf), knee = c * 0.8;
  // Leg outline from the knee down to the heel, front view, with a foot pointing towards the viewer.
  const right = [[cx + knee * 0.96, y(length + 7)], [cx + knee, y(length)], [cx + c * 0.94, y((length + calfHeight) / 2)],
    [cx + c, y(calfHeight)], [cx + (a + c) / 2 * 0.95, y((calfHeight + 10) / 2)], [cx + a, y(10)],
    [cx + a * 1.15, y(5)], [cx + a * 1.5, y(1.2)]];
  const left = right.map(([x, yy]) => [2 * cx - x, yy]).reverse();
  const leg = smoothPath([...right, [cx + a * 1.2, y(-1.5)], [cx - a * 1.2, y(-1.5)], ...left]);
  // Stocking: the same outline from the foot up to the cuff (length), slightly inside the skin.
  const inset = 0.94;
  const sRight = right.slice(1).map(([x, yy]) => [cx + (x - cx) * inset, yy]);
  const stocking = smoothPath([...sRight, [cx + a * 1.12, y(-1.2)], [cx - a * 1.12, y(-1.2)],
    ...sRight.map(([x, yy]) => [2 * cx - x, yy]).reverse()]);
  const cuffY = y(length), cuffHalf = knee * inset;
  const gauge = (range, index) => {
    const top = 34 + index * 76, x0 = 206, width = 100;
    const marker = x0 + range.position * width;
    return '<g class="fit-gauge" transform="translate(0 ' + top + ')">' +
      '<text class="gauge-label" x="' + x0 + '" y="0">' + ['Ankle','Calf','Length'][index] +
      ' <tspan class="gauge-value">' + range.value.toFixed(1) + ' cm</tspan></text>' +
      '<text class="gauge-size" x="' + x0 + '" y="17">' + range.size + '</text>' +
      '<rect class="gauge-track" x="' + x0 + '" y="26" width="' + width + '" height="6" rx="3"/>' +
      '<rect class="gauge-fill" x="' + x0 + '" y="26" width="' + (range.position * width).toFixed(1) + '" height="6" rx="3"/>' +
      '<circle class="gauge-marker" cx="' + marker.toFixed(1) + '" cy="29" r="5"/>' +
      '<text class="gauge-end" x="' + x0 + '" y="46">' + range.low + '</text>' +
      '<text class="gauge-end" x="' + (x0 + width) + '" y="46" text-anchor="end">' + range.high + ' cm</text>' +
      '</g>';
  };
  // Indexes match the label order in fitRanges.
  const sizeNames = ranges.map(r => r.size);
  return '<svg viewBox="0 0 320 290" role="img" aria-label="' + sizeNames.join(', ') + ' stocking on a hologram of the leg">' +
    '<defs><linearGradient id="fit-pressure" x1="0" y1="1" x2="0" y2="0">' +
    '<stop offset="0" stop-color="#5eeeff" stop-opacity="0.62"/>' +
    '<stop offset="0.55" stop-color="#5eeeff" stop-opacity="0.38"/>' +
    '<stop offset="1" stop-color="#5eeeff" stop-opacity="0.16"/></linearGradient>' +
    '<filter id="fit-glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2" result="b"/>' +
    '<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
    '<linearGradient id="fit-fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/>' +
    '<stop offset="0.12" stop-color="#fff" stop-opacity="1"/></linearGradient>' +
    '<mask id="fit-leg-mask"><rect x="0" y="' + y(length + 7).toFixed(1) + '" width="220" height="' + ((length + 9) * px).toFixed(1) + '" fill="url(#fit-fade)"/></mask>' +
    '<clipPath id="fit-on"><rect class="fit-on-rect" x="0" y="0" width="200" height="290"/></clipPath></defs>' +
    '<line class="fit-floor" x1="30" y1="' + (floor + 7) + '" x2="190" y2="' + (floor + 7) + '"/>' +
    '<path class="fit-leg" mask="url(#fit-leg-mask)" d="' + leg + '"/>' +
    '<g clip-path="url(#fit-on)"><path class="fit-stocking" d="' + stocking + '"/>' +
    [0.25, 0.5, 0.75].map(f => {
      const h = 10 + (length - 10) * f, yy = y(h);
      const w = (f < 0.6 ? a + (c - a) * Math.min(1, (h - 10) / (calfHeight - 10)) : c - (c - knee) * ((h - calfHeight) / (length - calfHeight))) * inset;
      return '<ellipse class="fit-knit" cx="' + cx + '" cy="' + yy.toFixed(1) + '" rx="' + w.toFixed(1) + '" ry="3"/>';
    }).join('') +
    '<ellipse class="fit-cuff" cx="' + cx + '" cy="' + cuffY.toFixed(1) + '" rx="' + cuffHalf.toFixed(1) + '" ry="4"/></g>' +
    '<text class="fit-pressure" x="' + (cx - c - 14).toFixed(1) + '" y="' + y(9).toFixed(1) + '" text-anchor="end">firmest</text>' +
    '<text class="fit-pressure" x="' + (cx - c - 14).toFixed(1) + '" y="' + (cuffY + 4).toFixed(1) + '" text-anchor="end">lightest</text>' +
    '<line class="fit-pressure-arrow" x1="' + (cx - c - 8).toFixed(1) + '" y1="' + y(10).toFixed(1) + '" x2="' + (cx - c - 8).toFixed(1) + '" y2="' + (cuffY + 2).toFixed(1) + '"/>' +
    ranges.map(gauge).join('') + '</svg>';
}

const distance = (a,b) => Math.hypot(a[0]-b[0],a[1]-b[1]);

function planeFromCorners(corners) {
  if (corners.length !== 4) throw new Error('Mark all four target corners.');
  const turn = corners.map((a, i) => {
    const b = corners[(i + 1) % 4], c = corners[(i + 2) % 4];
    return (b[0]-a[0])*(c[1]-b[1]) - (b[1]-a[1])*(c[0]-b[0]);
  });
  if (!turn.every(value => value > 0) ||
      corners[0][0] >= corners[1][0] || corners[3][0] >= corners[2][0] ||
      corners[0][1] >= corners[3][1] || corners[1][1] >= corners[2][1]) {
    throw new Error('Mark the outer corners in order: top left, top right, bottom right, bottom left.');
  }
  const [top, right, bottom, left] = corners.map((a,i) => distance(a,corners[(i+1)%4]));
  if (Math.min(top,right,bottom,left) < 25 ||
      Math.min(top,bottom)/Math.max(top,bottom) < 0.65 ||
      Math.min(left,right)/Math.max(left,right) < 0.65 ||
      ((top + bottom) / (right + left)) < 0.4 ||
      ((top + bottom) / (right + left)) > 0.9) {
    throw new Error('Use a sharper, more square-on frame with a larger target in view.');
  }
  const target = [[0,0],[10,0],[10,15],[0,15]];
  const rows = [];
  for (const [i,[x,y]] of corners.entries()) {
    const [u,v] = target[i];
    rows.push([x,y,1,0,0,0,-u*x,-u*y,u], [0,0,0,x,y,1,-v*x,-v*y,v]);
  }
  for (let i = 0; i < 8; i++) {
    let pivot = i;
    for (let k = i+1; k < 8; k++) {
      if (Math.abs(rows[k][i]) > Math.abs(rows[pivot][i])) pivot = k;
    }
    [rows[i],rows[pivot]] = [rows[pivot],rows[i]];
    const divisor = rows[i][i];
    if (Math.abs(divisor) < 1e-8) throw new Error('The scale target could not be resolved.');
    rows[i] = rows[i].map(value => value / divisor);
    for (let k = 0; k < 8; k++) {
      if (k !== i) {
        const factor = rows[k][i];
        rows[k] = rows[k].map((value,j) => value - factor * rows[i][j]);
      }
    }
  }
  const [a,b,c,d,e,f,g,h] = rows.map(row => row[8]);
  return ([x,y]) => {
    const w = g*x + h*y + 1;
    if (Math.abs(w) < 1e-8) throw new Error('The landmark lies outside the usable scale.');
    return [(a*x+b*y+c)/w,(d*x+e*y+f)/w];
  };
}

function dimensions(points, side) {
  const project = planeFromCorners(points.slice(0,4));
  const p = points.slice(4).map(project);
  const width = (a,b) => {
    if (Math.abs(a[1]-b[1]) > 1.5) throw new Error('Mark the two edges at the same height.');
    return Math.abs(a[0]-b[0]);
  };
  const ankle = width(p[0],p[1]);
  const calf = width(p[2],p[3]);
  if (!Number.isFinite(ankle + calf) || ankle < 2 || calf < 3 || calf < ankle || calf > 35 ||
      (p[0][1]+p[1][1]-p[2][1]-p[3][1])/2 < 3) {
    throw new Error('Check the ankle and calf edge marks and their heights.');
  }
  const length = side ? p[4][1]-p[5][1] : null;
  if (side && (!Number.isFinite(length) || length < 15 || length > 80 ||
      Math.abs(p[4][0]-p[5][0]) > 5 || p[4][1] < p[0][1] || p[5][1] > p[2][1])) {
    throw new Error('Mark the floor beneath the leg, then the cuff point directly above it.');
  }
  return {ankle, calf, length};
}

// Ramanujan's approximation for the perimeter of an ellipse.
function circumference(width, depth) {
  const a = width/2, b = depth/2;
  const h = ((a-b)/(a+b)) ** 2;
  return Math.PI*(a+b)*(1+3*h/(10+Math.sqrt(4-3*h)));
}

if (typeof module !== 'undefined') module.exports = {fitStocking, shoeToEU, footFit, planeFromCorners, dimensions, circumference,
  markets, defaultMarket, marketRules, arTools, allowedFields, fitRanges, fitPreviewSVG};
if (typeof document !== 'undefined') start();

function start() {
  const $ = id => document.getElementById(id);
  const preview = $('preview');
  let timeZone = '';
  try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* default market */ }
  const state = {mode:'tape', leg:'left', market:defaultMarket(timeZone, location.search),
    records:{left:{},right:{}}, sources:{left:{},right:{}}, scans:{left:[],right:[]}, views:{}};
  let stream, recorder, recordUrl, request = 0, videoKind, selectedView;
  const recordingCues = [];
  const prompts = [
    'Mark the outer TOP LEFT corner of the scale rectangle.',
    'Mark the outer TOP RIGHT corner.',
    'Mark the outer BOTTOM RIGHT corner.',
    'Mark the outer BOTTOM LEFT corner.',
    'Mark the first edge at the narrowest ankle above the ankle bone.',
    'Mark the opposite ankle edge at the same height.',
    'Mark the first edge at the widest calf.',
    'Mark the opposite calf edge at the same height.',
    'Mark the floor directly beneath the cuff point.',
    'Mark the cuff point two finger widths below the back of the knee crease.'
  ];

  // Video-mode instructions: what you need, then three stages of short steps ([title, detail]).
  const steps = {
    assisted: {
      need: 'A helper to hold the phone, two printed scale targets, sticky tape, shorts and good, even light.',
      stages: [
        ['Get ready', [
          ['Print the targets.', 'Tap Print scale target and print two copies at 100% (not “fit to page”). Check with a ruler that each rectangle is exactly 10 × 15 cm.'],
          ['Bare the leg.', 'Barefoot, in shorts, with the leg bare to above the knee. Stand straight with your weight on both feet.'],
          ['Place the targets.', 'Stick one target upright next to the calf so it faces the front, and one so it faces the side. Keep each one flat and level with the leg, not in front of it or behind it.']
        ]],
        ['Film', [
          ['Set up the phone.', 'The helper stands one big step (about 1 m) away and holds the phone at shin height. No zoom. Tap Open camera, then Start recording.'],
          ['Front, then side.', 'Film the front of the leg and hold still for 2 seconds. Walk round to the side and hold still for 2 seconds. Tap Stop recording.']
        ]],
        ['Mark the points', [
          ['Front view.', 'Slide the video to a clear front view and tap Use this front frame. Tap each point the screen asks for, starting with the four corners of the target.'],
          ['Side view.', 'Slide to a clear side view and tap Use this side frame. Tap each point asked for, including the floor and the spot just below the knee crease.'],
          ['Get your size.', 'Check the numbers, then tap Find stocking size.']
        ]]
      ]
    },
    self: {
      need: 'One printed scale target, sticky tape, something to prop the phone against, shorts and good, even light.',
      stages: [
        ['Get ready', [
          ['Print the target.', 'Tap Print scale target and print at 100% (not “fit to page”). Check with a ruler that the rectangle is exactly 10 × 15 cm.'],
          ['Prop up the phone.', 'Stand it upright at shin height, one big step (about 1 m) from where you will stand. No zoom. Mark your standing spot on the floor.'],
          ['Place the target.', 'Stick it upright next to your standing spot, level with the calf, facing the phone.']
        ]],
        ['Film', [
          ['Start recording.', 'Barefoot, leg bare to above the knee. Tap Open camera, then Start recording, and step onto your spot.'],
          ['Follow the voice.', 'Face the phone and hold still. When told, make a quarter turn on the same spot and hold still with the leg straight. Recording stops by itself.']
        ]],
        ['Mark the points', [
          ['Front view.', 'Slide the video to a clear front view and tap Use this front frame. Tap each point the screen asks for, starting with the four corners of the target.'],
          ['Side view.', 'Slide to a clear side view and tap Use this side frame. Tap each point asked for, including the floor and the spot just below the knee crease.'],
          ['Get your size.', 'Check the numbers, then tap Find stocking size.']
        ]]
      ]
    }
  };

  function status(message) {
    $('capture-status').textContent = message;
    $('capture-status').hidden = !message;
  }

  function clearCues() {
    if (!recordingCues.length) return;
    recordingCues.splice(0).forEach(clearTimeout);
    window.speechSynthesis?.cancel();
  }

  function cueSelfScan() {
    const announce = message => {
      status(message);
      if (window.speechSynthesis && window.SpeechSynthesisUtterance) {
        window.speechSynthesis.speak(new SpeechSynthesisUtterance(message));
      }
    };
    announce('Step into position and face the camera.');
    recordingCues.push(setTimeout(() => announce('Hold the front view.'), 6000));
    recordingCues.push(setTimeout(() => announce('Turn a quarter turn, then hold the side view.'), 9000));
    recordingCues.push(setTimeout(() => {
      if (recorder?.state === 'recording') recorder.stop();
    }, 18000));
  }

  function clearVideo() {
    request++;
    clearCues();
    if (recorder && recorder.state === 'recording') recorder.stop();
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    preview.pause();
    preview.srcObject = null;
    preview.removeAttribute('src');
    preview.load();
    if (recordUrl) URL.revokeObjectURL(recordUrl);
    recordUrl = null;
    videoKind = null;
    state.views = {};
    selectedView = null;
    $('annotation').hidden = true;
    $('frame-controls').hidden = true;
    $('frame-status').textContent = '';
    $('video-file').value = '';
    preview.hidden = true;
    $('record').hidden = true;
    $('camera-close').hidden = true;
    $('camera-start').hidden = false;
    $('camera-start').disabled = false;
    status('');
  }

  function loadVideo(blob, resetViews = true) {
    if (resetViews) {
      clearEstimates();
      clearVideo();
    }
    videoKind = 'clip';
    recordUrl = URL.createObjectURL(blob);
    preview.src = recordUrl;
    preview.hidden = false;
    preview.controls = true;
    $('camera-close').hidden = false;
    $('camera-start').hidden = true;
    $('record').hidden = true;
    $('frame-controls').hidden = false;
    status('Video ready. Save one front frame and one side frame.');
  }

  preview.addEventListener('error', () => {
    if (videoKind === 'clip') status('This video could not be played. Try recording here or selecting a supported MP4 or MOV clip.');
  });

  function updateRecord() {
    for (const field of fields) {
      $(field).value = state.records[state.leg][field] ?? '';
      $(field+'-source').textContent = sourceLabels[state.sources[state.leg][field]] ?? 'Tape';
    }
    $('result').hidden = true;
  }

  const sourceLabels = {tape:'Tape', guided:'Tape (AR-guided)', video:'Video estimate', scan:'LiDAR scan', ar:'AR length ruler', depth:'Face ID depth (test)'};
  const isEstimate = source => source === 'video' || source === 'scan' || source === 'ar' || source === 'depth';

  function clearEstimates(legs = [state.leg]) {
    for (const leg of legs) {
      for (const field of fields) {
        if (isEstimate(state.sources[leg][field])) {
          delete state.records[leg][field];
          delete state.sources[leg][field];
        }
      }
    }
    updateRecord();
  }

  function renderVideoSteps(guide) {
    const make = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text) node.textContent = text;
      return node;
    };
    const need = make('p', 'need');
    need.append(make('strong', '', 'You need: '), guide.need);
    const parts = [need];
    let number = 1;
    guide.stages.forEach(([title, items], index) => {
      parts.push(make('h3', 'stage', `${index + 1}. ${title}`));
      const list = make('ol', 'steps');
      list.start = number;
      for (const [action, detail] of items) {
        const item = make('li');
        item.append(make('strong', '', action + ' '), detail);
        list.append(item);
        number += 1;
      }
      parts.push(list);
    });
    $('mode-steps').replaceChildren(...parts);
  }

  function changeMode(mode) {
    if (mode === state.mode || !marketRules(state.market).modes.includes(mode)) return;
    clearEstimates();
    clearVideo();
    state.mode = mode;
    for (const button of document.querySelectorAll('[data-mode]')) {
      const active = button.dataset.mode === mode;
      button.classList.toggle('active',active);
      button.setAttribute('aria-pressed',String(active));
    }
    $('video-panel').hidden = mode !== 'assisted' && mode !== 'self';
    $('lidar-panel').hidden = mode !== 'lidar';
    $('ar-panel').hidden = mode !== 'ar';
    if (mode === 'lidar' || mode === 'ar') renderScans();
    $('video-title').textContent = mode === 'assisted' ? 'Assisted video' : 'Self-scan';
    if (mode === 'assisted' || mode === 'self') {
      renderVideoSteps(steps[mode]);
    }
    $('tape-steps').hidden = mode !== 'tape';
    $('fit-explanation').textContent = mode === 'tape'
      ? 'Select a leg and enter its measurements in centimetres.'
      : mode === 'ar'
        ? 'AR tape results appear here. You can replace any value with a tape measurement.'
        : mode === 'lidar'
          ? 'Scan results appear here once two scans of this leg agree within 1 cm. You can replace any value with a tape measurement.'
          : 'Video estimates appear here after you mark both views. You can replace any value with a tape measurement.';
  }

  // ---------- Market ----------
  function applyMarket() {
    const rules = marketRules(state.market);
    $('market').value = state.market;
    for (const button of document.querySelectorAll('[data-mode]')) {
      button.hidden = !rules.modes.includes(button.dataset.mode);
    }
    for (const button of document.querySelectorAll('[data-goto]')) {
      button.hidden = !rules.modes.includes(button.dataset.goto);
    }
    $('ar-girth-tool').hidden = !arTools(state.market).includes('girth');
    $('ar-truedepth-tool').hidden = !arTools(state.market).includes('truedepth');
    $('market-note').textContent = rules.imageGirth
      ? 'All measuring methods are available: tape, AR tape, video and LiDAR scan.'
      : 'In Australia the ankle and calf are measured with a tape: typed in, or placed with the AR tape guide in the iPhone app. The AR length ruler can measure the length.';
    $('ar-market-note').textContent = rules.imageGirth
      ? ''
      : 'In Australia the AR tools guide a real tape and measure the length. The ankle and calf readings always come from the tape.';
    if (!rules.imageGirth) {
      // Drop camera- or scan-derived girths entered under the other market.
      for (const leg of ['left','right']) {
        state.scans[leg] = [];
        for (const field of ['ankle','calf']) {
          if (isEstimate(state.sources[leg][field])) {
            delete state.records[leg][field];
            delete state.sources[leg][field];
          }
        }
      }
      updateRecord();
      renderScans();
    }
    if (!rules.modes.includes(state.mode)) {
      const previous = state.mode;
      state.mode = null;
      changeMode('tape');
      if (state.mode !== 'tape') state.mode = previous;
    }
  }
  $('market').addEventListener('change', () => {
    state.market = $('market').value === 'ie' ? 'ie' : 'au';
    applyMarket();
  });
  document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => changeMode(button.dataset.mode)));
  // Android / non-LiDAR phones: buttons in the LiDAR panel switch to the tape or video modes.
  document.querySelectorAll('[data-goto]').forEach(button => button.addEventListener('click', () => {
    changeMode(button.dataset.goto);
    document.querySelector('.modes').scrollIntoView({behavior: 'smooth', block: 'start'});
  }));
  if (/Android/i.test(navigator.userAgent)) {
    const note = document.getElementById('android-note');
    note.classList.add('is-android');
    note.querySelector('h3').textContent = 'You are on an Android phone: use tape or video instead';
  }
  $('leg').addEventListener('change', () => {
    clearVideo();
    state.leg = $('leg').value;
    updateRecord();
    renderScans();
  });
  const form = $('fit-form');
  for (const field of fields) {
    $(field).addEventListener('input', () => {
      state.records[state.leg][field] = $(field).value;
      state.sources[state.leg][field] = 'tape';
      $(field+'-source').textContent = 'Tape';
      $('result').hidden = true;
    });
  }
  for (const id of ['shoe','shoe-system']) $(id).addEventListener('input', () => { $('result').hidden = true; });
  form.addEventListener('reset', event => {
    event.preventDefault();
    state.records[state.leg] = {};
    state.sources[state.leg] = {};
    state.scans[state.leg] = [];
    clearVideo();
    updateRecord();
    renderScans();
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const result = $('result');
    const values = Object.fromEntries(fields.map(field => [field,$(field).valueAsNumber]));
    const videoFields = fields.filter(field => isEstimate(state.sources[state.leg][field]));
    const kinds = new Set(videoFields.map(field => state.sources[state.leg][field]));
    const scanned = kinds.has('scan');
    const estimateWord = scanned ? 'scan' : kinds.has('video') ? 'video' : kinds.has('depth') ? 'Face ID depth' : 'AR length';
    const fit = fitStocking(values, videoFields);
    const heading = document.createElement('h3');
    const note = document.createElement('p');
    const complete = fit.band && fit.cut && fit.length;
    if (fit.checks.length) {
      heading.textContent = 'Check ' + fit.checks.join(', ') + ' with tape';
      note.textContent = 'The ' + estimateWord + ' estimate is within the pilot’s 1 cm buffer of a size cutoff. Replace that measurement above and check again.';
    } else if (!complete) {
      heading.textContent = 'Outside the pilot size chart';
      note.textContent = 'Check the measurements before trying a size. The pilot chart has no matching combination.';
    } else {
      heading.textContent = fit.band + ' ankle · ' + fit.cut + ' calf · ' + fit.length;
      note.textContent = videoFields.length
        ? (scanned
          ? 'Experimental LiDAR estimate from two scans that agreed within 1 cm. Confirm with tape until the scan is validated.'
          : kinds.has('video')
            ? 'Experimental video estimate. Confirm with tape before using it to select a garment.'
            : kinds.has('depth')
              ? 'Face ID depth scan (test mode). Confirm the ankle and calf with a tape before using them to select a garment.'
              : 'Length from the AR length ruler, which is experimental. Confirm it with a tape until the ruler is validated.')
        : 'Matched to the provisional pilot chart. Use the actual stocking’s chart for a purchase.';
    }
    const parts = [heading, note];
    if (complete && !fit.checks.length) {
      const figure = document.createElement('figure');
      figure.className = 'fit-preview';
      figure.innerHTML = fitPreviewSVG(values, fit);
      const caption = document.createElement('figcaption');
      caption.textContent = 'Your leg, drawn to your measurements, in the recommended stocking. The shading shows the graduated compression: firmest at the ankle, easing towards the knee. The gauges show where you sit within each size.';
      figure.append(caption);
      parts.push(figure);
    }
    const shoe = footFit($('shoe').valueAsNumber, $('shoe-system').value);
    if (shoe) {
      const foot = document.createElement('p');
      foot.className = 'foot-fit';
      foot.textContent = shoe.size
        ? 'Foot: size ' + shoe.size + ' (EU ' + shoe.range + ') from shoe size EU ' + shoe.eu + ', foot about ' + shoe.footLength.toFixed(1) + ' cm long.'
        : 'Shoe size EU ' + shoe.eu + ' is outside the pilot foot sizes (EU 35–50).';
      parts.push(foot);
    }
    result.replaceChildren(...parts);
    result.hidden = false;
  });

  $('camera-start').addEventListener('click', async () => {
    clearEstimates();
    clearVideo();
    const token = request;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      status('Recording is unavailable here. Record in your camera app and select the video.');
      return;
    }
    $('camera-start').disabled = true;
    status('Opening the camera…');
    try {
      const input = await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:state.mode === 'assisted' ? 'environment' : 'user'},width:{ideal:1920},height:{ideal:1080}}});
      if (token !== request) {
        input.getTracks().forEach(track => track.stop());
        return;
      }
      stream = input;
      preview.srcObject = stream;
      preview.hidden = false;
      preview.controls = false;
      await preview.play();
      if (token !== request) return;
      $('record').textContent = 'Start recording';
      $('record').hidden = false;
      $('camera-start').hidden = true;
      $('camera-close').hidden = false;
      status('Camera ready. Include the reference and the full lower leg.');
    } catch {
      if (token !== request) return;
      clearVideo();
      status('Camera could not be started. Check permission or select a video.');
    }
  });
  $('record').addEventListener('click', () => {
    if (recorder?.state === 'recording') {
      clearCues();
      recorder.stop();
      $('record').disabled = true;
      return;
    }
    const token = request;
    const chunks = [];
    try {
      recorder = new MediaRecorder(stream);
      recorder.addEventListener('dataavailable',event => { if (event.data.size) chunks.push(event.data); });
      recorder.addEventListener('stop', () => {
        $('record').disabled = false;
        if (token !== request) return;
        const blob = new Blob(chunks,{type:recorder.mimeType});
        clearVideo();
        if (blob.size) loadVideo(blob,false);
        else status('No video was recorded. Try again.');
      });
      recorder.addEventListener('error', () => {
        if (token !== request) return;
        clearVideo();
        status('Recording stopped unexpectedly. Try recording in the camera app.');
      });
      recorder.start();
      $('record').textContent = 'Stop recording';
      if (state.mode === 'self') cueSelfScan();
      else status('Recording. Pause square-on at the front and side views.');
    } catch {
      clearVideo();
      status('Recording could not start. Record in your camera app and select the video.');
    }
  });
  $('camera-close').addEventListener('click',clearVideo);
  $('video-file').addEventListener('change', () => {
    const file = $('video-file').files[0];
    if (file) loadVideo(file);
  });
  window.addEventListener('pagehide',clearVideo);

  const canvas = $('mark-canvas');
  const ctx = canvas.getContext('2d');
  function redraw() {
    const view = state.views[selectedView];
    canvas.width = view.frame.width;
    canvas.height = view.frame.height;
    ctx.drawImage(view.frame,0,0);
    const radius = Math.max(canvas.width/130,4);
    for (const [i,[x,y]] of view.points.entries()) {
      ctx.fillStyle = i < 4 ? '#fff' : '#c9ff81';
      ctx.beginPath();
      ctx.arc(x,y,radius,0,Math.PI*2);
      ctx.fill();
      ctx.lineWidth = radius/3;
      ctx.strokeStyle = '#172d29';
      ctx.stroke();
    }
    const required = selectedView === 'front' ? 8 : 10;
    const other = selectedView === 'front' ? 'side' : 'front';
    $('annotation-prompt').textContent = view.points.length < required
      ? 'Step ' + (view.points.length + 1) + ' of ' + required + ': ' + prompts[view.points.length]
      : view.dimensions
        ? (state.views[other]?.dimensions ? 'Both views measured.' : 'This view is measured. Now save and mark the ' + other + ' view.')
        : 'Review the marked points below.';
    $('undo').disabled = !view.points.length;
    $('clear-marks').disabled = !view.points.length;
  }

  function reviewViews() {
    const view = state.views[selectedView];
    const side = selectedView === 'side';
    const count = side ? 10 : 8;
    view.dimensions = null;
    if (view.points.length === count) {
      try {
        view.dimensions = dimensions(view.points,side);
      } catch (error) {
        $('frame-status').textContent = error.message;
        redraw();
        return;
      }
    }
    const a = state.views.front?.dimensions;
    const b = state.views.side?.dimensions;
    if (a && b) {
      const estimates = {ankle:circumference(a.ankle,b.ankle),calf:circumference(a.calf,b.calf),length:b.length};
      for (const field of allowedFields(state.market, 'video')) {
        if (!state.records[state.leg][field]) {
          state.records[state.leg][field] = estimates[field].toFixed(1);
          state.sources[state.leg][field] = 'video';
        }
      }
      updateRecord();
      $('frame-status').textContent = 'Both views measured. Review the estimates in Check a stocking size.';
    } else {
      $('frame-status').textContent = view.dimensions ? 'View measured. Save and mark the other view.' : '';
    }
    redraw();
  }

  document.querySelectorAll('[data-frame]').forEach(button => button.addEventListener('click', () => {
    if (videoKind !== 'clip' || preview.seeking || preview.readyState < 2 || !preview.videoWidth) {
      status('Wait for the selected video frame to finish loading.');
      return;
    }
    preview.pause();
    const type = button.dataset.frame;
    const other = state.views[type === 'front' ? 'side' : 'front'];
    if (other && Math.abs(other.time - preview.currentTime) < 0.1) {
      status('Choose a different frame showing the leg from the other direction.');
      return;
    }
    clearEstimates();
    const frame = document.createElement('canvas');
    const scale = Math.min(1,1200/Math.max(preview.videoWidth,preview.videoHeight));
    frame.width = Math.round(preview.videoWidth*scale);
    frame.height = Math.round(preview.videoHeight*scale);
    frame.getContext('2d').drawImage(preview,0,0,frame.width,frame.height);
    selectedView = type;
    state.views[type] = {frame,time:preview.currentTime,points:[]};
    $('annotation-title').textContent = type === 'front' ? 'Mark the front view' : 'Mark the side view';
    $('annotation').hidden = false;
    $('frame-status').textContent = '';
    status(type === 'front' ? 'Front frame saved.' : 'Side frame saved.');
    redraw();
  }));

  canvas.addEventListener('click', event => {
    if (!selectedView) return;
    const view = state.views[selectedView];
    const limit = selectedView === 'front' ? 8 : 10;
    if (view.points.length >= limit) return;
    const rect = canvas.getBoundingClientRect();
    view.points.push([(event.clientX-rect.left)*canvas.width/rect.width,(event.clientY-rect.top)*canvas.height/rect.height]);
    reviewViews();
  });
  $('undo').addEventListener('click', () => {
    clearEstimates();
    state.views[selectedView].points.pop();
    reviewViews();
  });
  $('clear-marks').addEventListener('click', () => {
    clearEstimates();
    state.views[selectedView].points = [];
    reviewViews();
  });

  // ---------- LiDAR scan (iPhone app) ----------
  const app = window.webkit?.messageHandlers?.compressionFit;
  const inApp = Boolean(app && window.compressionFitApp?.lidar);
  let lastScanJson = null;
  $('lidar-start').hidden = !inApp;
  $('lidar-export').hidden = true;
  $('lidar-availability').textContent = inApp
    ? 'Use the leg selected below. Keep the other leg apart from it.'
    : 'This needs the Compression Fit iPhone app, which is in development. Scan files exported from it can be uploaded above.';

  // Scan messages go to the panel in use: the LiDAR panel, or the AR panel for the AR girth tape.
  function lidarStatus(message) {
    $(state.mode === 'ar' ? 'ar-status' : 'lidar-status').textContent = message;
  }

  function scanSvg(profile, scan) {
    const points = profile.filter(p => p.circumference !== null);
    if (points.length < 2) return '';
    const w = 300, h = 120, pad = 22;
    const hMax = Math.max(...profile.map(p => p.height));
    const cMin = Math.min(...points.map(p => p.circumference)) - 2;
    const cMax = Math.max(...points.map(p => p.circumference)) + 2;
    const x = c => pad + (c - cMin) / (cMax - cMin) * (w - 2 * pad);
    const y = height => h - pad / 2 - height / hMax * (h - pad);
    const line = points.map(p => x(p.circumference).toFixed(1) + ',' + y(p.height).toFixed(1)).join(' ');
    const marker = (c, height, label) => '<circle cx="'+x(c).toFixed(1)+'" cy="'+y(height).toFixed(1)+'" r="3.5"/>' +
      '<text x="'+(x(c)+6).toFixed(1)+'" y="'+(y(height)+4).toFixed(1)+'">'+label+'</text>';
    return '<svg class="scan-profile" viewBox="0 0 '+w+' '+h+'" role="img" aria-label="Circumference by height above the floor">' +
      '<text class="axis" x="0" y="9">height ↑</text><text class="axis" x="'+(w/2)+'" y="'+(h-1)+'" text-anchor="middle">circumference →</text>' +
      '<polyline points="'+line+'"/>' + marker(scan.ankle, scan.ankleHeight, 'ankle') + marker(scan.calf, scan.calfHeight, 'calf') +
      '<text class="axis" x="'+pad+'" y="'+(h-1)+'">'+cMin.toFixed(0)+' cm</text><text class="axis" x="'+(w-pad)+'" y="'+(h-1)+'" text-anchor="end">'+cMax.toFixed(0)+' cm</text></svg>';
  }

  function renderScans() {
    const scans = state.scans[state.leg];
    const container = $(state.mode === 'ar' ? 'ar-scans' : 'lidar-scans');
    $(state.mode === 'ar' ? 'lidar-scans' : 'ar-scans').replaceChildren();
    if (!scans.length) { container.replaceChildren(); return; }
    const rowsHtml = scans.map((scan, i) =>
      '<tr><th scope="row">Scan '+(i+1)+'</th><td>'+scan.ankle.toFixed(1)+'</td><td>'+scan.calf.toFixed(1)+'</td><td>'+(scan.belowKnee == null ? '–' : scan.belowKnee.toFixed(1))+'</td><td>'+scan.length.toFixed(1)+'</td></tr>').join('');
    const latest = scans[scans.length - 1];
    container.innerHTML = '<table class="scan-table"><thead><tr><th>'+(state.leg === 'left' ? 'Left' : 'Right')+' leg (cm)</th><th>Ankle</th><th>Calf</th><th>Below knee</th><th>Length</th></tr></thead><tbody>'+rowsHtml+'</tbody></table>' +
      '<p class="field-help">Latest scan: ankle at '+latest.ankleHeight.toFixed(1)+' cm and calf at '+latest.calfHeight.toFixed(1)+' cm above the floor. Leg tilt '+latest.tilt.toFixed(0)+'°.</p>' +
      scanSvg(latest.profile, latest);
  }

  function applyScans() {
    const scans = state.scans[state.leg];
    const latest = scans[scans.length - 1];
    const warnings = latest.warnings.length ? ' ' + latest.warnings.join(' ') : '';
    if (scans.length < 2) {
      lidarStatus('Scan 1 measured. Scan the same leg again to confirm.' + warnings);
      return;
    }
    const comparison = CompressionScan.compareScans(scans[scans.length - 2], latest);
    if (!comparison.agree) {
      const worst = Object.entries(comparison.differences).sort((a, b) => b[1] - a[1])[0];
      lidarStatus('The last two scans differ by ' + worst[1].toFixed(1) + ' cm at the ' + worst[0] + '. Scan again, more slowly and fully around the leg.' + warnings);
      return;
    }
    clearEstimates();
    for (const field of allowedFields(state.market, 'scan')) {
      if ((state.sources[state.leg][field] === 'tape' || state.sources[state.leg][field] === 'guided') && state.records[state.leg][field]) continue;
      state.records[state.leg][field] = comparison.mean[field].toFixed(1);
      state.sources[state.leg][field] = 'scan';
    }
    updateRecord();
    const knees = [scans[scans.length - 2].belowKnee, latest.belowKnee].filter(x => x != null);
    const kneeNote = knees.length ? ' Below-knee (top band) circumference: ' + (knees.reduce((a, b) => a + b, 0) / knees.length).toFixed(1) + ' cm.' : '';
    lidarStatus('The last two scans agree within 1 cm. Their average is entered in Check a stocking size.' + kneeNote + warnings);
  }

  function receiveScan(scan) {
    if (!marketRules(state.market).imageGirth) {
      lidarStatus('Scan-based ankle and calf sizing is not available in Australia. Use the AR tape guide or Measure with tape.');
      return;
    }
    try {
      if (scan.leg === 'left' || scan.leg === 'right') {
        if (scan.leg !== state.leg) {
          state.leg = scan.leg;
          $('leg').value = scan.leg;
          updateRecord();
        }
      }
      const result = CompressionScan.measureScan(scan);
      state.scans[state.leg].push(result);
      renderScans();
      applyScans();
    } catch (error) {
      lidarStatus('This scan could not be measured. ' + error.message);
    }
  }

  // Called by the iPhone app with the scan object.
  window.receiveLidarScan = scan => {
    lastScanJson = JSON.stringify(scan);
    $('lidar-export').hidden = !inApp;
    if (state.mode !== 'lidar') changeMode('lidar');
    receiveScan(scan);
  };
  window.lidarScanCancelled = message => lidarStatus(message || 'Scan cancelled.');

  $('lidar-start').addEventListener('click', () => {
    lidarStatus('Opening the LiDAR scanner…');
    app.postMessage({action:'scan', leg:state.leg});
  });
  $('lidar-export').addEventListener('click', () => {
    if (lastScanJson) app.postMessage({action:'exportScan', json:lastScanJson});
  });
  $('lidar-reset').addEventListener('click', () => {
    state.scans[state.leg] = [];
    clearEstimates();
    renderScans();
    lidarStatus('');
  });
  if (inApp) $('lidar-app').open = true;

  $('lidar-file').addEventListener('change', async () => {
    const files = Array.from($('lidar-file').files);
    $('lidar-file').value = '';
    if (!files.length) return;
    if (!marketRules(state.market).imageGirth) {
      lidarStatus('Scan uploads are not available in Australia. Use the AR tape guide or Measure with tape.');
      return;
    }
    // A Compression Fit scan file exported from the iPhone app.
    if (files.length === 1 && /\.json$/i.test(files[0].name)) {
      try {
        receiveScan(JSON.parse(await files[0].text()));
      } catch {
        lidarStatus('That file is not a Compression Fit scan.');
      }
      return;
    }
    // A 3D model from a scanning app. A tape Length is used if entered; otherwise it is found from the scan.
    const tapeLength = state.sources[state.leg].length === 'tape' ? $('length').valueAsNumber : NaN;
    const length = tapeLength >= 15 && tapeLength <= 80 ? tapeLength : NaN;
    lidarStatus('Reading ' + files.map(f => f.name).join(', ') + ' (' + (files.reduce((n, f) => n + f.size, 0) / 1e6).toFixed(1) + ' MB)…');
    await new Promise(resolve => setTimeout(resolve, 30));
    let upload;
    try {
      const buffers = await Promise.all(files.map(async f => ({name: f.name, buffer: await f.arrayBuffer()})));
      const model = await CompressionModels.readModel(buffers);
      let result, pending = false;
      try {
        result = CompressionModels.measureModel(model, length);
      } catch (error) {
        if (Number.isFinite(length)) throw error;
        // The length could not be found automatically: measure provisionally so the 3D view
        // can be shown, and ask for the cuff point to be tapped.
        result = CompressionModels.measureModel(model, 40);
        pending = error.message;
      }
      upload = {model, buffers, frame: result.frame, scanIndex: null, leg: state.leg};
      if (!pending) {
        state.scans[state.leg].push(result);
        upload.scanIndex = state.scans[state.leg].length - 1;
        renderScans();
        applyScans();
        const d = result.diagnostics;
        $('lidar-status').textContent += ' (Read ' + d.format + ' in ' + (d.units === 'mm' ? 'millimetres' : 'metres') + '. Length ' +
          (result.lengthSource === 'scan' ? 'measured automatically from the scan, shown as the red ring on the 3D leg below' : 'from your tape value') + '.)';
      } else {
        lidarStatus(pending + ' Tap the cuff point on the 3D leg below to set the length.');
      }
      upload.length = pending ? null : result.length;
    } catch (error) {
      lidarStatus('This scan could not be measured. ' + error.message);
      return;
    }
    lastUpload = upload;
    await showViewer(upload, upload.length);
  });

  // ---------- AR tape (iPhone app) ----------
  const arReady = Boolean(app && window.compressionFitApp?.ar);
  const trueDepthReady = Boolean(app && window.compressionFitApp?.truedepth);
  $('ar-availability').textContent = arReady
    ? 'Use the leg selected under Check a stocking size.'
    : 'These tools run in the Compression Fit iPhone app, which is in development, on an iPhone 12 Pro or later Pro model. On other phones, use Measure with tape.';
  const arNames = {guide:'AR tape guide', length:'AR length ruler', girth:'AR girth tape', truedepth:'Face ID depth scan'};

  function arStatus(message) {
    $('ar-status').textContent = message;
  }

  function selectLeg(leg) {
    if ((leg === 'left' || leg === 'right') && leg !== state.leg) {
      state.leg = leg;
      $('leg').value = leg;
      updateRecord();
      renderScans();
    }
  }

  document.querySelectorAll('[data-ar]').forEach(button => button.addEventListener('click', () => {
    const tool = button.dataset.ar;
    if (!arTools(state.market).includes(tool)) {
      arStatus('The ' + arNames[tool] + ' is not available in ' + marketRules(state.market).label + '.');
      return;
    }
    if (tool === 'truedepth' ? !trueDepthReady : !arReady) {
      arStatus(tool === 'truedepth'
        ? 'Open this page in the Compression Fit iPhone app on an iPhone with Face ID to use the Face ID depth scan.'
        : 'Open this page in the Compression Fit iPhone app on an iPhone 12 Pro or later Pro model to use the ' + arNames[tool] + '.');
      return;
    }
    arStatus('Opening the ' + arNames[tool] + '…');
    app.postMessage({action:'arTape', tool, leg:state.leg, market:state.market});
  }));

  const inRange = (value, low, high) => Number.isFinite(value) && value >= low && value <= high;

  // Called by the iPhone app with an AR tape result.
  window.receiveArTape = result => {
    if (!result || !arNames[result.tool]) return;
    if (state.mode !== 'ar') changeMode('ar');
    selectLeg(result.leg);
    if (result.tool === 'girth') {
      if (!marketRules(state.market).imageGirth) {
        arStatus('The AR girth tape is not available in Australia. Use the AR tape guide with a real tape.');
        return;
      }
      lastScanJson = JSON.stringify(result.scan);
      receiveScan(result.scan);
      return;
    }
    if (result.tool === 'truedepth') {
      if (!marketRules(state.market).imageGirth) {
        arStatus('The Face ID depth scan is not available in Australia. Use the AR tape guide with a real tape.');
        return;
      }
      let measured;
      try {
        measured = measureTrueDepth(result.captures || []);
      } catch (error) {
        arStatus('The depth captures could not be measured. ' + error.message);
        return;
      }
      if (!measured.plausible || !inRange(measured.ankle, 10, 65) || !inRange(measured.calf, 15, 100) || measured.calf <= measured.ankle) {
        arStatus('The two captures did not agree well enough (ankle ' + measured.ankle + ' cm, calf ' + measured.calf + ' cm). Retake both from the same height and distance, or measure with a tape.');
        return;
      }
      const record = state.records[state.leg], sources = state.sources[state.leg];
      for (const field of ['ankle', 'calf']) {
        if (sources[field] === 'tape' || sources[field] === 'guided') continue;
        record[field] = measured[field].toFixed(1);
        sources[field] = 'depth';
      }
      updateRecord();
      arStatus('Face ID depth scan (test): ankle ' + measured.ankle.toFixed(1) + ' cm, calf ' + measured.calf.toFixed(1) +
        ' cm, entered in Check a stocking size unless you had typed a tape value. Measure the length with a tape. Confirm with a tape until this mode is validated.');
      return;
    }
    const length = Number(result.length);
    if (!inRange(length, 15, 80)) {
      arStatus('The AR length was outside 15–80 cm. Measure the length again or use a tape.');
      return;
    }
    const record = state.records[state.leg], sources = state.sources[state.leg];
    if (result.tool === 'guide') {
      const ankle = Number(result.ankle), calf = Number(result.calf);
      if (!inRange(ankle, 10, 65) || !inRange(calf, 15, 100) || calf <= ankle) {
        arStatus('The tape readings could not be used. Check them and enter them under Check a stocking size.');
        return;
      }
      record.ankle = ankle.toFixed(1); sources.ankle = 'guided';
      record.calf = calf.toFixed(1); sources.calf = 'guided';
    }
    record.length = length.toFixed(1); sources.length = 'ar';
    updateRecord();
    arStatus(result.tool === 'guide'
      ? 'Tape placement checked at the ankle and calf. The tape readings and the AR length are entered in Check a stocking size.'
      : 'Length ' + length.toFixed(1) + ' cm from the AR length ruler is entered in Check a stocking size. Measure the ankle and calf with a tape.');
  };
  window.arTapeCancelled = message => arStatus(message || 'Cancelled.');

  // ---------- 3D viewer: tap the cuff point to set floor-to-cuff length ----------
  let lastUpload = null;
  let pickedLength = null;
  let manualLength = false; // tapping is a fallback, used only when the automatic length fails or on request

  async function viewerReady() {
    if (window.CompressionViewer) return true;
    await new Promise(resolve => {
      window.addEventListener('compression-viewer-ready', resolve, {once: true});
      setTimeout(resolve, 5000);
    });
    return Boolean(window.CompressionViewer);
  }

  async function showViewer(upload, length) {
    pickedLength = null;
    manualLength = !length;
    $('use-length').hidden = true;
    $('manual-length').hidden = manualLength;
    $('viewer-help').textContent = manualLength
      ? 'The length could not be found automatically. Turn to the back of the knee and tap two finger widths below the crease. Drag to turn, pinch or scroll to zoom.'
      : 'The red ring is the cuff level found automatically from the scan, and the faint rings mark every 10 cm. Drag to turn the leg, pinch or scroll to zoom.';
    $('pick-readout').textContent = length ? 'Length ' + length.toFixed(1) + ' cm, measured automatically.' : 'Tap the cuff point.';
    if (!(await viewerReady())) {
      $('pick-readout').textContent = '';
      lidarStatus($('lidar-status').textContent + ' The 3D view could not load; enter the Length by tape if needed.');
      return;
    }
    $('viewer-wrap').hidden = false;
    try {
      window.compressionViewer = await CompressionViewer.show($('scan-viewer'), upload.buffers, upload.model, upload.frame, {
        length,
        canPick: () => manualLength,
        onPick(height) {
          pickedLength = Math.round(height * 10) / 10;
          $('pick-readout').textContent = 'Cuff point ' + pickedLength.toFixed(1) + ' cm above the floor.';
          $('use-length').hidden = false;
        }
      });
    } catch (error) {
      $('viewer-wrap').hidden = true;
      lidarStatus($('lidar-status').textContent + ' The 3D view could not be shown (' + error.message + ').');
    }
  }

  $('manual-length').addEventListener('click', () => {
    manualLength = true;
    $('manual-length').hidden = true;
    $('viewer-help').textContent = 'Turn to the back of the knee and tap two finger widths below the crease, then tap Use this length.';
    $('pick-readout').textContent = 'Tap the cuff point.';
  });

  $('use-length').addEventListener('click', () => {
    const upload = lastUpload;
    if (!upload || pickedLength === null) return;
    if (!(pickedLength >= 15 && pickedLength <= 80)) {
      $('pick-readout').textContent = 'That point is ' + pickedLength.toFixed(1) + ' cm up. Tap two finger widths below the knee crease.';
      return;
    }
    try {
      const result = CompressionModels.measureModel(upload.model, pickedLength);
      result.lengthSource = 'tapped cuff point';
      const scans = state.scans[upload.leg];
      if (upload.scanIndex === null) {
        scans.push(result);
        upload.scanIndex = scans.length - 1;
      } else {
        scans[upload.scanIndex] = result;
      }
      if (state.leg !== upload.leg) { state.leg = upload.leg; $('leg').value = upload.leg; }
      // The length now comes from the tapped cuff point.
      state.records[state.leg].length = pickedLength.toFixed(1);
      state.sources[state.leg].length = 'scan';
      updateRecord();
      renderScans();
      applyScans();
      upload.length = pickedLength;
      $('use-length').hidden = true;
      $('pick-readout').textContent = 'Length set to ' + pickedLength.toFixed(1) + ' cm from the tapped cuff point.';
      window.compressionViewer?.setMarkerHeight(pickedLength);
    } catch (error) {
      lidarStatus('This scan could not be measured with that length. ' + error.message);
    }
  });

  applyMarket();

  const rows = chart.map(row => '<tr><th scope="row">'+row.band+'</th><td>'+row.ankle.join('–')+'</td>'+
    row.cuts.map(([,low,high]) => '<td>'+low+'–'+high+'</td>').join('')+'</tr>');
  $('chart').innerHTML = '<table><thead><tr><th>Ankle band</th><th>Ankle</th><th>Standard</th><th>Wide</th><th>Extra wide</th></tr></thead><tbody>'+
    rows.join('')+'</tbody></table><p>Lengths (cm): short 30–&lt;37, regular 37–&lt;43, long 43–&lt;50. Each upper bound belongs to the next band where one exists.</p>'+
    '<p>Foot sizes by shoe size (EU): '+footSizes.map(([size,low,high]) => size+' '+low+'–'+(high-1)).join(', ')+'.</p>';
  for (const offset of [0,25]) {
    const strip = document.createElement('div');
    strip.className = 'ruler-strip';
    for (let mm = 0; mm <= 250; mm++) {
      const tick = document.createElement('span');
      tick.className = 'ruler-mark';
      tick.style.left = mm+'mm';
      if (mm%10 === 0) {
        tick.classList.add('ruler-major');
        const number = document.createElement('span');
        number.textContent = offset+mm/10;
        tick.append(number);
      }
      strip.append(tick);
    }
    $('ruler-strips').append(strip);
  }
  document.querySelectorAll('[data-print]').forEach(button => button.addEventListener('click', () => {
    document.body.classList.remove('print-tape','print-target');
    document.body.classList.add('print-'+button.dataset.print);
    window.print();
  }));
}
