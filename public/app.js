'use strict';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const extOf = (p) => { const b = baseOf(p), i = b.lastIndexOf('.'); return i < 0 ? '' : b.slice(i + 1).toLowerCase(); };
const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1);
const dirOf = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
const stemOf = (p) => { const b = baseOf(p), i = b.lastIndexOf('.'); return (i < 0 ? b : b.slice(0, i)).toLowerCase(); };

const TEX_EXT = new Set(['ozj', 'ozt', 'jpg', 'jpeg', 'tga', 'png', 'ozp', 'bmp', 'ozb']);
const CLIENT_EXT = { jpg: 'ozj', jpeg: 'ozj', tga: 'ozt', bmp: 'ozb', png: 'ozp' };

let files = [];
let bmds = [];                 // rutas de .bmd
let byStem = new Map();        // nombre sin extensión -> rutas de imágenes
let shown = [];                // índices de bmds visibles en la lista
let selected = -1;
let viewer;
let loadToken = 0;
const anim = { action: 0, frame: 0, playing: true, fps: 10, last: 0, model: null, lastPosed: -1 };

// ---------- Datos ----------

async function fetchBytes(rel) {
  const r = await fetch('/api/file?p=' + encodeURIComponent(rel));
  if (!r.ok) throw new Error('No se pudo leer ' + rel);
  return r.arrayBuffer();
}

const texCache = new Map(); // ruta -> Promise<textura>
function loadTexture(rel) {
  if (texCache.has(rel)) {
    const p = texCache.get(rel);
    texCache.delete(rel); texCache.set(rel, p);
    return p;
  }
  const p = fetchBytes(rel).then(b => MU.decodeTexture(b, extOf(rel)));
  texCache.set(rel, p);
  p.catch(() => texCache.delete(rel));
  while (texCache.size > 80) texCache.delete(texCache.keys().next().value);
  return p;
}

// Busca la imagen que usa una parte del modelo, igual que el cliente (misma carpeta,
// .jpg -> .OZJ, .tga -> .OZT). Si no está ahí, busca en el resto del pack.
function resolveTexture(texName, modelDir) {
  const clean = texName.replace(/\\/g, '/');
  const stem = stemOf(clean), ext = extOf(clean);
  const want = CLIENT_EXT[ext] || ext;
  const cands = byStem.get(stem) || [];
  if (!clean) return { path: null, level: 'bad', note: 'La parte no tiene textura asignada' };
  if (!cands.length) return { path: null, level: 'bad', note: `Falta ${stem}.${want.toUpperCase()} (no está en ningún lado del pack)` };
  const mdSeg = modelDir.split('/');
  const score = (p) => {
    const seg = dirOf(p).split('/');
    let common = 0;
    while (common < seg.length && common < mdSeg.length && seg[common].toLowerCase() === mdSeg[common].toLowerCase()) common++;
    return (dirOf(p).toLowerCase() === modelDir.toLowerCase() ? 1000 : 0) + common * 10 + (extOf(p) === want ? 5 : 0);
  };
  const best = cands.slice().sort((a, b) => score(b) - score(a))[0];
  const sameDir = dirOf(best).toLowerCase() === modelDir.toLowerCase();
  const sameExt = extOf(best) === want;
  if (sameDir && sameExt) return { path: best, level: 'ok', note: baseOf(best) };
  const why = [];
  if (!sameExt) why.push(`el cliente busca .${want.toUpperCase()} y hay .${extOf(best).toUpperCase()}`);
  if (!sameDir) why.push(`está en otra carpeta: ${dirOf(best) || '(raíz)'}`);
  return { path: best, level: 'warn', note: `${baseOf(best)} · ${why.join(' · ')}` };
}

// ---------- Lista ----------

function renderList() {
  const words = $('#q').value.toLowerCase().split(/\s+/).filter(Boolean);
  shown = [];
  let html = '', lastDir = null;
  for (let i = 0; i < bmds.length; i++) {
    const p = bmds[i], low = p.toLowerCase();
    if (!words.every(w => low.includes(w))) continue;
    const d = dirOf(p);
    if (d !== lastDir) { html += `<div class="folder">${esc(d || '(raíz)')}</div>`; lastDir = d; }
    html += `<div class="item${i === selected ? ' sel' : ''}" data-i="${i}" title="${esc(p)}">${esc(baseOf(p))}</div>`;
    shown.push(i);
  }
  $('#list').innerHTML = html || '<div class="item">Nada coincide</div>';
  $('#count').textContent = `${shown.length} de ${bmds.length} modelos`;
}

