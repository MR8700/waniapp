import http from 'node:http';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { seed } from './seed.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.DATA_DIR || (process.env.VERCEL ? '/tmp/wani-data' : join(root, 'data'));
mkdirSync(dataDir, { recursive: true });

const sf = join(dataDir, '.secret');
if (!process.env.APP_SECRET && !existsSync(sf)) {
  writeFileSync(sf, randomBytes(48).toString('base64'), { mode: 0o600 });
}
const secret = process.env.APP_SECRET || readFileSync(sf, 'utf8');
const db = openDb(join(dataDir, 'app.db'));

if (!db.prepare('SELECT 1 x FROM establishments').get()) {
  const s = seed(db);
  console.log('\n== WANI APP · PREMIER LANCEMENT ==\nCode gérant (24h, usage unique):', s.managerInvite, '\nQR: http://localhost:3000/?q=<token>');
  console.log(s.tokens, '\n');
}

const app = createApp({ db, secret, dataDir, webDir: join(root, 'web') });
const port = process.env.PORT || 3000;
http.createServer(app).listen(port, () => console.log('WANI APP démarrée sur http://localhost:' + port));
