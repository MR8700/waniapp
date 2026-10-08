import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { seed } from '../server/seed.js';

let appInstance = null;

function getApp() {
  if (appInstance) return appInstance;

  const dataDir = process.env.DATA_DIR || (process.env.VERCEL ? '/tmp/wani-data' : join(process.cwd(), 'data'));
  mkdirSync(dataDir, { recursive: true });

  const sf = join(dataDir, '.secret');
  if (!process.env.APP_SECRET && !existsSync(sf)) {
    writeFileSync(sf, randomBytes(48).toString('base64'), { mode: 0o600 });
  }
  const secret = process.env.APP_SECRET || (existsSync(sf) ? readFileSync(sf, 'utf8') : 'wani-vercel-secret-fallback-key');
  const db = openDb(join(dataDir, 'app.db'));

  if (!db.prepare('SELECT 1 x FROM establishments').get()) {
    seed(db);
  }

  appInstance = createApp({
    db,
    secret,
    dataDir,
    webDir: join(process.cwd(), 'web')
  });

  return appInstance;
}

export default async function handler(req, res) {
  const app = getApp();
  return app(req, res);
}