function select(i, scroll) {
  selected = i;
  document.querySelectorAll('.item.sel').forEach(e => e.classList.remove('sel'));
  const el = document.querySelector(`.item[data-i="${i}"]`);
  if (el) { el.classList.add('sel'); if (scroll) el.scrollIntoView({ block: 'nearest' }); }
  openModel(bmds[i]);
}

// ---------- Modelo ----------

function setMsg(text, err) {
  const m = $('#msg');
  m.textContent = text || '';
  m.classList.toggle('err', !!err);
}

let currentPath = null;
let modalPath = null;

async function reveal(rel) {
  if (!rel) return;
  const r = await fetch('/api/reveal?p=' + encodeURIComponent(rel), { method: 'POST' });
  if (!r.ok) setMsg(r.status === 501 ? 'Abrir la carpeta solo funciona en Windows' : 'No se pudo abrir la carpeta', true);
}

async function openModel(rel) {
  const tok = ++loadToken;
  currentPath = rel;
  $('#reveal').disabled = false;
  setMsg('Cargando…');
  $('#title').textContent = baseOf(rel);
  $('#sub').textContent = dirOf(rel);
  let model, size = 0;
  try {
    const buf = await fetchBytes(rel);
    size = buf.byteLength;
    model = MU.parseBMD(buf);
  } catch (e) {
    if (tok !== loadToken) return;
    viewer.clear();
    anim.model = null;
    setMsg('No se pudo abrir el modelo:\n' + e.message, true);
    $('#warn').innerHTML = `<li class="bad">${esc(e.message)}</li>`;
    $('#meshes').innerHTML = '';
    fillActions(null);
    showFolderImages(dirOf(rel));
    return;
  }
  if (tok !== loadToken) return;

  const { badIndex } = viewer.setModel(model);
  anim.model = model;
  anim.action = 0; anim.frame = 0; anim.lastPosed = -1;
  fillActions(model);
  const box = viewer.pose(MU.boneMatrices(model, 0, 0));
  viewer.frameBox(box);
  setMsg(model.meshes.length ? '' : 'El modelo no tiene partes visibles');

  const tris = model.meshes.reduce((s, m) => s + m.tris.length, 0);
  $('#sub').textContent = `${dirOf(rel)} · ${model.meshes.length} partes · ${tris} triángulos · ${model.bones.length} huesos · ${(size / 1024).toFixed(0)} KB`;

  const resolved = model.meshes.map(m => resolveTexture(m.texName, dirOf(rel)));
  // En el MU las texturas terminadas en _R se dibujan con brillo (el negro se vuelve transparente).
  model.meshes.forEach((m, i) => { viewer.parts[i].autoAdd = stemOf(m.texName.replace(/\\/g, '/')).endsWith('_r'); });
  const warns = [];
  warns.push({ level: 'ok', text: `BMD versión ${model.version} (${model.version === 12 ? 'encriptado' : 'sin encriptar'}): el cliente lo abre` });
  if (/^[\x20-\x7e]+$/.test(model.name)) warns.push({ level: 'ok', text: `Nombre interno: ${model.name}` });
  if (badIndex) warns.push({ level: 'bad', text: 'Tiene índices de vértices fuera de rango (modelo dañado)' });
  if (model.trailing > 0) warns.push({ level: 'ok', text: `Sobran ${model.trailing} bytes al final (el cliente los ignora)` });
  const missing = resolved.filter(r => !r.path).length;
  const elsewhere = resolved.filter(r => r.level === 'warn').length;
  if (missing) warns.push({ level: 'bad', text: `${missing} textura(s) no se encuentran: se ven a cuadros rosas` });
  if (elsewhere) warns.push({ level: 'warn', text: `${elsewhere} textura(s) no están donde el cliente las busca (misma carpeta, .OZJ/.OZT)` });
  if (!missing && !elsewhere) warns.push({ level: 'ok', text: 'Todas las texturas están en la carpeta del modelo' });
  renderWarns(warns);
  renderMeshes(model, resolved);
  showFolderImages(dirOf(rel));

  resolved.forEach((r, i) => {
    if (!r.path) { viewer.setTexture(i, null); setThumb(i, null); return; }
    loadTexture(r.path).then(tex => {
      if (tok !== loadToken) return;
      viewer.setTexture(i, tex);
      setThumb(i, tex, r.path);
      if (tex.warns.length) {
        const n = document.querySelector(`.mesh[data-i="${i}"] .mnote`);
        n.textContent += ' · ' + tex.warns.join(' · ');
        n.className = 'mnote ' + (tex.warns.some(w => w.includes('no carga') || w.includes('no la va')) ? 'bad' : 'warn');
        for (const w of tex.warns) warns.push({ level: w.includes('no carga') || w.includes('no la va') ? 'bad' : 'warn', text: `${baseOf(r.path)}: ${w}` });
        renderWarns(warns);
      }
    }).catch(e => {
      if (tok !== loadToken) return;
      viewer.setTexture(i, null);
      const n = document.querySelector(`.mesh[data-i="${i}"] .mnote`);
      n.textContent = `${baseOf(r.path)}: no se pudo leer (${e.message})`;
      n.className = 'mnote bad';
    });
  });
}

