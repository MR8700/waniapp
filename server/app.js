import { readFileSync, writeFileSync, mkdirSync, existsSync, createReadStream, statSync } from 'node:fs';
import { join, extname, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tx } from './db.js';
import { HttpError as E, uid, sha, rand, verifySig, signToken, readToken, limiter } from './util.js';
import { interpret } from './voice.js';

export const PAYMENT_METHODS = ['CASH', 'ORANGE_MONEY', 'MOOV_MONEY', 'CARD', 'OTHER'];
const FLOW = {
  SUBMITTED: ['RECEIVED', 'COMPLETED', 'REJECTED', 'CANCELLED'],
  RECEIVED: ['COMPLETED', 'PREPARING', 'CANCELLED'],
  PREPARING: ['COMPLETED', 'READY', 'CANCELLED'],
  READY: ['COMPLETED', 'DELIVERED'],
  DELIVERING: ['COMPLETED', 'DELIVERED'],
  DELIVERED: ['COMPLETED'],
};
const MSG = {
  EXPIRED: 'Commande expirée',
  RECEIVED: 'Commande reçue',
  PREPARING: 'En préparation',
  READY: 'Commande prête',
  DELIVERING: 'En livraison',
  DELIVERED: 'Commande livrée',
  COMPLETED: 'Commande terminée',
  REJECTED: 'Commande refusée',
  CANCELLED: 'Commande annulée'
};
const ACCESS_TTL = 10 * 60e3, REFRESH_TTL = 30 * 86400e3, NONCE_TTL = 60e3;
const RANK = { CLIENT: 0, STAFF: 1, MANAGER: 2 };
const ALLOWED_AUDIO_MIMES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/wav', 'audio/mpeg'];

