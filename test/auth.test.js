import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, newDevice, genKey } from './helpers.js';

test('nouvel appareil + connexion + /me', async () => {
  const e = await boot(); const d = await newDevice(e);
  assert.equal(d.reg.status, 201);
  const l = await d.login(); assert.equal(l.status, 200);
  assert.equal((await e.call('GET', '/me', null, l.body.access_token)).body.id, d.user_id); e.close();
});
test('mauvaise signature rejetée', async () => {
  const e = await boot(); const d = await newDevice(e), o = await newDevice(e);
  const c = await e.call('POST', '/auth/device/challenge', { device_id: d.id });
  const r = await e.call('POST', '/auth/device/verify', { device_id: d.id, nonce: c.body.nonce, signature: await o.sign(`auth|${d.id}|${c.body.nonce}`) });
  assert.equal(r.status, 401); assert.equal(r.body.error, 'INVALID_SIGNATURE'); e.close();
});
test('replay: nonce réutilisé refusé', async () => {
  const e = await boot(); const d = await newDevice(e);
  const c = await e.call('POST', '/auth/device/challenge', { device_id: d.id }), sig = await d.sign(`auth|${d.id}|${c.body.nonce}`);
  const body = { device_id: d.id, nonce: c.body.nonce, signature: sig };
  assert.equal((await e.call('POST', '/auth/device/verify', body)).status, 200);
  assert.equal((await e.call('POST', '/auth/device/verify', body)).body.error, 'NONCE_INVALID_OR_REUSED'); e.close();
});
test('nonce expiré', async () => {
  const e = await boot(); const d = await newDevice(e);
  const c = await e.call('POST', '/auth/device/challenge', { device_id: d.id }), sig = await d.sign(`auth|${d.id}|${c.body.nonce}`);
  e.clock.t += 61e3;
  assert.equal((await e.call('POST', '/auth/device/verify', { device_id: d.id, nonce: c.body.nonce, signature: sig })).body.error, 'NONCE_EXPIRED'); e.close();
});
test('preuve de possession requise à l’enregistrement', async () => {
  const e = await boot(); const d = await newDevice(e);
  const r = await e.call('POST', '/auth/device/register', { public_key: d.pub, pop: 'AAAA', ts: e.clock.t });
  assert.equal(r.status, 400); e.close();
});
test('session: access expiré, refresh avec rotation et détection de réutilisation', async () => {
  const e = await boot(); const d = await newDevice(e), l = (await d.login()).body;
  e.clock.t += 11 * 60e3;
  assert.equal((await e.call('GET', '/me', null, l.access_token)).status, 401);
  const r1 = await e.call('POST', '/auth/session/refresh', { refresh_token: l.refresh_token }); assert.equal(r1.status, 200);
  assert.equal((await e.call('GET', '/me', null, r1.body.access_token)).status, 200);
  assert.equal((await e.call('POST', '/auth/session/refresh', { refresh_token: l.refresh_token })).status, 401); // ancien refresh => vol suspecté
  assert.equal((await e.call('POST', '/auth/session/refresh', { refresh_token: r1.body.refresh_token })).status, 401); // session révoquée
  e.close();
});
test('appareil révoqué: ne peut plus s’authentifier, sessions coupées', async () => {
  const e = await boot(); const a = await newDevice(e);
  const code = (await e.call('POST', '/me/devices', null, await a.token())).body.code;
  const b = await newDevice(e, { invite_code: code }); assert.equal(b.user_id, a.user_id);
  const tb = await b.token(), ta = await a.token();
  assert.equal((await e.call('DELETE', '/me/devices/' + b.id, null, ta)).status, 200);
  assert.equal((await e.call('GET', '/me', null, tb)).status, 401);
  assert.equal((await b.login()).body.error, 'DEVICE_REVOKED'); e.close();
});
test('code d’association: usage unique et expiration', async () => {
  const e = await boot(); const a = await newDevice(e), ta = await a.token();
  const c1 = (await e.call('POST', '/me/devices', null, ta)).body.code;
  assert.equal((await newDevice(e, { invite_code: c1 })).reg.status, 201);
  assert.equal((await newDevice(e, { invite_code: c1 })).reg.status, 400);
  const c2 = (await e.call('POST', '/me/devices', null, ta)).body.code; e.clock.t += 301e3;
  assert.equal((await newDevice(e, { invite_code: c2 })).reg.status, 400); e.close();
});
test('récupération: approuvée par ADMIN, anciens appareils révoqués', async () => {
  const e = await boot(); const a = await newDevice(e), ad = await newDevice(e);
  e.db.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(ad.user_id);
  const k = await genKey(e);
  const rq = await e.call('POST', '/auth/recovery/request', { public_key: k.pub, pop: k.pop, ts: k.ts, device_name: 'Nouveau' });
  assert.equal(rq.status, 201);
  assert.equal((await e.call('POST', `/admin/recovery/${rq.body.request_id}/approve`, { user_id: a.user_id }, await a.token())).status, 403); // non-admin
  const ap = await e.call('POST', `/admin/recovery/${rq.body.request_id}/approve`, { user_id: a.user_id }, await ad.token());
  assert.equal(ap.status, 200);
  assert.equal((await a.login()).body.error, 'DEVICE_REVOKED');
  const c = await e.call('POST', '/auth/device/challenge', { device_id: ap.body.device_id });
  const v = await e.call('POST', '/auth/device/verify', { device_id: ap.body.device_id, nonce: c.body.nonce, signature: await k.sign(`auth|${ap.body.device_id}|${c.body.nonce}`) });
  assert.equal(v.status, 200); e.close();
});

test('admin: listing et rejet de demande de récupération', async () => {
  const e = await boot(); const u = await newDevice(e), ad = await newDevice(e);
  e.db.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(ad.user_id);
  const k = await genKey(e);
  const rq = await e.call('POST', '/auth/recovery/request', { public_key: k.pub, pop: k.pop, ts: k.ts, device_name: 'Appareil Volé', claimed_name: 'Oumar' });
  const list = await e.call('GET', '/admin/recovery', null, await ad.token());
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body) && list.body.some(r => r.id === rq.body.request_id));
  const rej = await e.call('POST', `/admin/recovery/${rq.body.request_id}/reject`, null, await ad.token());
  assert.equal(rej.status, 200);
  const check = await e.call('GET', `/auth/recovery/${rq.body.request_id}`);
  assert.equal(check.body.status, 'REJECTED');
  e.close();
});

test('sécurité: blocage strict du path traversal statique', async () => {
  const e = await boot();
  const r1 = await e.call('GET', '/..%2f..%2fpackage.json');
  assert.ok([400, 403, 404].includes(r1.status));
  const r2 = await e.call('GET', '/%2e%2e/%2e%2e/etc/passwd');
  assert.ok([400, 403, 404].includes(r2.status));
  e.close();
});