function renderWarns(list) {
  $('#warn').innerHTML = list.map(w => `<li class="${w.level}">${esc(w.text)}</li>`).join('');
}

function renderMeshes(model, resolved) {
  $('#meshes').innerHTML = model.meshes.map((m, i) => `
    <div class="mesh" data-i="${i}">
      <input type="checkbox" checked title="Mostrar / ocultar">
      <canvas class="thumb" width="56" height="56"></canvas>
      <div>
        <div class="mname">${i + 1}. ${esc(m.texName || '(sin nombre)')}</div>
        <div class="mnote ${resolved[i].level}">${esc(resolved[i].note)}</div>
        <select title="Cómo se dibuja"><option value="auto">Normal</option><option value="aditivo">Brillo (aditivo)</option><option value="alpha">Transparente</option><option value="opaco">Opaco</option></select>
      </div>
    </div>`).join('');
  document.querySelectorAll('.mesh').forEach(el => {
    const i = +el.dataset.i;
    el.querySelector('input').onchange = (e) => { viewer.parts[i].visible = e.target.checked; viewer.dirty = true; };
    el.querySelector('select').onchange = (e) => { viewer.parts[i].blend = e.target.value; viewer.dirty = true; };
  });
}

function drawThumb(canvas, tex) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const s = Math.min(canvas.width / tex.w, canvas.height / tex.h);
  const w = tex.w * s, h = tex.h * s;
  ctx.drawImage(tex.canvas, 0, 0, tex.w, tex.h, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
}

function setThumb(i, tex, path) {
  const c = document.querySelector(`.mesh[data-i="${i}"] .thumb`);
  if (!c) return;
  if (!tex) {
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#e63cc8'; ctx.font = 'bold 26px system-ui'; ctx.textAlign = 'center'; ctx.fillText('?', 28, 37);
    return;
  }
  drawThumb(c, tex);
  c.onclick = () => openModal(path, tex);
}

function showFolderImages(dir) {
  const imgs = files.filter(f => dirOf(f) === dir && TEX_EXT.has(extOf(f)));
  const box = $('#folderTex');
  if (!imgs.length) { box.innerHTML = '<div class="ft">No hay imágenes en esta carpeta</div>'; return; }
  box.innerHTML = imgs.map(f => `<div class="ft" data-p="${esc(f)}"><canvas class="thumb" width="64" height="64"></canvas>${esc(baseOf(f))}</div>`).join('');
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      io.unobserve(en.target);
      const p = en.target.dataset.p, c = en.target.querySelector('canvas');
      loadTexture(p).then(tex => { drawThumb(c, tex); c.onclick = () => openModal(p, tex); })
        .catch(() => { c.title = 'No se pudo leer'; });
    }
  }, { root: $('#panel') });
  box.querySelectorAll('.ft').forEach(el => io.observe(el));
}

function openModal(path, tex) {
  const c = $('#mcanvas');
  c.width = tex.w; c.height = tex.h;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.drawImage(tex.canvas, 0, 0, tex.w, tex.h, 0, 0, tex.w, tex.h);
  $('#mtitle').textContent = path;
  modalPath = path;
  $('#minfo').textContent = `${tex.w}×${tex.h}${tex.hasAlpha ? ' · con transparencia' : ''}${tex.warns.length ? ' · ' + tex.warns.join(' · ') : ''}`;
  $('#modal').hidden = false;
}

