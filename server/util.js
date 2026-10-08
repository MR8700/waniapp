import { createHash, createHmac, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from 'node:crypto';

export const uid = () => randomUUID();
export const sha = s => createHash('sha256').update(String(s || '')).digest('hex');
export const rand = (n = 32) => randomBytes(n).toString('base64url');

export class HttpError extends Error {
  constructor(status, code, msg) {
    super(msg || code);
    this.status = status;
    this.code = code;
  }
}

export function verifySig(pubB64, msg, sigB64) {
  try {
    if (!pubB64 || !msg || !sigB64) return false;
    const key = createPublicKey({ key: Buffer.from(pubB64, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return false;
    return verify('sha256', Buffer.from(msg), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sigB64, 'base64'));
  } catch {
    return false;
  }
}

export function signToken(payload, secret) {
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return p + '.' + createHmac('sha256', secret).update(p).digest('base64url');
}

export function readToken(tok, secret, now) {
  try {
    const parts = String(tok || '').split('.');
    if (parts.length !== 2) return null;
    const [p, s] = parts;
    if (!p || !s) return null;

    const exp = createHmac('sha256', secret).update(p).digest('base64url');
    const bufS = Buffer.from(s);
    const bufExp = Buffer.from(exp);
    if (bufS.length !== bufExp.length || !timingSafeEqual(bufS, bufExp)) return null;

    const jsonStr = Buffer.from(p, 'base64url').toString('utf8');
    const d = JSON.parse(jsonStr);
    if (typeof d !== 'object' || d === null || typeof d.exp !== 'number') return null;
    return d.exp > now ? d : null;
  } catch {
    return null;
  }
}

export function limiter() {
  const hits = new Map();
  return (key, max, windowMs, now) => {
    const cleanKey = String(key || 'anon');
    const a = (hits.get(cleanKey) || []).filter(t => now - t < windowMs);
    if (a.length >= max) {
      hits.set(cleanKey, a);
      return false;
    }
    a.push(now);
    hits.set(cleanKey, a);
    if (hits.size > 5000) {
      for (const [k, v] of hits) {
        if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
      }
    }
    return true;
  };
}
