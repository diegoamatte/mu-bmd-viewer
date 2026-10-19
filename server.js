// Servidor local del visor: lista los archivos de la carpeta del pack y los entrega
// al navegador. Solo lee; nunca escribe ni ejecuta nada de esa carpeta.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');

const ROOT = path.resolve(process.argv[2] || '.');
const PORT = Number(process.env.PORT) || 5180;
const PUBLIC = path.join(__dirname, 'public');

if (!fs.existsSync(ROOT) || !fs.statSync(ROOT).isDirectory()) {
  console.error('No existe la carpeta: ' + ROOT);
  process.exit(1);
}

function scan() {
  const out = [];
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(path.relative(ROOT, p).split(path.sep).join('/'));
    }
  })(ROOT);
  return out;
}

let files = scan();
console.log(`Carpeta: ${ROOT} (${files.length} archivos)`);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function inside(base, abs) {
  return abs === base || abs.startsWith(base + path.sep);
}

http.createServer((req, res) => {
  // Solo responde a pedidos hechos a esta misma máquina.
  const host = (req.headers.host || '').toLowerCase();
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) { res.writeHead(403); return res.end(); }

  const url = new URL(req.url, 'http://local');

  if (url.pathname === '/api/index') {
    if (url.searchParams.has('rescan')) files = scan();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ root: ROOT, files }));
  }

  // Abre el Explorador de Windows con el archivo seleccionado.
  if (url.pathname === '/api/reveal' && req.method === 'POST') {
    const abs = path.resolve(ROOT, url.searchParams.get('p') || '');
    if (!inside(ROOT, abs) || !fs.existsSync(abs)) { res.writeHead(404); return res.end(); }
    if (process.platform !== 'win32') { res.writeHead(501); return res.end(); }
    const isDir = fs.statSync(abs).isDirectory();
    spawn('explorer.exe', [isDir ? `"${abs}"` : `/select,"${abs}"`], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }).unref();
    res.writeHead(204);
    return res.end();
  }

  if (url.pathname === '/api/file') {
    const abs = path.resolve(ROOT, url.searchParams.get('p') || '');
    if (!inside(ROOT, abs)) { res.writeHead(403); return res.end(); }
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
