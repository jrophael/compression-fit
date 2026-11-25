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
    $('pose').value = $('side').value==='Back'?'back':'side';
    $('pose').disabled = $('side').value!=='Combination';
    startCapture(Number($('layers').value), $('setup').value);
  };

  // ---------- Capture and marking ----------
  const canvas = $('canvas'), ctx = canvas.getContext('2d');
  const SIDE_MARKS = [
    {key: 'occiput', text: 'Back of the head (middle of the skull)'},
    {key: 'c7', text: 'Base of the neck (bony bump where neck meets shoulders)'},
    {key: 'waist', text: 'Spine at the narrowest part of the waist'},
    {key: 'sacrum', text: 'Spine at the pelvis (between the two dimples)'},
    {key: 'mattressA', text: 'Top of the mattress near the head'},
    {key: 'mattressB', text: 'Top of the mattress near the hips'},
    {key: 'refA', text: 'One end of the A4 sheet', optional: true},
    {key: 'refB', text: 'Other end of the A4 sheet', optional: true}
  ];
  const BACK_MARKS = [
    {key:'ear',text:'Centre of the visible ear canal (tragus)'},
    {key:'eye',text:'Outer corner of the visible eye'},
    {key:'shoulder',text:'Centre of the visible shoulder'},
    {key:'hip',text:'Side of the hip'},
    ...SIDE_MARKS.slice(4)
  ];
  const pose = () => $('pose').value;
  const marks = () => pose()==='back' ? BACK_MARKS : SIDE_MARKS;
  const positionLabel = r => r.pose==='back'?'Back':'Side';
  const samePosition = r => records.filter(x => x.pose===r.pose);
  const label = r => r.pose==='back' ? ('ear–eye orientation: approx. '+(Math.round(r.headAngle/5)*5)+'°') : (r.headAngle>5?'head appears raised':r.headAngle< -5?'head appears lowered':'no large tilt seen');
  let image = null, points = [], skipA4 = false, cross = null, drag = -1;

  const needed = () => (pose() === 'back' || skipA4 || !$('useA4').checked ? 6 : 8);

  function startCapture(layers, note) {
    image = null; points = []; skipA4 = false; cross = null;
    $('loaded').value = ''; $('backFeel').value='neutral'; $('backFeelWrap').classList.toggle('hidden',pose()!=='back');
    $('captureGuide').textContent = pose()==='back'?'Lie face up, photograph directly from the side with your face in profile. Show the ear, eye, shoulder, hip and bed edge.':'Lie on your usual side, photograph straight from behind. Show the back of your head, neck, waist, hips and mattress edge.';
    $('captureHelp').textContent = 'Keep the phone level and perpendicular. Choose or take the photo, then mark the numbered points. Drag to correct them.';
    $('photo').value = ''; $('quality').value = 'uncertain';
    $('layersNow').value = String(layers);
    $('layersNowWrap').classList.toggle('hidden', !adjustable());
    $('change').value = note || '';
    $('trialComfort').value = mode === 'baseline' ? $('comfort').value : 5;
    $('trialOut').textContent = $('trialComfort').value + ' / 10';
    $('fileStatus').textContent = 'No photograph selected.';
    $('captureTitle').textContent = mode === 'baseline' ? 'Baseline photo' : 'Photo of your next setup';
    $('captureError').textContent = '';
    $('depthBox').classList.toggle('hidden', !(pose()==='side' && window.compressionFitApp && window.compressionFitApp.posture));
    draw(); show('capture');
  }

  $('pose').onchange = () => startCapture(Number($('layersNow').value),$('change').value);
  function draw() {
    ctx.fillStyle = '#e4efec'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (image) ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    else { ctx.fillStyle = '#486c69'; ctx.font = '24px system-ui'; ctx.fillText('Choose a photo to begin', 30, 60); }
    const r = Math.max(7, canvas.width / 110);
    ctx.lineWidth = Math.max(3, canvas.width / 300);
    const spine = points.slice(0, pose()==='back'?2:4);
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
    $('marks').replaceChildren(...marks().slice(0, pose() !== 'back' && $('useA4').checked ? 8 : 6).map((m, i) => {
      const li = document.createElement('li');
      li.textContent = m.text;
      if (m.optional) li.classList.add('opt');
      if (i < points.length) li.classList.add('done'); else if (i === points.length && i < n) li.classList.add('next');
      return li;
    }));
    $('markStatus').textContent = !image ? 'Waiting for photo' : points.length < n ? 'Mark point ' + (points.length + 1) + ' of ' + n + ': ' + marks()[points.length].text : 'All points marked. Drag any point to fine-tune.';
    $('skipA4').classList.toggle('hidden', !(image && pose() !== 'back' && $('useA4').checked && !skipA4 && points.length === 6));
    const ready = image && points.length === n;
    let issues=[];
    if(ready){
      if(image.naturalWidth<640 || image.naturalHeight<400) issues.push('Photo resolution is low.');
      if(points.some(p=>p[0]<0||p[1]<0||p[0]>canvas.width||p[1]>canvas.height)) issues.push('A marker is outside the photo.');
      if(Math.hypot(points[5][0]-points[4][0],points[5][1]-points[4][1])<canvas.width*.25) issues.push('Separate mattress marks across the image.');
      if(needed()===8 && Math.hypot(points[7][0]-points[6][0],points[7][1]-points[6][1])<canvas.width*.08) issues.push('Calibration marks are too close.');
    }
    const good = $('quality').value === 'good' && !issues.length;
    $('record').disabled = !(ready && good);
    $('recordHint').textContent = !image ? '' : !ready ? 'Mark all the points to record this setup.'
      : issues.length ? issues.join(' ') : !good ? 'Check the photo, then set “Photo check” to “Points clear, camera level, usual position” to record. If it is hard to see, retake the photo.' : '';
  }

  $('photo').onchange = () => {
    const f = $('photo').files[0];
    if (!f) return;
    image=null; points=[]; $('quality').value='uncertain'; draw();
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
    // Small grab zone while points remain to be placed, so close landmarks (ear and eye) can both be placed.
    const grab = (points.length < needed() ? 10 : 28) * canvas.width / canvas.getBoundingClientRect().width;
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
    marks().forEach((m, i) => { if (points[i]) L[m.key] = points[i]; });
    if (points.length === 8) L.refCm = 29.7; else { delete L.refA; delete L.refB; }
    return L;
  }

  function addRecord(r, extra) {
    const layers = adjustable() ? Number($('layersNow').value) : null;
    if($('loaded').value!==''&&!$('loaded').checkValidity()){ $('captureError').textContent='Enter a loaded height between 0 and 30 cm, or leave blank.';return;}
    const rec = Object.assign({pose:pose(), feel: $('backFeel').value, loaded:$('loaded').value===''?null:Number($('loaded').value),
      label: $('change').value.trim() || (mode === 'baseline' ? 'Baseline' : 'Setup ' + (records.length + 1)),
      layers, comfort: Number($('trialComfort').value), quality: $('quality').value
    }, r, extra);
    rec.advice = P.fitAdvice(rec, layers);
    records.push(rec);
    compare();
  }

  $('record').onclick = () => {
    let r;
    try { r = pose()==='back'?P.analyseBack(landmarks()):P.analyseLandmarks(landmarks()); } catch (e) { $('captureError').textContent = e.message; return; }
    const problems = pose()==='back'?[]:P.plausibility(r);
    if (problems.length) { $('captureError').textContent = problems.join(' '); return; }
    addRecord(r, {source: 'photo', thumbnail: canvas.toDataURL('image/jpeg',0.65)});
  };

  // ---------- iPhone 3D scan ----------
  $('depthScan').onclick = () => window.webkit.messageHandlers.compressionFit.postMessage({action: 'postureScan'});
  window.receivePostureScan = data => {
    if(pose()!=='side') return;
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
    return `<figure class="diagram"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Visible landmark line compared with a reference">
      <rect x="0" y="${H - 34}" width="${W}" height="34" fill="#1c3442"/><text x="${W - 10}" y="${H - 12}" fill="#7fa4b6" font-size="12" text-anchor="end">mattress</text>
      <line x1="${X(pts.occiput[0])}" y1="${Y(ref(pts.occiput[0]))}" x2="${X(pts.sacrum[0])}" y2="${Y(ref(pts.sacrum[0]))}" stroke="#fff" stroke-opacity=".55" stroke-dasharray="6 6" stroke-width="2"/>
      <path d="${path}" fill="none" stroke="#f5b962" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${X(pts.occiput[0])}" cy="${Y(pts.occiput[1])}" r="${Math.max(14, 9 * sx)}" fill="#f5b962" fill-opacity=".15" stroke="#f5b962"/>
      ${dot(pts.occiput, 'Head', -22)}${dot(pts.c7, 'Neck', -14)}${dot(pts.waist, 'Waist', 22)}${dot(pts.sacrum, 'Pelvis', -14)}</svg>
      <figcaption>Orange: estimated external landmarks. Dashed: a geometric comparison guide, not an anatomical target. Vertical differences are exaggerated.</figcaption></figure>`;
  }

  function table(best) {
    return '<div class="table-wrap"><table><thead><tr><th>Setup</th><th>Position</th><th>Layers</th><th>Visible orientation</th><th>Loaded height</th><th>Comfort</th></tr></thead><tbody>'+
      records.map(r=>'<tr'+(r===best?' class="best"':'')+'><td>'+esc(r.label)+'</td><td>'+positionLabel(r)+'</td><td>'+(r.layers??'—')+'</td><td>'+label(r)+'</td><td>'+(Number.isFinite(r.loaded)?r.loaded+' cm':'—')+'</td><td>'+r.comfort+'/10</td></tr>').join('')+
      '</tbody></table></div><p class="hint">Orientation descriptions are provisional visual cues, not a health or alignment score.</p>';
  }
  function photoCompare(r) {
    const group=samePosition(r), first=group[0];
    const figure=(x,title)=>x.thumbnail?'<figure><img class="comparePhoto" src="'+x.thumbnail+'" alt="'+title+' marked photograph"><figcaption>'+title+': '+esc(x.label)+'</figcaption></figure>':'';
    return '<div class="grid">'+figure(first,'Baseline')+(group.length>1?figure(r,'Latest'):'')+'</div>';
  }
  function bestFor(group) {return group.reduce((b,r)=>!b||r.comfort>b.comfort?r:b,null);}
  function compare() {
    const latest=records[records.length-1], group=samePosition(latest), best=bestFor(group);
    let html=demoMode?'<p class="warning">Simulated example: not a real measurement.</p>':'';
    html+='<div class="advice"><strong>Try next · '+positionLabel(latest)+'</strong><div class="big">'+esc(latest.advice.text)+'</div><p>Change only one thing at a time. Do not force an angle; stop if uncomfortable.</p></div>';
    html+=photoCompare(latest)+(latest.pose==='side'&&!latest.thumbnail?diagramSVG(latest):'')+table(best);
    if(group.length>1) html+='<p>Comfort change in this position: '+fmt(latest.comfort-group[0].comfort,0)+' / 10.</p>';
    if($('side').value==='Combination') html+='<p class="note">Test the same layer settings in both positions. Choose a comfortable compromise, not an average of the geometry.</p>';
    $('comparison').innerHTML=html; show('compare');
  }

  function nextSetup() {
    if(!records.length){show('prepare');return;}
    if (demoMode) { demoNext(); return; }
    const latest = records[records.length - 1];
    mode = 'trial';
    const combo=$('side').value==='Combination';
    if(combo && !records.some(r=>r.pose!==latest.pose&&r.layers===latest.layers&&r.label===latest.label)){
      $('pose').value=latest.pose==='back'?'side':'back';
      startCapture(latest.layers??0,latest.label); return;
    }
    let src = latest, note = '';
    if (combo) {
      const lastOf = pos => [...records].reverse().find(r => r.pose === pos);
      const side = lastOf('side'), back = lastOf('back');
      const sDir = side ? Math.sign(side.advice.change) : 0, bDir = back ? Math.sign(back.advice.change) : 0;
      if (sDir && bDir && sDir !== bDir) { src = null; note = 'Positions disagree: same layers, judge by comfort'; }
      else src = sDir ? side : (bDir ? back : latest);
      $('pose').value = 'side';
    }
    const next = src && src.advice ? src.advice.layers : latest.layers;
    const ch = src && src.advice ? src.advice.change : 0;
    startCapture(next === null ? 0 : next, note || (ch ? (ch > 0 ? 'Added ' : 'Removed ') + Math.abs(ch) + ' layer' + (Math.abs(ch) > 1 ? 's' : '') : ''));
  }
  $('another').onclick = nextSetup;
  $('another2').onclick = nextSetup;

  // ---------- Profile ----------
  function profile() {
    let html=demoMode?'<p class="warning">Simulated example only.</p>':'';
    html+='<p>Usual position: '+esc($('side').value)+' · Mattress: '+esc($('mattress').value)+'</p>';
    for(const pos of ['side','back']){
      const best=bestFor(records.filter(r=>r.pose===pos));
      if(best)html+='<div class="advice"><strong>'+positionLabel(best)+' comfort leader</strong><div class="big">'+esc(best.label)+(best.layers!==null?' · '+best.layers+' layers':'')+'</div><p>'+best.comfort+'/10 immediate comfort. Try over several nights.</p></div>';
    }
    if($('side').value==='Combination'){
      const paired=records.filter(r=>r.pose==='side'&&r.layers!==null).map(s=>({s,b:bestFor(records.filter(r=>r.pose==='back'&&r.layers===s.layers&&r.label===s.label))})).filter(x=>x.b);
      paired.sort((a,b)=>Math.min(b.s.comfort,b.b.comfort)-Math.min(a.s.comfort,a.b.comfort));
      html+='<p class="note">'+(paired.length?'Best paired comfort so far: '+paired[0].s.layers+' layers.':'Record both positions at the same layer setting before choosing a compromise.')+'</p>';
    }
    $('profileContent').innerHTML=records.length?html+table(null):'<p>Open a new fitting to compare pillows, or continue your diary below.</p>';
    renderDiary(); show('profile');
  }
  const diaryKey='sleepfit-v03-diary';
  function renderDiary(){
    const panel=$('diary');
    if(demoMode){panel.textContent='Seven-night diary is available after a real fitting.';return;}
    let data={};try{data=JSON.parse(localStorage.getItem(diaryKey)||'{}')||{};}catch{}
    panel.innerHTML='<h3>Seven-night comfort diary</h3><p>Track the setup you actually slept on. Saved on this device only; no photos stored.</p>'+
      '<div class="table-wrap"><table><thead><tr><th>Night</th><th>Setup / layers</th><th>Morning comfort (0–10)</th></tr></thead><tbody>'+
      Array.from({length:7},(_,i)=>'<tr><td>'+(i+1)+'</td><td><input aria-label="Night '+(i+1)+' setup" data-night="'+i+'" data-kind="setup" type="text" value="'+esc(data[i]?.setup||'')+'"></td><td><select aria-label="Night '+(i+1)+' comfort" data-night="'+i+'" data-kind="comfort"><option value="">Not recorded</option>'+Array.from({length:11},(_,n)=>'<option '+(String(data[i]?.comfort)===String(n)?'selected':'')+'>'+n+'</option>').join('')+'</select></td></tr>').join('')+
      '</tbody></table></div><p id="diaryStatus" role="status"></p><button class="secondary" id="clearDiary">Clear diary</button>';
    panel.querySelectorAll('[data-night]').forEach(el=>el.onchange=()=>{const i=el.dataset.night;data[i]??={};data[i][el.dataset.kind]=el.value;try{localStorage.setItem(diaryKey,JSON.stringify(data));$('diaryStatus').textContent='Saved on this device.';}catch{$('diaryStatus').textContent='Storage unavailable; diary will not persist.';}});
    $('clearDiary').onclick=()=>{if(confirm('Clear your seven-night diary?')){try{localStorage.removeItem(diaryKey);}catch{} renderDiary();}};
  }
  $('report').onclick = profile;
  $('openDiary').onclick=()=>{if(demoMode){records=[];demoMode=false;} profile();};
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
    const head = ['position','loaded_height_cm','type', 'setup', 'source', 'layers', 'approx_visible_orientation_deg', 'head_label', 'waist_percent', 'waist_cm', 'hips_vs_shoulders_deg', 'reserved', 'comfort_0_10', 'photo_check', 'advice'];
    const rows = records.map(r => [positionLabel(r),r.loaded,demoMode ? 'simulated' : 'experimental', r.label, r.source, r.layers, Math.round(r.headAngle), label(r), r.pose==='back'?'':Math.round(r.waistPct),
      r.units === 'cm' ? Math.round(r.waistCm) : '', r.pose==='back'?'':Math.round(r.tilt), '', r.comfort, r.quality, r.advice ? r.advice.text : ''].map(csvCell).join(','));
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
    rec.pose='side'; rec.advice = P.fitAdvice(rec, layers);
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
    $('side').value='Left side'; $('pose').value='side';
    $('pillowType').value = 'adjustable'; $('layersWrap').classList.remove('hidden');
    demoState = {drop: 9};
    demoRecord('Original setup, 1 layer (simulated)', 1, demoState.drop, 5);
    compare();
  };
})();