export function createApp({ db, secret, now = () => Date.now(), dataDir = './data', webDir = null, bootstrap = null }) {
  const rl = limiter();
  const q = (sql, ...a) => db.prepare(sql).all(...a);
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  const audit = (ctx, action, type, id, meta = {}) => run('INSERT INTO audit_logs VALUES(?,?,?,?,?,?,?,?,?)', uid(), ctx.user?.id || null, ctx.device?.id || null, action, type, id, JSON.stringify(meta), ctx.ip, now());
  const notify = (o) => run('INSERT INTO notifications VALUES(?,?,?,?,?,?,?,NULL)', uid(), o.user_id || null, o.est || null, o.order || null, o.type, o.message, now());

  // ---------- Temps réel (Server-Sent Events) ----------
  const sseClients = new Set();
  function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      try {
        client.res.write(payload);
      } catch {
        sseClients.delete(client);
      }
    }
  }

  const ssePing = setInterval(() => {
    for (const client of sseClients) {
      try {
        client.res.write(':keepalive\n\n');
      } catch {
        sseClients.delete(client);
      }
    }
  }, 15000);
  ssePing.unref();

  // ---------- helpers d'autorisation (toujours côté serveur) ----------
  const roleIn = (ctx, est) => ctx.user.is_admin ? 2 : RANK[one('SELECT role FROM establishment_members WHERE user_id=? AND establishment_id=?', ctx.user.id, est)?.role] ?? 0;
  const need = (ctx, est, min) => { if (roleIn(ctx, est) < RANK[min]) throw new E(403, 'FORBIDDEN'); };
  const admin = ctx => { if (!ctx.user.is_admin) throw new E(403, 'FORBIDDEN'); };
  const limit = (ctx, key, max, win) => { if (!rl(key + ':' + ctx.ip, max, win, now())) throw new E(429, 'RATE_LIMITED'); };

  function newSession(user_id, device_id) {
    const refresh = rand(), sid = uid();
    run('INSERT INTO sessions VALUES(?,?,?,?,NULL,?,NULL,?)', sid, user_id, device_id, sha(refresh), now() + REFRESH_TTL, now());
    return tokens(user_id, device_id, sid, refresh);
  }
  const tokens = (u, d, sid, refresh) => ({ access_token: signToken({ sub: u, did: d, sid, exp: now() + ACCESS_TTL }, secret), refresh_token: refresh, expires_in: ACCESS_TTL / 1000 });
  function authenticate(req) {
    const t = readToken((req.headers.authorization || '').replace(/^Bearer /, ''), secret, now());
    if (!t) throw new E(401, 'INVALID_TOKEN');
    const s = one('SELECT * FROM sessions WHERE id=?', t.sid), d = one('SELECT * FROM devices WHERE id=?', t.did), u = one('SELECT * FROM users WHERE id=?', t.sub);
    if (!s || s.revoked_at || !d || d.status !== 'ACTIVE' || !u || u.status !== 'ACTIVE') throw new E(401, 'SESSION_REVOKED');
    return { user: u, device: d };
  }
  function revokeDevice(id) {
    run("UPDATE devices SET status='REVOKED',revoked_at=? WHERE id=?", now(), id);
    run('UPDATE sessions SET revoked_at=? WHERE device_id=? AND revoked_at IS NULL', now(), id);
  }
  function mkInvite(o) {
    const code = randomBytes(5).toString('hex').toUpperCase().match(/.{1,5}/g).join('-'); // 40 bits, TTL court, usage unique
    run('INSERT INTO invites VALUES(?,?,?,?,?,?,?)', sha(code), o.kind, o.user_id || null, o.est || null, o.role || null, now() + (o.ttl || 300e3), 1);
    return code;
  }

  // ---------- routes ----------
  const routes = [];
  const on = (m, p, auth, fn) => routes.push({ m, re: new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), auth, fn });

  // AUTH (Zéro mot de passe - L'appareil est la clé)
  on('POST', '/auth/device/register', false, (c) => {
    limit(c, 'reg', 10, 60e3);
    const b = c.body;
    if (!b.public_key || !b.pop || !b.ts || Math.abs(now() - b.ts) > 120e3) throw new E(400, 'BAD_REQUEST');
    if (!verifySig(b.public_key, `register|${b.public_key}|${b.ts}`, b.pop)) throw new E(400, 'INVALID_PROOF_OF_POSSESSION');
    if (one('SELECT 1 x FROM devices WHERE public_key=?', b.public_key)) throw new E(409, 'DEVICE_EXISTS');
    return tx(db, () => {
      let user_id, inv = null;
      if (b.invite_code) {
        inv = one('SELECT * FROM invites WHERE code_hash=? AND uses_left>0 AND expires_at>?', sha(String(b.invite_code).toUpperCase()), now());
        if (!inv) throw new E(400, 'INVALID_INVITE');
        run('UPDATE invites SET uses_left=uses_left-1 WHERE code_hash=?', inv.code_hash);
      }
      if (inv?.kind === 'DEVICE') user_id = inv.user_id;
      else {
        user_id = uid(); run('INSERT INTO users VALUES(?,?,0,?,?)', user_id, String(b.display_name || 'Client').trim().slice(0, 60), 'ACTIVE', now());
        if (inv?.kind === 'ROLE') run('INSERT INTO establishment_members VALUES(?,?,?)', user_id, inv.establishment_id, inv.role);
      }
      const id = uid();
      run('INSERT INTO devices VALUES(?,?,?,?,?,?,?,?,NULL)', id, user_id, b.public_key, String(b.device_name || 'Appareil').trim().slice(0, 60), String(b.platform || 'web').trim().slice(0, 20), 'ACTIVE', now(), now());
      audit({ ...c, user: { id: user_id }, device: { id } }, 'DEVICE_REGISTERED', 'device', id, { via: inv ? inv.kind : 'self' });
      return { status: 201, body: { device_id: id, user_id } };
    });
  });
  on('POST', '/auth/device/challenge', false, (c) => {
    limit(c, 'chal', 30, 60e3);
    const d = one('SELECT * FROM devices WHERE id=?', String(c.body.device_id));
    if (!d) throw new E(404, 'UNKNOWN_DEVICE');
    if (d.status !== 'ACTIVE') throw new E(403, 'DEVICE_REVOKED');
    const nonce = rand(32);
    run('INSERT INTO device_challenges VALUES(?,?,?,NULL)', nonce, d.id, now() + NONCE_TTL);
    return { nonce, expires_in: NONCE_TTL / 1000 };
  });
  on('POST', '/auth/device/verify', false, (c) => {
    limit(c, 'ver', 20, 60e3);
    const { device_id, nonce, signature } = c.body;
    const d = one('SELECT * FROM devices WHERE id=?', String(device_id));
    if (!d) throw new E(401, 'AUTH_FAILED');
    if (d.status !== 'ACTIVE') throw new E(403, 'DEVICE_REVOKED');
    const ch = one('SELECT * FROM device_challenges WHERE nonce=? AND device_id=?', String(nonce), d.id);
    if (!ch || ch.used_at) throw new E(401, 'NONCE_INVALID_OR_REUSED');
    if (ch.expires_at < now()) throw new E(401, 'NONCE_EXPIRED');
    if (!verifySig(d.public_key, `auth|${d.id}|${nonce}`, String(signature))) throw new E(401, 'INVALID_SIGNATURE');
    if (run('UPDATE device_challenges SET used_at=? WHERE nonce=? AND used_at IS NULL', now(), ch.nonce).changes !== 1) throw new E(401, 'NONCE_INVALID_OR_REUSED');
    run('UPDATE devices SET last_seen_at=? WHERE id=?', now(), d.id);
    return newSession(d.user_id, d.id);
  });
  on('POST', '/auth/session/refresh', false, (c) => {
    limit(c, 'ref', 30, 60e3);
    const h = sha(String(c.body.refresh_token)), s = one('SELECT * FROM sessions WHERE refresh_hash=?', h);
    if (!s) {
      const old = one('SELECT * FROM sessions WHERE prev_refresh_hash=?', h);
      if (old) run('UPDATE sessions SET revoked_at=? WHERE id=?', now(), old.id); // réutilisation d'un refresh périmé => vol suspecté
      throw new E(401, 'INVALID_REFRESH');
    }
    const d = one('SELECT status FROM devices WHERE id=?', s.device_id);
    if (s.revoked_at || s.expires_at < now() || d?.status !== 'ACTIVE') throw new E(401, 'SESSION_EXPIRED');
    const refresh = rand();
    run('UPDATE sessions SET refresh_hash=?,prev_refresh_hash=? WHERE id=?', sha(refresh), h, s.id);
    return tokens(s.user_id, s.device_id, s.id, refresh);
  });
  on('POST', '/auth/recovery/request', false, (c) => {
    limit(c, 'rec', 5, 3600e3);
    const b = c.body;
    if (!b.public_key || !verifySig(b.public_key, `register|${b.public_key}|${b.ts}`, String(b.pop)) || Math.abs(now() - b.ts) > 120e3) throw new E(400, 'INVALID_PROOF_OF_POSSESSION');
    const id = uid();
    run('INSERT INTO recovery_requests VALUES(?,?,?,?,?,?,NULL,NULL,NULL,?)', id, b.public_key, String(b.device_name || '').slice(0, 60), String(b.platform || '').slice(0, 20), String(b.claimed_name || '').slice(0, 60), 'PENDING', now());
    return { status: 201, body: { request_id: id } };
  });
  on('GET', '/auth/recovery/:id', false, (c) => {
    const r = one('SELECT id,status,device_id FROM recovery_requests WHERE id=?', c.params.id);
    if (!r) throw new E(404, 'NOT_FOUND'); return r;
  });

  // ADMIN : Récupération d'appareils & gestion
  on('GET', '/admin/recovery', true, (c) => {
    admin(c);
    return q("SELECT id,public_key,device_name,platform,claimed_name,status,user_id,device_id,decided_by,created_at FROM recovery_requests ORDER BY created_at DESC LIMIT 100");
  });
  on('POST', '/admin/recovery/:id/approve', true, (c) => {
    admin(c);
    const r = one("SELECT * FROM recovery_requests WHERE id=? AND status='PENDING'", c.params.id);
    const u = one('SELECT id FROM users WHERE id=?', String(c.body.user_id));
    if (!r || !u) throw new E(404, 'NOT_FOUND');
    return tx(db, () => {
      if (c.body.revoke_others !== false) for (const d of q("SELECT id FROM devices WHERE user_id=? AND status='ACTIVE'", u.id)) revokeDevice(d.id);
      const id = uid();
      run('INSERT INTO devices VALUES(?,?,?,?,?,?,?,?,NULL)', id, u.id, r.public_key, r.device_name, r.platform, 'ACTIVE', now(), now());
      run("UPDATE recovery_requests SET status='APPROVED',user_id=?,device_id=?,decided_by=? WHERE id=?", u.id, id, c.user.id, r.id);
      audit(c, 'RECOVERY_APPROVED', 'user', u.id, { device_id: id });
      return { device_id: id };
    });
  });
  on('POST', '/admin/recovery/:id/reject', true, (c) => {
    admin(c);
    const r = one("SELECT * FROM recovery_requests WHERE id=? AND status='PENDING'", c.params.id);
    if (!r) throw new E(404, 'NOT_FOUND');
    run("UPDATE recovery_requests SET status='REJECTED',decided_by=? WHERE id=?", c.user.id, r.id);
    audit(c, 'RECOVERY_REJECTED', 'recovery', r.id);
    return { ok: true };
  });

  // PROFIL / APPAREILS
  on('GET', '/me', true, c => ({
    id: c.user.id,
    display_name: c.user.display_name,
    is_admin: !!c.user.is_admin,
    device_id: c.device.id,
    memberships: q('SELECT m.establishment_id,m.role,e.name FROM establishment_members m JOIN establishments e ON e.id=m.establishment_id WHERE m.user_id=?', c.user.id)
  }));
  on('GET', '/me/devices', true, c => q('SELECT id,device_name,platform,status,created_at,last_seen_at,revoked_at FROM devices WHERE user_id=? ORDER BY created_at', c.user.id).map(d => ({ ...d, current: d.id === c.device.id })));
  on('POST', '/me/devices', true, c => { const code = mkInvite({ kind: 'DEVICE', user_id: c.user.id }); audit(c, 'DEVICE_PAIRING_CODE_CREATED', 'user', c.user.id); return { status: 201, body: { code, expires_in: 300 } }; });
  const delDev = c => {
    const d = one('SELECT * FROM devices WHERE id=? AND user_id=?', c.params.id, c.user.id);
    if (!d) throw new E(404, 'NOT_FOUND');
    if (d.id === c.device.id && one("SELECT COUNT(*) n FROM devices WHERE user_id=? AND status='ACTIVE'", c.user.id).n === 1) throw new E(409, 'LAST_DEVICE');
    revokeDevice(d.id); audit(c, 'DEVICE_REVOKED', 'device', d.id); return { ok: true };
  };
  on('DELETE', '/me/devices/:id', true, delDev);
  on('POST', '/auth/device/revoke', true, c => { c.params = { id: String(c.body.device_id) }; return delDev(c); });
  on('PATCH', '/me', true, c => { run('UPDATE users SET display_name=? WHERE id=?', String(c.body.display_name || '').slice(0, 60), c.user.id); return { ok: true }; });

  // ÉTABLISSEMENTS / ZONES / POINTS / QR
  const estOk = id => { const e = one("SELECT * FROM establishments WHERE id=? AND status='ACTIVE'", id); if (!e) throw new E(404, 'ESTABLISHMENT_UNAVAILABLE'); return e; };
  on('GET', '/establishments', true, () => q("SELECT id,name FROM establishments WHERE status='ACTIVE'"));
  on('GET', '/establishments/public', false, () => {
    return q("SELECT id,name,status FROM establishments WHERE status='ACTIVE'").map(e => ({
      ...e,
      points: q("SELECT p.id,p.code,p.label,z.name zone FROM reception_points p JOIN zones z ON z.id=p.zone_id WHERE p.establishment_id=? AND p.active=1 ORDER BY p.code", e.id)
    }));
  });
  on('POST', '/establishments', true, c => {
    const name = String(c.body.name || '').trim().slice(0, 80);
    if (!name) throw new E(400, 'NAME_REQUIRED');
    const id = uid();
    run('INSERT INTO establishments VALUES(?,?,?,?)', id, name, 'ACTIVE', now());
    run('INSERT INTO establishment_members VALUES(?,?,?)', c.user.id, id, 'MANAGER');
    const zid = uid();
    run('INSERT INTO zones VALUES(?,?,?,?)', zid, id, 'Salle & Terrasse', 0);
    audit(c, 'ESTABLISHMENT_CREATED', 'establishment', id, { name });
    return { status: 201, body: { id, name, default_zone_id: zid } };
  });
  on('PATCH', '/establishments/:id', true, c => {
    need(c, c.params.id, 'MANAGER');
    const e = one('SELECT * FROM establishments WHERE id=?', c.params.id);
    if (!e) throw new E(404, 'NOT_FOUND');
    const name = c.body.name ? String(c.body.name).trim().slice(0, 80) : e.name;
    const status = c.body.status && ['ACTIVE', 'PAUSED'].includes(c.body.status) ? c.body.status : e.status;
    run('UPDATE establishments SET name=?,status=? WHERE id=?', name, status, e.id);
    return { ok: true, id: e.id, name, status };
  });
  on('GET', '/establishments/:id', true, c => estOk(c.params.id));
  on('GET', '/establishments/:id/points', true, c => {
    return q('SELECT p.id,p.code,p.label,p.active,z.name zone,t.token FROM reception_points p JOIN zones z ON z.id=p.zone_id LEFT JOIN qr_tokens t ON t.reception_point_id=p.id AND t.active=1 WHERE p.establishment_id=? ORDER BY p.code', c.params.id);
  });
  on('POST', '/establishments/:id/points', true, c => {
    need(c, c.params.id, 'MANAGER');
    let zone = c.body.zone_id ? one('SELECT * FROM zones WHERE id=? AND establishment_id=?', c.body.zone_id, c.params.id) : null;
    if (!zone) {
      zone = one('SELECT * FROM zones WHERE establishment_id=? ORDER BY sort LIMIT 1', c.params.id);
      if (!zone) {
        const zid = uid();
        run('INSERT INTO zones VALUES(?,?,?,?)', zid, c.params.id, 'Salle & Terrasse', 0);
        zone = { id: zid };
      }
    }
    const id = uid(), token = rand(16);
    const code = String(c.body.code || ('T' + rand(4).toUpperCase())).trim().slice(0, 15);
    const label = String(c.body.label || code).trim().slice(0, 40);
    run('INSERT INTO reception_points VALUES(?,?,?,?,?,1)', id, c.params.id, zone.id, code, label);
    run('INSERT INTO qr_tokens VALUES(?,?,1,NULL,?)', token, id, now());
    return { status: 201, body: { id, code, label, token, zone_id: zone.id } };
  });
  on('GET', '/establishments/:id/zones', true, c => { estOk(c.params.id); return q('SELECT * FROM zones WHERE establishment_id=? ORDER BY sort', c.params.id).map(z => ({ ...z, points: q('SELECT id,code,label FROM reception_points WHERE zone_id=? AND active=1 ORDER BY code', z.id) })); });
  on('GET', '/reception-points/:id', true, c => { const p = one('SELECT p.*,z.name zone_name FROM reception_points p JOIN zones z ON z.id=p.zone_id WHERE p.id=?', c.params.id); if (!p) throw new E(404, 'NOT_FOUND'); estOk(p.establishment_id); return p; });
  function resolveQr(token) {
    const t = one('SELECT * FROM qr_tokens WHERE token=?', String(token));
    if (!t || !t.active || (t.expires_at && t.expires_at < now())) throw new E(404, 'QR_INVALID');
    const p = one('SELECT p.*,z.name zone_name FROM reception_points p JOIN zones z ON z.id=p.zone_id WHERE p.id=? AND p.active=1', t.reception_point_id);
    if (!p) throw new E(404, 'QR_INVALID');
    const e = one("SELECT id,name FROM establishments WHERE id=? AND status='ACTIVE'", p.establishment_id);
    if (!e) throw new E(404, 'ESTABLISHMENT_UNAVAILABLE');
    return { establishment: e, zone: p.zone_name, point: { id: p.id, code: p.code, label: p.label } };
  }
  on('GET', '/qr/:token', false, c => { limit(c, 'qr', 60, 60e3); return resolveQr(c.params.token); });
  on('GET', '/establishments/:id/qr', true, c => { need(c, c.params.id, 'MANAGER'); return q('SELECT t.token,t.active,p.id point_id,p.code,p.label,z.name zone FROM qr_tokens t JOIN reception_points p ON p.id=t.reception_point_id JOIN zones z ON z.id=p.zone_id WHERE p.establishment_id=?', c.params.id); });
  on('POST', '/reception-points/:id/qr/rotate', true, c => {
    const p = one('SELECT * FROM reception_points WHERE id=?', c.params.id); if (!p) throw new E(404, 'NOT_FOUND'); need(c, p.establishment_id, 'MANAGER');
    const token = rand(16); run('UPDATE qr_tokens SET active=0 WHERE reception_point_id=?', p.id); run('INSERT INTO qr_tokens VALUES(?,?,1,NULL,?)', token, p.id, now());
    audit(c, 'QR_ROTATED', 'reception_point', p.id); return { token };
  });
  on('DELETE', '/reception-points/:id', true, c => {
    const p = one('SELECT * FROM reception_points WHERE id=?', c.params.id); if (!p) throw new E(404, 'NOT_FOUND'); need(c, p.establishment_id, 'MANAGER');
    run('UPDATE reception_points SET active=0 WHERE id=?', p.id);
    audit(c, 'TABLE_DEACTIVATED', 'reception_point', p.id); return { ok: true };
  });
  on('PATCH', '/reception-points/:id', true, c => {
    const p = one('SELECT * FROM reception_points WHERE id=?', c.params.id); if (!p) throw new E(404, 'NOT_FOUND'); need(c, p.establishment_id, 'MANAGER');
    run('UPDATE reception_points SET label=? WHERE id=?', String(c.body.label || p.label).slice(0, 40), p.id);
    return { ok: true };
  });
  on('POST', '/establishments/:id/zones', true, c => { need(c, c.params.id, 'MANAGER'); const id = uid(); run('INSERT INTO zones VALUES(?,?,?,?)', id, c.params.id, String(c.body.name).trim().slice(0, 40), Number(c.body.sort) || 0); return { status: 201, body: { id } }; });
  on('POST', '/zones/:id/points', true, c => {
    const z = one('SELECT * FROM zones WHERE id=?', c.params.id); if (!z) throw new E(404, 'NOT_FOUND'); need(c, z.establishment_id, 'MANAGER');
    const id = uid(), token = rand(16);
    const code = String(c.body.code || '').trim().toUpperCase().slice(0, 15);
    if (!code) throw new E(400, 'BAD_REQUEST');
    run('INSERT INTO reception_points VALUES(?,?,?,?,?,1)', id, z.establishment_id, z.id, code, String(c.body.label || code).trim().slice(0, 40));
    run('INSERT INTO qr_tokens VALUES(?,?,1,NULL,?)', token, id, now()); return { status: 201, body: { id, token } };
  });
  on('POST', '/establishments/:id/invites', true, c => { need(c, c.params.id, 'MANAGER'); const role = c.body.role === 'MANAGER' ? 'MANAGER' : 'STAFF'; const code = mkInvite({ kind: 'ROLE', est: c.params.id, role, ttl: 86400e3 }); audit(c, 'EMPLOYEE_INVITED', 'establishment', c.params.id, { role }); return { status: 201, body: { code, role } }; });
  on('GET', '/establishments/:id/staff', true, c => { need(c, c.params.id, 'MANAGER'); return q('SELECT u.id,u.display_name,m.role FROM establishment_members m JOIN users u ON u.id=m.user_id WHERE m.establishment_id=?', c.params.id); });
  on('DELETE', '/establishments/:id/staff/:uid', true, c => { need(c, c.params.id, 'MANAGER'); run('DELETE FROM establishment_members WHERE user_id=? AND establishment_id=?', c.params.uid, c.params.id); audit(c, 'EMPLOYEE_REMOVED', 'user', c.params.uid); return { ok: true }; });

  // PRODUITS
  const stockOf = id => one('SELECT COALESCE(SUM(quantity),0) s FROM stock_movements WHERE product_id=?', id).s;
  on('GET', '/categories', true, c => q('SELECT * FROM categories WHERE establishment_id=? ORDER BY sort', String(c.query.get('establishment_id'))));
  on('GET', '/products', true, c => {
    const est = String(c.query.get('establishment_id')); estOk(est);
    return q("SELECT id,category_id,name,description,price,image,available,stock_tracking FROM products WHERE establishment_id=? AND status='ACTIVE'", est)
      .map(p => ({ ...p, stock: p.stock_tracking ? stockOf(p.id) : null, available: !!p.available && (!p.stock_tracking || stockOf(p.id) > 0) }));
  });
  on('POST', '/categories', true, c => { need(c, c.body.establishment_id, 'MANAGER'); if (!c.body.name) throw new E(400, 'BAD_REQUEST'); const id = uid(); run('INSERT INTO categories VALUES(?,?,?,?)', id, c.body.establishment_id, String(c.body.name).trim().slice(0, 40), Number(c.body.sort) || 0); return { status: 201, body: { id } }; });
  on('POST', '/products', true, c => {
    const b = c.body; need(c, b.establishment_id, 'MANAGER');
    if (!(Number.isInteger(b.price) && b.price >= 0 && b.price <= 100_000_000) || !b.name) throw new E(400, 'BAD_REQUEST');
    const id = uid(); run('INSERT INTO products VALUES(?,?,?,?,?,?,?,?,1,?,?,?,?)', id, b.establishment_id, b.category_id || null, String(b.name).trim().slice(0, 80), String(b.description || '').trim().slice(0, 200), b.price, b.image || null, String(b.aliases || '').slice(0, 200), b.stock_tracking ? 1 : 0, 'ACTIVE', now(), now());
    audit(c, 'PRODUCT_CREATED', 'product', id);
    broadcast('STOCK_UPDATE', { product_id: id, establishment_id: b.establishment_id });
    return { status: 201, body: { id } };
  });
  on('PATCH', '/products/:id', true, c => {
    const p = one('SELECT * FROM products WHERE id=?', c.params.id); if (!p) throw new E(404, 'NOT_FOUND'); need(c, p.establishment_id, 'MANAGER');
    const b = c.body;
    if (b.price !== undefined) {
      if (!(Number.isInteger(b.price) && b.price >= 0 && b.price <= 100_000_000)) throw new E(400, 'BAD_REQUEST');
      if (b.price !== p.price) audit(c, 'PRODUCT_PRICE_CHANGED', 'product', p.id, { from: p.price, to: b.price });
    }
    run('UPDATE products SET name=?,description=?,price=?,available=?,status=?,updated_at=? WHERE id=?', b.name ?? p.name, b.description ?? p.description, b.price ?? p.price, b.available === undefined ? p.available : +!!b.available, b.status ?? p.status, now(), p.id);
    broadcast('STOCK_UPDATE', { product_id: p.id, available: b.available !== undefined ? +!!b.available : p.available, price: b.price ?? p.price, establishment_id: p.establishment_id });
    return { ok: true };
  });
  on('DELETE', '/products/:id', true, c => {
    const p = one('SELECT * FROM products WHERE id=?', c.params.id); if (!p) throw new E(404, 'NOT_FOUND'); need(c, p.establishment_id, 'MANAGER');
    run("UPDATE products SET status='ARCHIVED',updated_at=? WHERE id=?", now(), p.id);
    audit(c, 'PRODUCT_ARCHIVED', 'product', p.id);
    broadcast('STOCK_UPDATE', { product_id: p.id, available: 0, establishment_id: p.establishment_id });
    return { ok: true };
  });

  // STOCK
  on('GET', '/inventory', true, c => { const est = String(c.query.get('establishment_id')); need(c, est, 'STAFF'); return q('SELECT id,name,stock_tracking FROM products WHERE establishment_id=?', est).map(p => ({ ...p, stock: stockOf(p.id) })); });
  on('POST', '/inventory/movements', true, c => {
    const b = c.body, p = one('SELECT * FROM products WHERE id=?', String(b.product_id)); if (!p) throw new E(404, 'NOT_FOUND'); need(c, p.establishment_id, 'MANAGER');
    if (!['INITIAL', 'PURCHASE', 'LOSS', 'ADJUSTMENT', 'RETURN'].includes(b.type) || !Number.isInteger(b.quantity) || b.quantity === 0 || Math.abs(b.quantity) > 100_000) throw new E(400, 'BAD_REQUEST');
    const qty = ['LOSS'].includes(b.type) ? -Math.abs(b.quantity) : ['INITIAL', 'PURCHASE', 'RETURN'].includes(b.type) ? Math.abs(b.quantity) : b.quantity;
    if (stockOf(p.id) + qty < 0) throw new E(409, 'NEGATIVE_STOCK');
    run('INSERT INTO stock_movements VALUES(?,?,?,?,?,?,?)', uid(), p.id, b.type, qty, String(b.reason || '').slice(0, 100), c.user.id, now());
    run('UPDATE products SET stock_tracking=1 WHERE id=?', p.id); audit(c, 'STOCK_ADJUSTED', 'product', p.id, { type: b.type, qty });
    const newStock = stockOf(p.id);
    broadcast('STOCK_UPDATE', { product_id: p.id, stock: newStock, establishment_id: p.establishment_id });
    return { status: 201, body: { stock: newStock } };
  });

  // COMMANDES
  const full = o => ({
    ...o,
    items: q('SELECT product_id,name,unit_price,quantity,total,note FROM order_items WHERE order_id=?', o.id),
    point: one('SELECT p.code,p.label,z.name zone FROM reception_points p JOIN zones z ON z.id=p.zone_id WHERE p.id=?', o.reception_point_id),
    voice: o.voice_message_id ? one('SELECT id,duration,transcription,confidence FROM voice_messages WHERE id=?', o.voice_message_id) : null
  });
  const setStatus = (c, o, next) => {
    run('UPDATE orders SET status=?,updated_at=? WHERE id=?', next, now(), o.id);
    run('INSERT INTO order_status_history VALUES(?,?,?,?,?,?,?)', uid(), o.id, o.status, next, c.user?.id || null, c.device?.id || null, now());
    if (['CANCELLED', 'REJECTED', 'EXPIRED'].includes(next)) for (const i of q('SELECT * FROM order_items WHERE order_id=?', o.id)) if (one('SELECT stock_tracking t FROM products WHERE id=?', i.product_id)?.t) run('INSERT INTO stock_movements VALUES(?,?,?,?,?,?,?)', uid(), i.product_id, 'RETURN', i.quantity, 'order ' + next, c.user?.id || null, now());
    if (next === 'CANCELLED') audit(c, 'ORDER_CANCELLED', 'order', o.id);
    notify({ user_id: o.user_id, order: o.id, type: next, message: MSG[next] });
    broadcast('ORDER_STATUS', { order_id: o.id, status: next, user_id: o.user_id, establishment_id: o.establishment_id, updated_at: now() });
  };
  const ORDER_TTL = 15 * 60e3; // une commande jamais prise en charge expire
  const expireStale = () => { for (const o of q("SELECT * FROM orders WHERE status='SUBMITTED' AND created_at<?", now() - ORDER_TTL)) tx(db, () => setStatus({ user: { id: null }, device: { id: null } }, o, 'EXPIRED')); };

  on('POST', '/orders', true, c => {
    limit(c, 'ord', 30, 60e3);
    const key = String(c.req.headers['idempotency-key'] || '').trim();
    if (key.length < 8 || key.length > 128) throw new E(400, 'IDEMPOTENCY_KEY_REQUIRED');
    const prev = one('SELECT order_id FROM idempotency_keys WHERE key=? AND user_id=?', key, c.user.id);
    if (prev) {
      const existing = one('SELECT * FROM orders WHERE id=?', prev.order_id);
      if (existing) return { status: 200, body: full(existing) };
    }
    const b = c.body; if (!Array.isArray(b.items) || !b.items.length || b.items.length > 50) throw new E(400, 'EMPTY_ORDER');
    let loc;
    if (b.qr_token) loc = resolveQr(b.qr_token);
    else {
      const p = one('SELECT p.*,z.name zone_name FROM reception_points p JOIN zones z ON z.id=p.zone_id WHERE p.id=? AND p.active=1', String(b.reception_point_id));
      if (!p) throw new E(404, 'QR_INVALID');
      loc = { establishment: estOk(p.establishment_id), point: { id: p.id, code: p.code }, manual: true };
    }

    return tx(db, () => {
      const id = uid(); let total = 0; const lines = [];
      // Fusionner les doublons d'articles dans la même requête
      const aggregated = new Map();
      for (const it of b.items) {
        const pid = String(it.product_id);
        const qty = it.quantity;
        if (!Number.isInteger(qty) || qty < 1 || qty > 99) throw new E(400, 'INVALID_ITEM');
        const prevAgg = aggregated.get(pid) || { qty: 0, note: String(it.note || '').slice(0, 120) };
        prevAgg.qty += qty;
        if (prevAgg.qty > 99) throw new E(400, 'INVALID_ITEM');
        aggregated.set(pid, prevAgg);
      }

      for (const [pid, { qty, note }] of aggregated) {
        const p = one("SELECT * FROM products WHERE id=? AND establishment_id=? AND status='ACTIVE' AND available=1", pid, loc.establishment.id);
        if (!p) throw new E(400, 'INVALID_ITEM');
        if (p.stock_tracking && stockOf(p.id) < qty) throw new E(409, 'OUT_OF_STOCK', p.name);
        lines.push([p, qty, note]);
        total += p.price * qty;
      }

      let vm = null;
      if (b.voice_message_id) {
        vm = one('SELECT * FROM voice_messages WHERE id=? AND user_id=? AND order_id IS NULL', String(b.voice_message_id), c.user.id);
        if (!vm) throw new E(400, 'INVALID_VOICE');
      }

      run('INSERT INTO orders VALUES(?,?,?,?,?,?,?,NULL,?,?,?,?,?)', id, loc.establishment.id, c.user.id, c.device.id, loc.point.id, 'SUBMITTED', 'UNPAID', total, String(b.note || '').slice(0, 200), vm?.id || null, now(), now());
      for (const [p, qty, note] of lines) {
        run('INSERT INTO order_items VALUES(?,?,?,?,?,?,?,?)', uid(), id, p.id, p.name, p.price, qty, p.price * qty, note);
        if (p.stock_tracking) run('INSERT INTO stock_movements VALUES(?,?,?,?,?,?,?)', uid(), p.id, 'SALE', -qty, 'order', c.user.id, now());
      }
      if (vm) run('UPDATE voice_messages SET order_id=? WHERE id=?', id, vm.id);
      run('INSERT INTO order_status_history VALUES(?,?,?,?,?,?,?)', uid(), id, null, 'SUBMITTED', c.user.id, c.device.id, now());
      run('INSERT INTO idempotency_keys VALUES(?,?,?)', key, c.user.id, id);
      if (loc.manual) audit(c, 'ORDER_MANUAL_TABLE', 'order', id);
      const newOrder = full(one('SELECT * FROM orders WHERE id=?', id));
      notify({ est: loc.establishment.id, order: id, type: 'NEW_ORDER', message: `Nouvelle commande ${loc.point.code}${loc.manual ? ' (table choisie à la main)' : ''}` });
      broadcast('NEW_ORDER', { order: newOrder, establishment_id: loc.establishment.id });
      return { status: 201, body: newOrder };
    });
  });

  const getOrder = (c) => {
    const o = one('SELECT * FROM orders WHERE id=?', c.params.id); if (!o) throw new E(404, 'NOT_FOUND');
    if (o.user_id !== c.user.id) need(c, o.establishment_id, 'STAFF'); return o;
  };
  on('GET', '/orders', true, c => {
    expireStale();
    const est = c.query.get('establishment_id');
    if (est) { need(c, est, 'STAFF'); const st = c.query.get('status'); return q(`SELECT * FROM orders WHERE establishment_id=? ${st ? 'AND status=?' : ''} ORDER BY created_at DESC LIMIT 200`, ...(st ? [est, st] : [est])).map(full); }
    return q('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 100', c.user.id).map(full);
  });
  on('GET', '/orders/:id', true, c => full(getOrder(c)));
  on('GET', '/orders/:id/status', true, c => { const o = getOrder(c); return { status: o.status, payment_status: o.payment_status, history: q('SELECT previous_status,new_status,created_at FROM order_status_history WHERE order_id=? ORDER BY created_at', o.id) }; });
  on('POST', '/orders/:id/cancel', true, c => {
    const o = getOrder(c); const staff = o.user_id !== c.user.id;
    if (!staff && o.status !== 'SUBMITTED') throw new E(409, 'CANNOT_CANCEL');
    if (!(FLOW[o.status] || []).includes('CANCELLED')) throw new E(409, 'CANNOT_CANCEL');
    tx(db, () => setStatus(c, o, 'CANCELLED')); return { ok: true };
  });
  on('POST', '/orders/:id/status', true, c => {
    const o = one('SELECT * FROM orders WHERE id=?', c.params.id); if (!o) throw new E(404, 'NOT_FOUND'); need(c, o.establishment_id, 'STAFF');
    const next = String(c.body.status);
    if (!(FLOW[o.status] || []).includes(next)) throw new E(409, 'INVALID_TRANSITION', `${o.status} -> ${next}`);
    if (next === 'COMPLETED' && o.payment_status !== 'PAID') throw new E(409, 'PAYMENT_REQUIRED');
    tx(db, () => setStatus(c, o, next)); return { status: next };
  });
  on('POST', '/orders/:id/payment', true, c => {
    const o = one('SELECT * FROM orders WHERE id=?', c.params.id); if (!o) throw new E(404, 'NOT_FOUND'); need(c, o.establishment_id, 'STAFF');
    const b = c.body; if (!PAYMENT_METHODS.includes(b.method)) throw new E(400, 'INVALID_METHOD');
    if (o.payment_status === 'PAID') throw new E(409, 'ALREADY_PAID'); if (['CANCELLED', 'REJECTED'].includes(o.status)) throw new E(409, 'ORDER_CLOSED');
    const amount = b.amount ?? o.total; if (!Number.isInteger(amount) || amount < o.total) throw new E(400, 'INVALID_AMOUNT');
    tx(db, () => {
      run('INSERT INTO payments VALUES(?,?,?,?,?,?,?)', uid(), o.id, b.method, o.total, 'PAID', c.user.id, now());
      run("UPDATE orders SET payment_status='PAID',payment_method=?,updated_at=? WHERE id=?", b.method, now(), o.id);
      audit(c, 'PAYMENT_VALIDATED', 'order', o.id, { method: b.method, amount: o.total });
      notify({ user_id: o.user_id, order: o.id, type: 'PAID', message: 'Paiement confirmé' });
      broadcast('ORDER_PAID', { order_id: o.id, payment_status: 'PAID', method: b.method, user_id: o.user_id, establishment_id: o.establishment_id });
    });
    return { payment_status: 'PAID' };
  });
  on('GET', '/payment-methods', true, () => PAYMENT_METHODS);

  // TEMPS RÉEL (Server-Sent Events)
  const handleEvents = (c, res) => {
    let authUser = null;
    const tok = c.query.get('token') || (c.req.headers.authorization || '').replace(/^Bearer /, '');
    if (tok) {
      try {
        const t = readToken(tok, secret, now());
        if (t) {
          const s = one('SELECT * FROM sessions WHERE id=?', t.sid);
          const d = one('SELECT * FROM devices WHERE id=?', t.did);
          const u = one('SELECT * FROM users WHERE id=?', t.sub);
          if (s && !s.revoked_at && d && d.status === 'ACTIVE' && u && u.status === 'ACTIVE') {
            authUser = { user: u, device: d };
          }
        }
      } catch {}
    }

    // Protection contre épuisement des connexions SSE par IP
    const clientIp = c.ip;
    let ipCount = 0;
    for (const client of sseClients) {
      if (client.ip === clientIp) ipCount++;
    }
    if (ipCount >= 10) {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'TOO_MANY_CONNECTIONS' }));
      return null;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'access-control-allow-origin': '*',
      'x-accel-buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    res.write(`event: connected\ndata: ${JSON.stringify({ ok: true, time: now() })}\n\n`);

    const client = { req: c.req, res, auth: authUser, ip: clientIp };
    sseClients.add(client);
    c.req.on('close', () => sseClients.delete(client));
    res.on('finish', () => sseClients.delete(client));
    return null;
  };
  on('GET', '/events', false, handleEvents);
  on('GET', '/realtime', false, handleEvents);

  // NOTIFICATIONS (polling de secours)
  on('GET', '/notifications', true, c => {
    const since = Number(c.query.get('since')) || 0, est = c.query.get('establishment_id');
    if (est) { need(c, est, 'STAFF'); return q('SELECT * FROM notifications WHERE establishment_id=? AND created_at>? ORDER BY created_at DESC LIMIT 50', est, since); }
    return q('SELECT * FROM notifications WHERE user_id=? AND created_at>? ORDER BY created_at DESC LIMIT 50', c.user.id, since);
  });

  // VOIX
  on('POST', '/voice/interpret', true, c => {
    limit(c, 'voi', 30, 60e3); const est = String(c.body.establishment_id); estOk(est);
    return interpret(String(c.body.text || '').slice(0, 500), q("SELECT id,name,aliases,price FROM products WHERE establishment_id=? AND status='ACTIVE' AND available=1", est));
  });
  on('POST', '/voice/messages', true, c => {
    const b = c.body, est = String(b.establishment_id); estOk(est);
    const buf = Buffer.from(String(b.audio_base64 || ''), 'base64');
    if (!buf.length || buf.length > 5e6) throw new E(400, 'BAD_AUDIO');
    const id = uid();
    const voiceDir = resolve(join(dataDir, 'voice'));
    mkdirSync(voiceDir, { recursive: true });
    const path = join(voiceDir, id + '.bin');
    writeFileSync(path, buf);
    run('INSERT INTO voice_messages VALUES(?,?,?,NULL,?,?,?,?,?,?)', id, est, c.user.id, path, Number(b.duration) || 0, String(b.language || 'fr').slice(0, 8), String(b.transcription || '').slice(0, 500), Number(b.confidence) || 0, now());
    return { status: 201, body: { id } };
  });
  on('GET', '/voice/:id/audio', true, c => {
    const v = one('SELECT * FROM voice_messages WHERE id=?', c.params.id); if (!v) throw new E(404, 'NOT_FOUND');
    if (v.user_id !== c.user.id) need(c, v.establishment_id, 'STAFF');
    const safeVoiceDir = resolve(join(dataDir, 'voice'));
    const safePath = resolve(v.audio_path);
    if (!safePath.startsWith(safeVoiceDir + sep) || !existsSync(safePath)) throw new E(404, 'NOT_FOUND');
    const rawType = String(c.query.get('type') || 'audio/webm');
    const safeType = ALLOWED_AUDIO_MIMES.includes(rawType) ? rawType : 'audio/webm';
    return { raw: readFileSync(safePath), type: safeType };
  });

  // STATS
  on('GET', '/statistics', true, c => {
    const est = String(c.query.get('establishment_id')); need(c, est, 'MANAGER');
    return {
      orders: q('SELECT status,COUNT(*) n,SUM(total) total FROM orders WHERE establishment_id=? GROUP BY status', est),
      revenue_paid: one("SELECT COALESCE(SUM(total),0) t FROM orders WHERE establishment_id=? AND payment_status='PAID'", est).t,
      top_products: q("SELECT i.name,SUM(i.quantity) qty FROM order_items i JOIN orders o ON o.id=i.order_id WHERE o.establishment_id=? AND o.status NOT IN ('CANCELLED','REJECTED') GROUP BY i.name ORDER BY qty DESC LIMIT 5", est),
    };
  });

  // ---------- serveur HTTP & Sécurité Statique ----------
  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2'
  };
  const timer = setInterval(expireStale, 60e3); timer.unref();

  return async function handler(req, res) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
        'access-control-allow-headers': 'content-type, authorization, idempotency-key',
        'access-control-max-age': '86400'
      });
      return res.end();
    }

    const forwarded = req.headers['x-forwarded-for'];
    const ip = (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : null) || req.socket?.remoteAddress || '127.0.0.1';
    const url = new URL(req.url, 'http://x');

    const send = (st, body, type = 'application/json') => {
      res.writeHead(st, {
        'content-type': type,
        'access-control-allow-origin': '*',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'x-frame-options': 'DENY',
        'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; media-src 'self' blob: data:; img-src 'self' data: https: blob:; connect-src 'self' *; frame-ancestors 'none'; object-src 'none'",
        'cache-control': 'no-store'
      });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };

    try {
      const r = routes.find(r => r.m === req.method && r.re.test(url.pathname));
      if (!r) {
        // Sécurisation stricte contre le Path Traversal
        if (webDir && req.method === 'GET') {
          const hostHeader = String(req.headers['host'] || '').toLowerCase();
          const isVendorSubdomain = hostHeader.startsWith('vendeur.') || hostHeader.startsWith('pro.');
          const vendorDir = join(resolve(webDir), '..', 'web-vendeur');
          const safeRoot = isVendorSubdomain && existsSync(vendorDir) ? resolve(vendorDir) : resolve(webDir);
          let reqPath = '/';
          try {
            reqPath = decodeURIComponent(url.pathname);
          } catch {}
          if (reqPath.includes('\0')) throw new E(400, 'BAD_REQUEST');
          const targetFile = resolve(join(safeRoot, reqPath === '/' ? 'index.html' : reqPath));
          if ((targetFile.startsWith(safeRoot + sep) || targetFile === safeRoot) && existsSync(targetFile) && statSync(targetFile).isFile()) {
            res.writeHead(200, {
              'content-type': MIME[extname(targetFile)] || 'application/octet-stream',
              'access-control-allow-origin': '*',
              'x-content-type-options': 'nosniff',
              'referrer-policy': 'no-referrer',
              'x-frame-options': 'DENY',
              'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; media-src 'self' blob: data:; img-src 'self' data: https: blob:; connect-src 'self' *; frame-ancestors 'none'; object-src 'none'",
              'cache-control': 'public, max-age=3600'
            });
            return createReadStream(targetFile).pipe(res);
          }
        }
        throw new E(404, 'NOT_FOUND');
      }

      let body = {};
      if (['POST', 'PATCH', 'PUT'].includes(req.method)) {
        const chunks = []; let n = 0;
        for await (const ch of req) { n += ch.length; if (n > 5e6) throw new E(413, 'TOO_LARGE'); chunks.push(ch); }
        try { body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}; } catch { throw new E(400, 'BAD_JSON'); }
      }
      const ctx = { req, ip, body, query: url.searchParams, params: r.re.exec(url.pathname).groups || {} };
      if (r.auth) Object.assign(ctx, authenticate(req));
      const out = await r.fn(ctx, res);
      if (out === null || (out === undefined && res.writableEnded)) return;
      if (out?.raw) return send(200, out.raw, out.type);
      if (out?.status && out.body !== undefined) return send(out.status, out.body);
      send(200, out);
    } catch (e) {
      if (res.writableEnded) return;
      if (e instanceof E) return send(e.status, { error: e.code, message: e.message });
      console.error('ERR', e.message); send(500, { error: 'INTERNAL' });
    }
  };
}
