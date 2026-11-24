(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const P = window.Posture;
  let current = null;
  const saved = [];

  // ---------- Mode switching ----------
  const panels = {photo: $('panel-photo'), depth: $('panel-depth'), demo: $('panel-demo')};
  document.querySelectorAll('.mode').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.mode').forEach(b => { b.classList.toggle('active', b === btn); b.setAttribute('aria-selected', b === btn); });
    for (const [k, el] of Object.entries(panels)) el.hidden = k !== btn.dataset.mode;
  }));

  // ---------- Results ----------
  const fmt = (v, d = 1) => (v > 0 ? '+' : '') + v.toFixed(d);
  function diagramSVG(r) {
    const W = 640, H = 260, pad = 40;
    const pts = r.points;
    const line = r.profile ? r.profile.filter(p => p.s >= pts.occiput[0] - 2 && p.s <= pts.sacrum[0] + 2).map(p => [p.s, p.spine]) : [pts.occiput, pts.c7, pts.waist, pts.sacrum];
    const ss = line.map(p => p[0]).concat([pts.occiput[0], pts.sacrum[0]]);
    const s0 = Math.min(...ss) - 5, s1 = Math.max(...ss) + 5;
    const sx = (W - 2 * pad) / (s1 - s0);
    const sy = sx * 2; // vertical exaggeration
    const hs = line.map(p => p[1]).concat([pts.occiput[1], pts.c7[1], pts.sacrum[1]]);
    const hMid = (Math.max(...hs) + Math.min(...hs)) / 2;
    const X = s => pad + (s - s0) * sx;
    const Y = h => 95 - (h - hMid) * sy;
    const t = [pts.sacrum[0] - pts.c7[0], pts.sacrum[1] - pts.c7[1]];
    const ref = s => pts.c7[1] + t[1] * (s - pts.c7[0]) / t[0];
    const path = line.map((p, i) => (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1)).join(' ');
    const dot = (p, label, dy) => `<circle cx="${X(p[0]).toFixed(1)}" cy="${Y(p[1]).toFixed(1)}" r="5" fill="#5eeeff"/><text x="${X(p[0]).toFixed(1)}" y="${(Y(p[1]) + dy).toFixed(1)}" fill="#cfefff" font-size="13" text-anchor="middle">${label}</text>`;
    const mattressY = Math.max(190, Math.min(H - 12, Y(0)));
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Your spine line compared with a straight line">
      <rect x="0" y="${mattressY}" width="${W}" height="${H - mattressY}" fill="#1c3442"/>
      <text x="${W - 10}" y="${H - 6}" fill="#7fa4b6" font-size="12" text-anchor="end">mattress</text>
      <line x1="${X(pts.occiput[0])}" y1="${Y(ref(pts.occiput[0]))}" x2="${X(pts.sacrum[0])}" y2="${Y(ref(pts.sacrum[0]))}" stroke="#ffffff" stroke-opacity=".55" stroke-dasharray="6 6" stroke-width="2"/>
      <path d="${path}" fill="none" stroke="#5eeeff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${X(pts.occiput[0])}" cy="${Y(pts.occiput[1])}" r="${Math.max(14, 9 * sx)}" fill="#5eeeff" fill-opacity=".18" stroke="#5eeeff"/>
      ${dot(pts.occiput, 'Head', -22)}${dot(pts.c7, 'Neck', -14)}${dot(pts.waist, 'Waist', 22)}${dot(pts.sacrum, 'Sacrum', -14)}
    </svg>
    <figcaption>Blue: your spine. Dashed: a straight line from the base of your neck to your sacrum. Height differences are drawn twice their real size.</figcaption>`;
  }

  function show(r) {
    current = r;
    $('results').hidden = false;
    $('diagram').innerHTML = diagramSVG(r);
    const findings = P.interpret(r);
    $('findings').replaceChildren(...findings.map(f => {
      const div = document.createElement('div');
      div.className = 'finding ' + f.level;
      const strong = document.createElement('strong'); strong.textContent = f.area;
      const p = document.createElement('span'); p.textContent = f.text;
      div.append(strong, p);
      return div;
    }));
    const rows = [
      ['Head and neck angle (+ up, − down)', fmt(r.headAngle) + '°'],
      ['Waist above (+) or below (−) the shoulder–hip line', r.units === 'cm' ? fmt(r.waistCm) + ' cm' : fmt(r.waistPct) + '%'],
      ['Hips lower (+) or higher (−) than shoulders', fmt(r.tilt) + '°']
    ];
    if (r.units === 'cm') rows.push(['Suggested pillow change', fmt(r.pillowChangeCm) + ' cm']);
    $('measures').replaceChildren(...rows.map(([a, b]) => {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td'); td1.textContent = a;
      const td2 = document.createElement('td'); td2.textContent = b;
      tr.append(td1, td2);
      return tr;
    }));
    $('results').scrollIntoView({behavior: 'smooth', block: 'start'});
  }

  $('save-scan').addEventListener('click', () => {
    if (!current) return;
    saved.push(current);
    $('history').hidden = false;
    const head = ['Scan', 'Head', 'Waist', 'Tilt'];
    const tr = (cells, tag = 'td') => { const r = document.createElement('tr'); cells.forEach(c => { const el = document.createElement(tag); el.textContent = c; r.append(el); }); return r; };
    $('history-table').replaceChildren(tr(head, 'th'), ...saved.map((r, i) => tr([
      `${i + 1} (${r.source === 'photo' ? 'photo' : '3D'})`, fmt(r.headAngle) + '°',
      r.units === 'cm' ? fmt(r.waistCm) + ' cm' : fmt(r.waistPct) + '%', fmt(r.tilt) + '°'])));
  });

  // ---------- Photo mode ----------
  const steps = [
    {key: 'occiput', text: '1. Tap the middle of the back of the head.'},
    {key: 'c7', text: '2. Tap the base of the neck: the bony bump where the neck meets the shoulders.'},
    {key: 'waist', text: '3. Tap the spine at the narrowest part of the waist.'},
    {key: 'sacrum', text: '4. Tap the spine between the two dimples just above the buttocks.'},
    {key: 'mattressA', text: '5. Tap the top of the mattress near the head.'},
    {key: 'mattressB', text: '6. Tap the top of the mattress near the hips.'},
    {key: 'refA', text: '7. Tap one end of the A4 sheet (long side).', optional: true},
    {key: 'refB', text: '8. Tap the other end of the A4 sheet.', optional: true}
  ];
  const canvas = $('photo-canvas'), ctx = canvas.getContext('2d');
  let img = null, taps = [];

  function draw() {
    if (!img) return;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const r = Math.max(6, canvas.width / 120);
    ctx.lineWidth = Math.max(2, canvas.width / 400);
    const spine = taps.slice(0, 4);
    if (spine.length > 1) {
      ctx.strokeStyle = '#5eeeff'; ctx.beginPath();
      spine.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.stroke();
    }
    if (taps.length >= 6) {
      ctx.strokeStyle = '#ffb347'; ctx.beginPath(); ctx.moveTo(...taps[4]); ctx.lineTo(...taps[5]); ctx.stroke();
    }
    taps.forEach((p, i) => {
      ctx.fillStyle = i < 4 ? '#5eeeff' : (i < 6 ? '#ffb347' : '#ffffff');
      ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, 2 * Math.PI); ctx.fill();
      ctx.fillStyle = '#0d1b24'; ctx.font = `bold ${Math.round(r * 1.4)}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), p[0], p[1]);
    });
  }

  function prompt() {
    const step = steps[taps.length];
    $('tap-prompt').textContent = step ? step.text : 'All points placed.';
    $('tap-skip').hidden = !(step && step.optional);
  }

  function finishPhoto(useScale) {
    const L = {};
    steps.forEach((s, i) => { if (taps[i]) L[s.key] = taps[i]; });
    if (useScale) L.refCm = 29.7; else { delete L.refA; delete L.refB; }
    try { show(P.analyseLandmarks(L)); } catch (e) { $('tap-prompt').textContent = e.message; }
  }

  $('photo-input').addEventListener('change', e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const im = new Image();
    im.onload = () => {
      img = im;
      const k = Math.min(1, 1400 / im.naturalWidth);
      canvas.width = Math.round(im.naturalWidth * k); canvas.height = Math.round(im.naturalHeight * k);
      taps = []; $('tapper').hidden = false; prompt(); draw();
    };
    im.src = URL.createObjectURL(file);
  });

  canvas.addEventListener('click', e => {
    if (!img || taps.length >= steps.length) return;
    const rect = canvas.getBoundingClientRect();
    taps.push([(e.clientX - rect.left) * canvas.width / rect.width, (e.clientY - rect.top) * canvas.height / rect.height]);
    draw(); prompt();
    if (taps.length === steps.length) finishPhoto(true);
  });
  $('tap-undo').addEventListener('click', () => { taps.pop(); draw(); prompt(); });
  $('tap-reset').addEventListener('click', () => { taps = []; draw(); prompt(); });
  $('tap-skip').addEventListener('click', () => { if (taps.length === 6) finishPhoto(false); });

  // ---------- 3D scan (iPhone app) ----------
  const app = window.compressionFitApp;
  if (app && app.posture) {
    $('depth-status').textContent = 'Ready. Lie down, let someone hold the phone behind you, then start.';
    $('depth-start').hidden = false;
    $('depth-start').addEventListener('click', () => window.webkit.messageHandlers.compressionFit.postMessage({action: 'postureScan'}));
  } else {
    $('depth-status').textContent = 'This needs the Compression Fit iPhone app with a LiDAR or Face ID camera. Until then, try the photo or the demo.';
  }
  window.receivePostureScan = data => {
    try { show(P.analyseDepth(data.points, {camera: data.camera, headSide: data.headSide || 'left'})); }
    catch (e) { $('depth-status').textContent = 'Scan could not be measured: ' + e.message; }
  };

  // ---------- Demo ----------
  const sliders = [['demo-head', '°'], ['demo-waist', ' cm'], ['demo-hip', ' cm']];
  const sync = () => sliders.forEach(([id, unit]) => { $(id + '-out').textContent = $(id).value + unit; });
  sliders.forEach(([id]) => $(id).addEventListener('input', sync)); sync();
  $('demo-run').addEventListener('click', () => {
    const scan = P.syntheticScan({headDropDeg: +$('demo-head').value, waistSagCm: +$('demo-waist').value,
      hipSinkCm: +$('demo-hip').value, noiseMm: 3, seed: 1 + Math.floor(Math.random() * 1e6)});
    show(P.analyseDepth(scan.points, scan));
  });
})();
