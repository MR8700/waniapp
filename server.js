import http from 'node:http';
import { existsSync, statSync, createReadStream } from 'node:fs';
import { join, extname } from 'node:path';

const PORT = process.env.PORT || 3000;
const ROOT = process.cwd();
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

http.createServer((req, res) => {
  const pathname = decodeURIComponent(req.url.split('?')[0]);
  let file = join(ROOT, pathname === '/' ? 'index.html' : pathname);
  if (!existsSync(file) || !statSync(file).isFile()) {
    file = join(ROOT, 'index.html');
  }
  res.writeHead(200, {
    'content-type': MIME[extname(file)] || 'application/octet-stream',
    'access-control-allow-origin': '*',
    'cache-control': 'public, max-age=3600'
  });
  createReadStream(file).pipe(res);
}).listen(PORT, () => console.log('WANI Client démarré sur le port ' + PORT));
