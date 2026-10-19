// Servidor local del visor: lista los archivos de la carpeta elegida y los entrega
// al navegador. Solo lee; nunca escribe ni ejecuta nada de esa carpeta.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec, execFile, spawn } = require('child_process');

const PORT = Number(process.env.PORT) || 5180;
const PUBLIC = path.join(__dirname, 'public');
const CONFIG = path.join(__dirname, 'config.json'); // última carpeta y recientes
const MAX_RECENT = 10;

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; }
}
function writeConfig(cfg) {
  try { fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2)); } catch (e) { console.error('No se pudo guardar config.json: ' + e.message); }
}
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

let config = readConfig();
let ROOT = null;
let files = [];

function scan(root) {
  const out = [];
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(path.relative(root, p).split(path.sep).join('/'));
    }
  })(root);
  return out;
}

function setRoot(dir) {
  ROOT = path.resolve(dir);
  files = scan(ROOT);
  const recent = (config.recent || []).filter(r => r.toLowerCase() !== ROOT.toLowerCase() && isDir(r));
  config = { last: ROOT, recent: [ROOT, ...recent].slice(0, MAX_RECENT) };
  writeConfig(config);
  console.log(`Carpeta: ${ROOT} (${files.length} archivos)`);
}

// Al arrancar: la carpeta que se pasó por parámetro, o la última que se usó.
const startDir = process.argv[2] || config.last;
if (startDir && isDir(startDir)) setRoot(startDir);
else if (process.argv[2]) console.error('No existe la carpeta: ' + process.argv[2]);

// Selector de carpetas nativo de Windows (corre en PowerShell).
function pickFolder() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ error: 'El selector de carpetas solo funciona en Windows' });
    const script = [
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$d.Description = "Elegí la carpeta base del pack de modelos"',
      '$d.ShowNewFolderButton = $false',
      'if ($env:VISOR_START) { $d.SelectedPath = $env:VISOR_START }',
      '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }',
      'if ($d.ShowDialog($owner) -eq "OK") { [Console]::Out.Write($d.SelectedPath) }',
    ].join('; ');
    execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', script],
      { env: { ...process.env, VISOR_START: ROOT || '' }, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => {
        if (err) return resolve({ error: 'No se pudo abrir el selector de carpetas' });
        resolve({ dir: stdout.trim() || null });
      });
  });
}

function inside(base, abs) {
  return abs === base || abs.startsWith(base + path.sep);
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const indexPayload = () => ({ root: ROOT, files, recent: config.recent || [] });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

http.createServer(async (req, res) => {
  // Solo responde a pedidos hechos a esta misma máquina.
  const host = (req.headers.host || '').toLowerCase();
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) { res.writeHead(403); return res.end(); }

  const url = new URL(req.url, 'http://local');

  if (url.pathname === '/api/index') {
    if (url.searchParams.has('rescan') && ROOT) files = scan(ROOT);
    return sendJson(res, 200, indexPayload());
  }

  // Cambia la carpeta base: con el selector de Windows o con una ruta (recientes / escrita a mano).
  if (url.pathname === '/api/root' && req.method === 'POST') {
    let dir = url.searchParams.get('path');
    if (!dir) {
      const picked = await pickFolder();
      if (picked.error) return sendJson(res, 500, { error: picked.error });
      if (!picked.dir) return sendJson(res, 200, { cancelled: true });
      dir = picked.dir;
    }
    if (!isDir(dir)) return sendJson(res, 404, { error: 'No existe la carpeta: ' + dir });
    setRoot(dir);
    return sendJson(res, 200, indexPayload());
  }

  if (url.pathname === '/api/file' || url.pathname === '/api/reveal') {
    if (!ROOT) { res.writeHead(404); return res.end(); }
    const abs = path.resolve(ROOT, url.searchParams.get('p') || '');
    if (!inside(ROOT, abs)) { res.writeHead(403); return res.end(); }

    // Abre el Explorador de Windows con el archivo seleccionado.
    if (url.pathname === '/api/reveal') {
      if (req.method !== 'POST' || !fs.existsSync(abs)) { res.writeHead(404); return res.end(); }
      if (process.platform !== 'win32') { res.writeHead(501); return res.end(); }
      spawn('explorer.exe', [isDir(abs) ? `"${abs}"` : `/select,"${abs}"`], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }).unref();
      res.writeHead(204);
      return res.end();
    }

    return fs.readFile(abs, (err, buf) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(buf);
    });
  }

  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const abs = path.resolve(PUBLIC, rel);
  if (!inside(PUBLIC, abs)) { res.writeHead(403); return res.end(); }
  fs.readFile(abs, (err, buf) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}).listen(PORT, '127.0.0.1', () => {
  const link = `http://127.0.0.1:${PORT}/`;
  console.log(`Visor abierto en ${link}  (cerrá esta ventana para apagarlo)`);
  if (process.platform === 'win32' && !process.env.NO_OPEN) exec(`start "" "${link}"`);
});
