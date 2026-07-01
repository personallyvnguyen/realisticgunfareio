'use strict';

/**
 * realisticgunfare.io — static file server.
 *
 * Zero dependencies on purpose: this serves the client and is the natural
 * home for the authoritative WebSocket game loop when we add multiplayer.
 * For now the simulation runs client-side; see the MULTIPLAYER note below.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  // Strip query string, decode, and normalize to prevent path traversal.
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let rel = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  if (rel === '/' || rel === '\\') rel = '/index.html';

  const filePath = path.join(ROOT, rel);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Fall back to index.html so the client can route (SPA-style).
      if (err.code === 'ENOENT') {
        fs.readFile(path.join(ROOT, 'index.html'), (e2, html) => {
          if (e2) {
            res.writeHead(404);
            res.end('Not found');
          } else {
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end(html);
          }
        });
        return;
      }
      res.writeHead(500);
      res.end('Server error');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n  realisticgunfare.io  →  http://localhost:${PORT}\n`);
});

/*
 * MULTIPLAYER (planned)
 * ---------------------
 * Add the `ws` package and an authoritative server loop here:
 *   - Server owns world state (positions, health, bullets) at a fixed tick.
 *   - Clients send inputs (move dir, aim angle, fire/reload) only.
 *   - Server broadcasts snapshots; clients interpolate + predict locally.
 * The client physics in /public/js is already written in real-world units
 * and split so the same integrator can run server-side.
 */
