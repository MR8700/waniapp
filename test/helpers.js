import http from 'node:http';
import { webcrypto as W } from 'node:crypto';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { seed } from '../server/seed.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export async function boot() {
  const clock = { t: 1_800_000_000_000 }, db = openDb(), s = seed(db, clock.t);
  const app = createApp({ db, secret: 'test-secret', now: () => clock.t, dataDir: mkdtempSync(join(tmpdir(), 'bv-')) });
  const srv = http.createServer(app); await new Promise(r => srv.listen(0, r)); srv.unref();
  const base = 'http://127.0.0.1:' + srv.address().port;
  const call = async (method, path, body, tok, headers = {}) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j };
  };
  return { clock, db, seed: s, call, close: () => { srv.closeAllConnections(); srv.close(); } };
}
const b64 = b => Buffer.from(b).toString('base64');
// Simule un appareil : clé privée non exportable, comme sur le client réel
export async function genKey(env) {
  const kp = await W.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const pub = b64(await W.subtle.exportKey('spki', kp.publicKey));
  const sign = async m => b64(await W.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, Buffer.from(m)));
  const ts = env.clock.t, pop = await sign(`register|${pub}|${ts}`);
  return { pub, sign, ts, pop };
}
export async function newDevice(env, { invite_code, name = 'Test' } = {}) {
  const { pub, sign, ts, pop } = await genKey(env);
  const reg = await env.call('POST', '/auth/device/register', { public_key: pub, pop, ts, device_name: name, platform: 'test', display_name: name, invite_code });
  const d = { pub, sign, reg, id: reg.body.device_id, user_id: reg.body.user_id };
  d.login = async () => { const c = await env.call('POST', '/auth/device/challenge', { device_id: d.id }); if (c.status !== 200) return c; const sig = await sign(`auth|${d.id}|${c.body.nonce}`); return env.call('POST', '/auth/device/verify', { device_id: d.id, nonce: c.body.nonce, signature: sig }); };
  d.token = async () => (await d.login()).body.access_token;
  return d;
}
