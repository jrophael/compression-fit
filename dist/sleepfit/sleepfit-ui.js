(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const P = window.Posture;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const fmt = (v, d = 1) => { const x = Math.abs(v) < 0.5 * Math.pow(10, -d) ? 0 : v; return (x > 0 ? '+' : '') + x.toFixed(d); };

  let records = [], demoMode = false, mode = 'baseline';
  const sections = ['prepare', 'capture', 'compare', 'profile'];

  function show(id) {
    sections.forEach(s => $(s).classList.toggle('hidden', s !== id));
    const step = id === 'prepare' ? 0 : id === 'capture' ? (mode === 'baseline' ? 1 : 2) : id === 'compare' ? 2 : 3;
    [...$('steps').children].forEach((x, i) => x.classList.toggle('active', i === step));
    $(id).scrollIntoView({behavior: 'smooth', block: 'start'});
  }
  const adjustable = () => $('pillowType').value === 'adjustable';

  // ---------- Prepare ----------
  $('begin').onclick = () => show('prepare');
  $('pillowType').onchange = () => { $('layersWrap').classList.toggle('hidden', !adjustable()); };
  $('comfort').oninput = () => { $('comfortout').textContent = $('comfort').value + ' / 10'; };
  $('trialComfort').oninput = () => { $('trialOut').textContent = $('trialComfort').value + ' / 10'; };
  $('baseline').onclick = () => {
    const missing = [...document.querySelectorAll('.checklist input[required]')].filter(x => !x.checked).length;
    if (missing) { $('prepareError').textContent = 'Please tick the ' + missing + ' remaining item' + (missing > 1 ? 's' : '') + ' in the checklist first.'; return; }
    $('prepareError').textContent = '';
    demoMode = false; records = []; mode = 'baseline';
    startCapture(Number($('layers').value), $('setup').value);
  };

  // ---------- Capture and marking ----------
  const canvas = $('canvas'), ctx = canvas.getContext('2d');
  const MARKS = [
    {key: 'occiput', text: 'Back of the head (middle of the skull)'},
    {key: 'c7', text: 'Base of the neck (bony bump where neck meets shoulders)'},
    {key: 'waist', text: 'Spine at the narrowest part of the waist'},
    {key: 'sacrum', text: 'Spine at the pelvis (between the two dimples)'},
    {key: 'mattressA', text: 'Top of the mattress near the head'},
    {key: 'mattressB', text: 'Top of the mattress near the hips'},
    {key: 'refA', text: 'One end of the A4 sheet', optional: true},
    {key: 'refB', text: 'Other end of the A4 sheet', optional: true}
  ];
  let image = null, points = [], skipA4 = false, cross = null, drag = -1;

  const needed = () => (skipA4 || !$('useA4').checked ? 6 : 8);

  function startCapture(layers, note) {
    image = null; points = []; skipA4 = false; cross = null;
    $('photo').value = ''; $('quality').value = 'uncertain';
    $('layersNow').value = String(layers);
    $('layersNowWrap').classList.toggle('hidden', !adjustable());
    $('change').value = note || '';
    $('trialComfort').value = mode === 'baseline' ? $('comfort').value : 5;
    $('trialOut').textContent = $('trialComfort').value + ' / 10';
    $('fileStatus').textContent = 'No photograph selected.';
    $('captureTitle').textContent = mode === 'baseline' ? 'Baseline photo' : 'Photo of your next setup';
    $('captureError').textContent = '';
    $('depthBox').classList.toggle('hidden', !(window.compressionFitApp && window.compressionFitApp.posture));
    draw(); show('capture');
  }

  function draw() {
    ctx.fillStyle = '#e4efec'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (image) ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    else { ctx.fillStyle = '#486c69'; ctx.font = '24px system-ui'; ctx.fillText('Choose a photo to begin', 30, 60); }
    const r = Math.max(7, canvas.width / 110);
    ctx.lineWidth = Math.max(3, canvas.width / 300);
    const spine = points.slice(0, 4);
    if (spine.length > 1) { ctx.strokeStyle = '#f5b962'; ctx.beginPath(); spine.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.stroke(); }
    if (points.length >= 6) { ctx.strokeStyle = '#5eeeff'; ctx.beginPath(); ctx.moveTo(...points[4]); ctx.lineTo(...points[5]); ctx.stroke(); }
    if (points.length >= 8) { ctx.strokeStyle = '#ffffff'; ctx.beginPath(); ctx.moveTo(...points[6]); ctx.lineTo(...points[7]); ctx.stroke(); }
    points.forEach((p, i) => {
      ctx.fillStyle = i < 4 ? '#f5b962' : i < 6 ? '#5eeeff' : '#ffffff';
      ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, 2 * Math.PI); ctx.fill();
      ctx.fillStyle = '#173a40'; ctx.font = `bold ${Math.round(r * 1.3)}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), p[0], p[1]);
    });
    if (image && cross && document.activeElement === canvas) {
      ctx.strokeStyle = '#f4a84b'; ctx.lineWidth = 2; ctx.beginPath();
      ctx.moveTo(cross[0] - 3 * r, cross[1]); ctx.lineTo(cross[0] + 3 * r, cross[1]);
      ctx.moveTo(cross[0], cross[1] - 3 * r); ctx.lineTo(cross[0], cross[1] + 3 * r); ctx.stroke();
    }
    ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
    updateStatus();
  }

  function updateStatus() {
    const n = needed();
    $('marks').replaceChildren(...MARKS.slice(0, $('useA4').checked ? 8 : 6).map((m, i) => {
      const li = document.createElement('li');
      li.textContent = m.text;
      if (m.optional) li.classList.add('opt');
      if (i < points.length) li.classList.add('done'); else if (i === points.length && i < n) li.classList.add('next');
      return li;
    }));
    $('markStatus').textContent = !image ? 'Waiting for photo' : points.length < n ? 'Mark point ' + (points.length + 1) + ' of ' + n + ': ' + MARKS[points.length].text : 'All points marked. Drag any point to fine-tune.';
    $('skipA4').classList.toggle('hidden', !(image && $('useA4').checked && !skipA4 && points.length === 6));
    const ready = image && points.length === n;
    const good = $('quality').value === 'good';
    $('record').disabled = !(ready && good);
    $('recordHint').textContent = !image ? '' : !ready ? 'Mark all the points to record this setup.'
      : !good ? 'Check the photo, then set “Photo check” to “Points clear, camera level, usual position” to record. If it is hard to see, retake the photo.' : '';
  }

  $('photo').onchange = () => {
    const f = $('photo').files[0];
    if (!f) return;
    const url = URL.createObjectURL(f), im = new Image();
    im.onload = () => {
      canvas.width = Math.min(1400, im.naturalWidth);
      canvas.height = Math.round(canvas.width * im.naturalHeight / im.naturalWidth);
      image = im; points = []; skipA4 = false; cross = [canvas.width / 2, canvas.height / 2];
      $('fileStatus').textContent = im.naturalWidth < 640 ? 'Low resolution: consider retaking.' : 'Photo loaded on this device.';
      draw(); URL.revokeObjectURL(url);
    };
    im.onerror = () => { URL.revokeObjectURL(url); $('fileStatus').textContent = 'Unable to read that image. Try a JPEG or PNG.'; };
    im.src = url;
  };

  const toCanvas = e => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * canvas.width / r.width, (e.clientY - r.top) * canvas.height / r.height]; };
  canvas.addEventListener('pointerdown', e => {
    if (!image) return;
    const p = toCanvas(e);
    const grab = 28 * canvas.width / canvas.getBoundingClientRect().width;
    const hit = points.findIndex(q => Math.hypot(q[0] - p[0], q[1] - p[1]) < grab);
    if (hit >= 0) drag = hit;
    else if (points.length < needed()) { points.push(p); drag = points.length - 1; }
    else return;
    canvas.setPointerCapture(e.pointerId); $('captureError').textContent = ''; draw();
  });
  canvas.addEventListener('pointermove', e => { if (drag < 0) return; points[drag] = toCanvas(e); draw(); });
  const endDrag = () => { drag = -1; };
  canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('focus', draw); canvas.addEventListener('blur', draw);
  canvas.addEventListener('keydown', e => {
    if (!image) return;
    const step = (e.shiftKey ? 20 : 4) * canvas.width / canvas.getBoundingClientRect().width;
    const mv = {ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step]}[e.key];
    if (mv) { cross = [Math.max(0, Math.min(canvas.width, cross[0] + mv[0])), Math.max(0, Math.min(canvas.height, cross[1] + mv[1]))]; e.preventDefault(); draw(); }
    else if ((e.key === 'Enter' || e.key === ' ') && points.length < needed()) { points.push([...cross]); e.preventDefault(); draw(); }
    else if (e.key === 'Backspace') { points.pop(); e.preventDefault(); draw(); }
  });
  $('undo').onclick = () => { points.pop(); draw(); };
  $('clear').onclick = () => { points = []; skipA4 = false; draw(); };
  $('skipA4').onclick = () => { skipA4 = true; draw(); };
  $('quality').onchange = updateStatus;
  $('back').onclick = () => show(records.length ? 'compare' : 'prepare');

  function landmarks() {
    const L = {};
    MARKS.forEach((m, i) => { if (points[i]) L[m.key] = points[i]; });
    if (points.length === 8) L.refCm = 29.7; else { delete L.refA; delete L.refB; }
    return L;
  }

  function addRecord(r, extra) {
    const layers = adjustable() ? Number($('layersNow').value) : null;
    const rec = Object.assign({
      label: $('change').value.trim() || (mode === 'baseline' ? 'Baseline' : 'Setup ' + (records.length + 1)),
      layers, comfort: Number($('trialComfort').value), quality: $('quality').value
    }, r, extra);
    rec.advice = layers === null ? null : P.pillowAdvice(rec, layers);
    records.push(rec);
    compare();
  }

  $('record').onclick = () => {
    let r;
    try { r = P.analyseLandmarks(landmarks()); } catch (e) { $('captureError').textContent = e.message; return; }
    const problems = P.plausibility(r);
    if (problems.length) { $('captureError').textContent = problems.join(' '); return; }
    addRecord(r, {source: 'photo'});
  };

  // ---------- iPhone 3D scan ----------
  $('depthScan').onclick = () => window.webkit.messageHandlers.compressionFit.postMessage({action: 'postureScan'});
  window.receivePostureScan = data => {
    try {
      const r = P.analyseDepth(data.points, {camera: data.camera, headSide: data.headSide || 'left'});
      const problems = P.plausibility(r);
      if (problems.length) { $('captureError').textContent = problems.join(' '); return; }
      $('quality').value = 'good';
      addRecord(r, {source: '3D scan'});
    } catch (e) { $('captureError').textContent = 'The 3D scan could not be measured: ' + e.message; }
  };

  // ---------- Compare ----------
  function diagramSVG(r) {
    const W = 640, H = 230, pad = 40, pts = r.points;
    const line = r.profile ? r.profile.filter(p => p.s >= pts.occiput[0] - 2 && p.s <= pts.sacrum[0] + 2).map(p => [p.s, p.spine]) : [pts.occiput, pts.c7, pts.waist, pts.sacrum];
    const ss = line.map(p => p[0]).concat([pts.occiput[0], pts.sacrum[0]]);
    const s0 = Math.min(...ss) - 5, s1 = Math.max(...ss) + 5, sx = (W - 2 * pad) / (s1 - s0), sy = sx * 2;
    const hs = line.map(p => p[1]).concat([pts.occiput[1], pts.c7[1], pts.sacrum[1]]);
    const hMid = (Math.max(...hs) + Math.min(...hs)) / 2;
    const X = s => pad + (s - s0) * sx, Y = h => 90 - (h - hMid) * sy;
    const t = [pts.sacrum[0] - pts.c7[0], pts.sacrum[1] - pts.c7[1]];
    const ref = s => pts.c7[1] + t[1] * (s - pts.c7[0]) / t[0];
    const path = line.map((p, i) => (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1)).join(' ');
    const dot = (p, label, dy) => `<circle cx="${X(p[0]).toFixed(1)}" cy="${Y(p[1]).toFixed(1)}" r="5" fill="#f5b962"/><text x="${X(p[0]).toFixed(1)}" y="${(Y(p[1]) + dy).toFixed(1)}" fill="#e8f4f1" font-size="13" text-anchor="middle">${label}</text>`;
    return `<figure class="diagram"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Your spine line compared with a straight line">
      <rect x="0" y="${H - 34}" width="${W}" height="34" fill="#1c3442"/><text x="${W - 10}" y="${H - 12}" fill="#7fa4b6" font-size="12" text-anchor="end">mattress</text>
      <line x1="${X(pts.occiput[0])}" y1="${Y(ref(pts.occiput[0]))}" x2="${X(pts.sacrum[0])}" y2="${Y(ref(pts.sacrum[0]))}" stroke="#fff" stroke-opacity=".55" stroke-dasharray="6 6" stroke-width="2"/>
      <path d="${path}" fill="none" stroke="#f5b962" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${X(pts.occiput[0])}" cy="${Y(pts.occiput[1])}" r="${Math.max(14, 9 * sx)}" fill="#f5b962" fill-opacity=".15" stroke="#f5b962"/>
      ${dot(pts.occiput, 'Head', -22)}${dot(pts.c7, 'Neck', -14)}${dot(pts.waist, 'Waist', 22)}${dot(pts.sacrum, 'Pelvis', -14)}</svg>
      <figcaption>Orange: your latest setup. Dashed: a straight line from the base of your neck to your pelvis. Height differences are drawn twice their real size.</figcaption></figure>`;
  }

  function table(best) {
    const anyLayers = records.some(r => r.layers !== null);
    const head = ['Setup'].concat(anyLayers ? ['Layers'] : [], ['Head and neck', 'Waist', 'Hips vs shoulders', 'Comfort']);
    const rows = records.map(r => {
      const waist = r.units === 'cm' ? fmt(r.waistCm) + ' cm' : fmt(r.waistPct) + '%';
      const cells = [esc(r.label) + (r === best && records.length > 1 ? '<span class="tag">best so far</span>' : '') + (r.quality !== 'good' ? '<span class="tag warn">check photo</span>' : '')]
        .concat(anyLayers ? [r.layers === null ? '–' : String(r.layers)] : [],
          [fmt(r.headAngle) + '°<span class="cell-note">' + P.headLabel(r.headAngle) + '</span>', waist, fmt(r.tilt) + '°', r.comfort + '/10']);
      return '<tr' + (r === best && records.length > 1 ? ' class="best"' : '') + '>' + cells.map((c, i) => '<td' + (i ? ' class="num"' : '') + '>' + c + '</td>').join('') + '</tr>';
    });
    return '<div class="table-wrap"><table><thead><tr>' + head.map(h => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>' +
      '<p class="hint">Head and neck: minus means the head drops towards the mattress (pillow too low), plus means it is pushed up (pillow too high). Waist: minus dips towards the mattress. Hips vs shoulders: plus means the hips sit lower.</p>';
  }

  function adviceBlock(r) {
    const findings = P.interpret(r);
    const pillow = r.advice ? r.advice.text : findings[0].text;
    const change = r.advice ? r.advice.action !== 'keep' : findings[0].level === 'change';
    const mattress = findings.slice(1).filter(f => f.level === 'change').map(f => '<li>' + esc(f.text) + '</li>').join('');
    return `<div class="advice ${change ? 'change' : ''}"><strong>Next step for your pillow</strong><div class="big">${esc(pillow)}</div>
      ${mattress ? '<p>Also noticed:</p><ul>' + mattress + '</ul>' : '<p class="sub">Shoulders, waist and hips look reasonably level.</p>'}</div>`;
  }

  function compare() {
    const latest = records[records.length - 1], first = records[0], best = P.bestSetup(records);
    let html = demoMode ? '<p class="warning">Simulated example: not a real measurement.</p>' : '';
    html += adviceBlock(latest) + diagramSVG(latest) + table(best);
    if (records.length > 1) {
      html += `<div class="metrics"><div class="metric"><small>Head angle, baseline → latest</small><strong>${fmt(first.headAngle)}° → ${fmt(latest.headAngle)}°</strong><small>closer to 0 is straighter</small></div>
        <div class="metric"><small>Comfort change</small><strong>${fmt(latest.comfort - first.comfort, 0)}</strong><small>points out of 10</small></div>
        <div class="metric"><small>Best so far</small><strong>${esc(best.label)}</strong><small>comfort first, then alignment</small></div></div>`;
    }
    $('comparison').innerHTML = html;
    show('compare');
  }

  function nextSetup() {
    if (demoMode) { demoNext(); return; }
    const latest = records[records.length - 1];
    mode = 'trial';
    const next = latest && latest.advice ? latest.advice.layers : (latest ? latest.layers : 0);
    startCapture(next === null ? 0 : next, latest && latest.advice && latest.advice.change ? (latest.advice.change > 0 ? 'Added ' : 'Removed ') + Math.abs(latest.advice.change) + ' layer' + (Math.abs(latest.advice.change) > 1 ? 's' : '') : '');
  }
  $('another').onclick = nextSetup;
  $('another2').onclick = nextSetup;

  // ---------- Profile ----------
  function profile() {
    const best = P.bestSetup(records);
    let html = demoMode ? '<p class="warning">Simulated example only.</p>' : '';
    html += '<p>Sleeping side: ' + esc($('side').value) + (adjustable() ? ' · Pillow: SleepFit adjustable' : ' · Pillow: own pillow') + '</p>';
    if (best) {
      html += `<div class="advice"><strong>Your best setup so far</strong><div class="big">${esc(best.label)}${best.layers !== null ? ' · ' + best.layers + ' layer' + (best.layers === 1 ? '' : 's') : ''}</div>
        <p>Head and neck ${fmt(best.headAngle)}° (${P.headLabel(best.headAngle)}), comfort ${best.comfort}/10. Sleep on it for a few nights before deciding.</p></div>`;
    }
    html += table(best) + '<p class="note">Preference is personal. Compare setups over several nights. These measurements are unvalidated and cannot support a medical recommendation.</p>';
    $('profileContent').innerHTML = html;
    show('profile');
  }
  $('report').onclick = profile;
  $('toCompare').onclick = () => { if (records.length) compare(); };
  $('print').onclick = () => window.print();
  $('restart').onclick = () => { records = []; demoMode = false; mode = 'baseline'; show('prepare'); };

  // Numbers are written as numbers; only free text is guarded against spreadsheet formulas.
  const csvCell = v => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (typeof v !== 'number' && !/^-?\d+(\.\d+)?$/.test(s)) s = s.replace(/^[=+@\-\t\r]/, "'$&");
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  $('download').onclick = () => {
    const head = ['type', 'setup', 'source', 'layers', 'head_neck_angle_deg', 'head_label', 'waist_percent', 'waist_cm', 'hips_vs_shoulders_deg', 'suggested_pillow_change_cm', 'comfort_0_10', 'photo_check', 'advice'];
    const rows = records.map(r => [demoMode ? 'simulated' : 'experimental', r.label, r.source, r.layers, r.headAngle.toFixed(2), P.headLabel(r.headAngle), r.waistPct.toFixed(2),
      r.units === 'cm' ? r.waistCm.toFixed(2) : '', r.tilt.toFixed(2), r.units === 'cm' ? r.pillowChangeCm.toFixed(2) : '', r.comfort, r.quality, r.advice ? r.advice.text : ''].map(csvCell).join(','));
    const url = URL.createObjectURL(new Blob([head.join(',') + '\n' + rows.join('\n')], {type: 'text/csv'}));
    const a = document.createElement('a'); a.href = url; a.download = 'sleepfit-profile.csv'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  };

  // ---------- Demo: a simulated person measured by the real engine ----------
  const LAYER_DEG = Math.asin(1.5 / 20) * 180 / Math.PI; // one 1.5 cm layer over a 20 cm neck lever
  let demoState = null;
  function demoRecord(label, layers, headDrop, comfort) {
    const scan = P.syntheticScan({headDropDeg: headDrop, waistSagCm: 0.6, hipSinkCm: 1, noiseMm: 2, seed: 4242 + records.length});
    const r = P.analyseDepth(scan.points, scan);
    const rec = Object.assign({label, layers, comfort, quality: 'good', source: 'simulated'}, r);
    rec.advice = P.pillowAdvice(rec, layers);
    records.push(rec);
  }
  function demoNext() {
    const latest = records[records.length - 1];
    const layers = latest.advice.layers;
    demoState.drop -= (layers - latest.layers) * LAYER_DEG;
    const comfort = Math.max(3, Math.min(9, 8 - Math.round(Math.abs(demoState.drop) / 3)));
    demoRecord((latest.advice.change > 0 ? 'Added ' : latest.advice.change < 0 ? 'Removed ' : 'Kept ') + (latest.advice.change ? Math.abs(latest.advice.change) + ' layer' + (Math.abs(latest.advice.change) > 1 ? 's' : '') : 'the same') + ' (simulated)', layers, demoState.drop, comfort);
    compare();
  }
  $('demo').onclick = () => {
    demoMode = true; records = []; mode = 'trial';
    $('pillowType').value = 'adjustable'; $('layersWrap').classList.remove('hidden');
    demoState = {drop: 9};
    demoRecord('Original setup, 1 layer (simulated)', 1, demoState.drop, 5);
    compare();
  };
})();
