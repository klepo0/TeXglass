#!/usr/bin/env node
/* Tiny static server for the viewer: npm start, then open http://localhost:8000 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const port = Number(process.env.PORT) || 8000;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.tex': 'text/plain', '.json': 'application/json' };

http
  .createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const file = path.normalize(path.join(root, url === '/' ? 'index.html' : url));
    if (!file.startsWith(root + path.sep) || file.includes(`${path.sep}node_modules${path.sep}`)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end('Not found');
      res.writeHead(200, { 'Content-Type': (types[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8' });
      res.end(data);
    });
  })
  .listen(port, () => console.log(`TeXglass viewer at http://localhost:${port}`));