// ---------- Animación ----------

function fillActions(model) {
  const sel = $('#act');
  if (!model || !model.actions.length) {
    sel.innerHTML = '<option>Sin animaciones</option>';
    sel.disabled = true;
    $('#frame').max = 0; $('#frameLbl').textContent = '0/0';
    return;
  }
  sel.disabled = false;
  sel.innerHTML = model.actions.map((a, i) => `<option value="${i}">${i} (${a.keys} frames)</option>`).join('');
  sel.value = '0';
  $('#frame').max = Math.max(0, model.actions[0].keys - 1);
}

function tick(now) {
  const dt = anim.last ? (now - anim.last) / 1000 : 0;
  anim.last = now;
  const m = anim.model;
  if (m && m.actions[anim.action]) {
    const keys = m.actions[anim.action].keys;
    if (anim.playing && keys > 1) anim.frame = (anim.frame + dt * anim.fps) % keys;
    if (anim.frame !== anim.lastPosed) {
      viewer.pose(MU.boneMatrices(m, anim.action, anim.frame));
      anim.lastPosed = anim.frame;
      $('#frame').value = Math.floor(anim.frame);
      $('#frameLbl').textContent = `${Math.floor(anim.frame) + 1}/${keys}`;
    }
  }
  if (viewer.dirty) viewer.draw();
  requestAnimationFrame(tick);
}

// ---------- Inicio ----------

async function init() {
  try {
    viewer = new Viewer($('#gl'));
  } catch (e) {
    setMsg(e.message, true);
    return;
  }
  const r = await fetch('/api/index');
  const j = await r.json();
  files = j.files;
  $('#root').textContent = j.root;
  bmds = files.filter(f => extOf(f) === 'bmd').sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  for (const f of files) {
    if (!TEX_EXT.has(extOf(f))) continue;
    const s = stemOf(f);
    if (!byStem.has(s)) byStem.set(s, []);
    byStem.get(s).push(f);
  }
  renderList();

  let qTimer;
  $('#q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(renderList, 120); });
  $('#list').addEventListener('click', e => { const it = e.target.closest('.item[data-i]'); if (it) select(+it.dataset.i); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { $('#modal').hidden = true; return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (e.target.tagName === 'SELECT') return;
    e.preventDefault();
    if (!shown.length) return;
    let pos = shown.indexOf(selected);
    pos = pos < 0 ? 0 : Math.max(0, Math.min(shown.length - 1, pos + (e.key === 'ArrowDown' ? 1 : -1)));
    select(shown[pos], true);
  });

  $('#act').onchange = (e) => {
    anim.action = +e.target.value; anim.frame = 0; anim.lastPosed = -1;
    $('#frame').max = Math.max(0, anim.model.actions[anim.action].keys - 1);
  };
  $('#play').onclick = () => { anim.playing = !anim.playing; $('#play').textContent = anim.playing ? '⏸' : '▶'; };
  $('#frame').oninput = (e) => {
    anim.playing = false; $('#play').textContent = '▶';
    anim.frame = +e.target.value;
  };
  $('#speed').oninput = (e) => { anim.fps = +e.target.value; $('#fpsLbl').textContent = e.target.value; };
  $('#textured').onchange = (e) => { viewer.textured = e.target.checked; viewer.dirty = true; };
  $('#lit').onchange = (e) => { viewer.lit = e.target.checked; viewer.dirty = true; };
  $('#bright').onchange = (e) => { viewer.jpgBright = e.target.checked; viewer.dirty = true; };
  $('#bg').onchange = (e) => {
    const h = e.target.value;
    viewer.bg = [1, 3, 5].map(k => parseInt(h.slice(k, k + 2), 16) / 255);
    viewer.dirty = true;
  };
  $('#bg').dispatchEvent(new Event('change'));
  $('#reset').onclick = () => viewer.resetView();
  $('#reveal').onclick = () => reveal(currentPath);
  $('#mreveal').onclick = () => reveal(modalPath);
  $('#mclose').onclick = () => { $('#modal').hidden = true; };
  $('#modal').onclick = (e) => { if (e.target.id === 'modal') $('#modal').hidden = true; };

  requestAnimationFrame(tick);
}

init();
