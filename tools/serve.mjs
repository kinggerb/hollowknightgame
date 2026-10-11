/* ============================================================================
 * tools/serve.mjs — tiny static server for the Hollow Knight web port
 * ----------------------------------------------------------------------------
 *   node tools/serve.mjs            # serves this folder on 0.0.0.0:8080
 *   node tools/serve.mjs 3000       # ... on another port
 *   node tools/serve.mjs 3000 /path # ... from another folder
 *
 * Why not `python -m http.server`: it does not support HTTP Range requests,
 * which browsers use for media and Unity uses for some asset loads. This one
 * does, streams big files without buffering them, and sets the content types
 * iOS Safari needs (application/wasm, text/javascript, ...).
 *
 * Open http://<this-machine>:8080/ipad.html on the iPad.
 * ==========================================================================*/

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || process.env.PORT || 8080);
const root = path.resolve(process.argv[3] || repo);
const host = '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.resource': 'application/octet-stream',
  '.part': 'application/octet-stream',
  '.data': 'application/octet-stream',
};

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  if (MIME[ext]) return MIME[ext];
  if (/\.part\d+$/.test(file) || /^hktruffled\./.test(path.basename(file))) return 'application/octet-stream';
  return 'application/octet-stream';
}

function human(n) {
  if (n > 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n > 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  try {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';

    // keep the server inside the served folder
    const file = path.join(root, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    let stat;
    try {
      stat = await fsp.stat(file);
    } catch (e) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found: ' + rel);
      console.log('404 ' + rel);
      return;
    }
    if (stat.isDirectory()) {
      res.writeHead(302, { location: rel.replace(/\/?$/, '/') + 'index.html' }).end();
      return;
    }

    const headers = {
      'content-type': contentType(file),
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      // no COEP/COOP needed here; the game is single threaded
      'cross-origin-resource-policy': 'same-origin',
    };

    // ---- range requests ----
    const range = req.headers.range;
    let start = 0;
    let end = stat.size - 1;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
      if (m) {
        if (m[1] === '' && m[2] !== '') {
          const suffix = Number(m[2]);
          start = Math.max(0, stat.size - suffix);
        } else {
          start = Number(m[1] || 0);
          end = m[2] === '' ? stat.size - 1 : Number(m[2]);
        }
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
          res.writeHead(416, { 'content-range': 'bytes */' + stat.size }).end();
          return;
        }
        headers['content-range'] = `bytes ${start}-${end}/${stat.size}`;
        res.writeHead(206, headers);
      } else {
        res.writeHead(200, Object.assign({ 'content-length': String(stat.size) }, headers));
      }
    } else {
      headers['content-length'] = String(stat.size);
      res.writeHead(200, headers);
    }

    const length = end - start + 1;
    if (req.method === 'HEAD') {
      res.end();
    } else {
      await new Promise((resolve) => {
        const stream = fs.createReadStream(file, { start, end, highWaterMark: 1 << 19 });
        stream.on('error', () => res.destroy());
        stream.on('end', resolve);
        stream.pipe(res);
      });
    }
    if (stat.size > 4 * 1048576) {
      console.log(
        (range ? '206 ' : '200 ') + rel + '  ' + human(length) + '  (' + (Date.now() - started) + 'ms)'
      );
    }
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end('server error: ' + err.message);
    console.log('500 ' + req.url + ' ' + err.message);
  }
});

server.listen(port, host, () => {
  console.log('Hollow Knight served from ' + root);
  console.log('  local:   http://127.0.0.1:' + port + '/ipad.html');
  console.log('  network: http://<your-ip>:' + port + '/ipad.html');
});
