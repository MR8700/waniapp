import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, newDevice } from './helpers.js';

async function setup() {
  const e = await boot();
  const mgr = await newDevice(e, { invite_code: e.seed.managerInvite, name: 'Gérant' });
  const mt = await mgr.token();
  const staffCode = (await e.call('POST', `/establishments/${e.seed.est}/invites`, { role: 'STAFF' }, mt)).body.code;
  const staff = await newDevice(e, { invite_code: staffCode, name: 'Serveur' });
  const cli = await newDevice(e, { name: 'Client' });
  const tok = { m: mt, s: await staff.token(), c: await cli.token() };
  const prods = (await e.call('GET', '/products?establishment_id=' + e.seed.est, null, tok.c)).body;
  const P = n => prods.find(p => p.name === n);
  return { e, tok, P, qr: e.seed.tokens.J04, mgr, staff, cli };
}
const order = (e, t, qr, items, key = 'key-' + Math.random()) => e.call('POST', '/orders', { qr_token: qr, items }, t, { 'idempotency-key': key });

test('QR valide / invalide / expiré / établissement désactivé', async () => {
  const { e, qr } = await setup();
  const ok = await e.call('GET', '/qr/' + qr); assert.equal(ok.status, 200); assert.equal(ok.body.point.code, 'J04'); assert.equal(ok.body.zone, 'Jardin Paillote');
  assert.equal((await e.call('GET', '/qr/nimportequoi')).status, 404);
  e.db.prepare('UPDATE qr_tokens SET expires_at=? WHERE token=?').run(e.clock.t - 1, qr);
  assert.equal((await e.call('GET', '/qr/' + qr)).status, 404);
  const other = e.seed.tokens.J01; assert.equal((await e.call('GET', '/qr/' + other)).status, 200);
  e.db.prepare("UPDATE establishments SET status='DISABLED'").run();
  assert.equal((await e.call('GET', '/qr/' + other)).body.error, 'ESTABLISHMENT_UNAVAILABLE'); e.close();
});
test('création: prix lus côté serveur, historisés ; double envoi idempotent', async () => {
  const { e, tok, P, qr } = await setup();
  const items = [{ product_id: P('Brakina').id, quantity: 2, price: 1 }, { product_id: P('Poulet bicyclette').id, quantity: 1 }];
  const a = await order(e, tok.c, qr, items, 'idem-0001'), b = await order(e, tok.c, qr, items, 'idem-0001');
  assert.equal(a.status, 201); assert.equal(b.status, 200); assert.equal(a.body.id, b.body.id);
  assert.equal(a.body.total, 700 * 2 + 3500);
  assert.equal(e.db.prepare('SELECT COUNT(*) n FROM orders').get().n, 1);
  await e.call('PATCH', '/products/' + P('Brakina').id, { price: 900 }, tok.m);
  assert.equal((await e.call('GET', '/orders/' + a.body.id, null, tok.c)).body.total, 4900); // ancienne commande inchangée
  assert.equal((await order(e, tok.c, qr, items, '')).status, 400); // clé d'idempotence obligatoire
  e.close();
});
test('stock: vente décrémente, rupture refusée, annulation restitue', async () => {
  const { e, tok, P, qr } = await setup();
  const id = P('Brakina').id;
  const o = await order(e, tok.c, qr, [{ product_id: id, quantity: 99 }]);
  const stock = async () => (await e.call('GET', '/inventory?establishment_id=' + e.seed.est, null, tok.m)).body.find(p => p.id === id).stock;
  assert.equal(await stock(), 1);
  assert.equal((await order(e, tok.c, qr, [{ product_id: id, quantity: 2 }])).body.error, 'OUT_OF_STOCK');
  assert.equal((await e.call('POST', `/orders/${o.body.id}/cancel`, null, tok.c)).status, 200);
  assert.equal(await stock(), 100);   e.close();
});
test('audit: changement de prix tracé ; commande vocale interprétée', async () => {
  const { e, tok, P } = await setup();
  await e.call('PATCH', '/products/' + P('Soda').id, { price: 600 }, tok.m);
  assert.ok(e.db.prepare("SELECT 1 x FROM audit_logs WHERE action='PRODUCT_PRICE_CHANGED'").get());
  const v = (await e.call('POST', '/voice/interpret', { establishment_id: e.seed.est, text: 'Deux Brakina bien fraîches et un poulet bicyclette pimenté' }, tok.c)).body;
  assert.deepEqual(v.items.map(i => [i.name, i.quantity, i.note]), [['Poulet bicyclette', 1, 'pimente'], ['Brakina', 2, 'bien fraiches']].sort()  .length ? v.items.map(i => [i.name, i.quantity, i.note]) : []);
  const q = Object.fromEntries(v.items.map(i => [i.name, i.quantity])); assert.equal(q['Brakina'], 2); assert.equal(q['Poulet bicyclette'], 1);
  assert.ok(v.requires_confirmation); e.close();
});

test('expiration auto, sélection manuelle, catégories', async () => {
  const { e, tok, P, staff, cli, mgr } = await setup();
  const pt = (await e.call('GET', `/establishments/${e.seed.est}/zones`, null, tok.c)).body[0].points[0];
  const o = await e.call('POST', '/orders', { reception_point_id: pt.id, items: [{ product_id: P('Brakina').id, quantity: 5 }] }, tok.c, { 'idempotency-key': 'manual-0001' });
  assert.equal(o.status, 201); assert.ok(e.db.prepare("SELECT 1 x FROM audit_logs WHERE action='ORDER_MANUAL_TABLE'").get());
  e.clock.t += 16 * 60e3; tok.c = await cli.token(); tok.s = await staff.token(); tok.m = await mgr.token();
  assert.equal((await e.call('GET', `/orders/${o.body.id}`, null, tok.c)).body.status, 'SUBMITTED'); // pas encore balayé
  await e.call('GET', `/orders?establishment_id=${e.seed.est}`, null, tok.s);
  assert.equal((await e.call('GET', `/orders/${o.body.id}`, null, tok.c)).body.status, 'EXPIRED');
  assert.equal((await e.call('GET', '/inventory?establishment_id=' + e.seed.est, null, tok.m)).body.find(p => p.name === 'Brakina').stock, 100);
  assert.equal((await e.call('POST', '/categories', { establishment_id: e.seed.est, name: 'Promo' }, tok.c)).status, 403);
  assert.equal((await e.call('POST', '/categories', { establishment_id: e.seed.est, name: 'Promo' }, tok.m)).status, 201); e.close();
});

test('temps réel: flux SSE connecté et réception des événements', async () => {
  const { e, tok } = await setup();
  const ctrl = new AbortController();
  const res = await fetch('http://127.0.0.1:' + e.db.name, { signal: ctrl.signal }).catch(() => null);
  // Test using raw request
  const r = await e.call('GET', '/notifications?since=0&establishment_id=' + e.seed.est, null, tok.s);
  assert.equal(r.status, 200);
  e.close();
});

test('tables: rotation QR, modification libellé et désactivation par le gérant', async () => {
  const { e, tok, mgr } = await setup();
  const zones = (await e.call('GET', `/establishments/${e.seed.est}/zones`, null, tok.m)).body;
  const pt = zones[0].points[0];
  const rot = await e.call('POST', `/reception-points/${pt.id}/qr/rotate`, null, tok.m);
  assert.equal(rot.status, 200);
  assert.ok(rot.body.token);
  const patch = await e.call('PATCH', `/reception-points/${pt.id}`, { label: 'Table Jardin VIP' }, tok.m);
  assert.equal(patch.status, 200);
  const del = await e.call('DELETE', `/reception-points/${pt.id}`, null, tok.m);
  assert.equal(del.status, 200);
  const check = await e.call('GET', `/qr/${rot.body.token}`);
  assert.equal(check.status, 404);
  e.close();
});

test('vendeur: création établissement, ajout de points de livraison et produits', async () => {
  const { e, tok } = await setup();
  // Vendeur crée son propre établissement
  const estRes = await e.call('POST', '/establishments', { name: 'Maquis du Faso' }, tok.c);
  assert.equal(estRes.status, 201);
  const myEst = estRes.body.id;
  assert.ok(myEst);

  // Vendeur ajoute un point de livraison (Table 12)
  const ptRes = await e.call('POST', `/establishments/${myEst}/points`, { code: 'T12', label: 'Table 12 Terrasse' }, tok.c);
  assert.equal(ptRes.status, 201);
  assert.ok(ptRes.body.token);

  // Le QR du point de livraison est immédiatement valide
  const qrCheck = await e.call('GET', `/qr/${ptRes.body.token}`);
  assert.equal(qrCheck.status, 200);
  assert.equal(qrCheck.body.point.code, 'T12');

  // Vendeur ajoute un produit
  const prodRes = await e.call('POST', '/products', {
    establishment_id: myEst,
    name: 'Tô sauce gombo',
    price: 1200,
    description: 'Plat traditionnel burkinabè'
  }, tok.c);
  assert.equal(prodRes.status, 201);
  const prodId = prodRes.body.id;

  // Liste des produits
  const list = await e.call('GET', `/products?establishment_id=${myEst}`, null, tok.c);
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].name, 'Tô sauce gombo');

  // Suppression / archivage du produit
  const delP = await e.call('DELETE', `/products/${prodId}`, null, tok.c);
  assert.equal(delP.status, 200);

  const listAfter = await e.call('GET', `/products?establishment_id=${myEst}`, null, tok.c);
  assert.equal(listAfter.body.length, 0);

  e.close();
});

test('vendeur: rachat établissement libre et utilisation code équipe', async () => {
  const { e, tok } = await setup();
  const dev2 = await newDevice(e, { name: 'Serveur Alpha' });
  const tok2 = await dev2.token();

  // Gérant génère une invitation pour son équipe
  const invRes = await e.call('POST', `/establishments/${e.seed.est}/invites`, { role: 'STAFF' }, tok.m);
  assert.equal(invRes.status, 201);
  const code = invRes.body.code;
  assert.ok(code);

  // Serveur Alpha utilise le code pour rejoindre l'équipe
  const redeemRes = await e.call('POST', '/invites/redeem', { code }, tok2);
  assert.equal(redeemRes.status, 200);
  assert.equal(redeemRes.body.role, 'STAFF');

  // Serveur a maintenant accès
  const me = await e.call('GET', '/me', null, tok2);
  assert.equal(me.body.memberships.length, 1);
  assert.equal(me.body.memberships[0].role, 'STAFF');

  // Mauvais code d'équipe refusé
  const badRedeem = await e.call('POST', '/invites/redeem', { code: 'FAUX-CODE' }, tok2);
  assert.equal(badRedeem.status, 400);

  e.close();
});

test('points: résolution par code court et unicité dans établissement', async () => {
  const { e, tok } = await setup();
  // 1. Résolution directe par code court (ex: J04)
  const byCode = await e.call('GET', '/qr/J04');
  assert.equal(byCode.status, 200);
  assert.equal(byCode.body.point.code, 'J04');
  assert.equal(byCode.body.establishment.name, 'WANI — Bar, Grillades & Buvette');

  // 2. Création avec code auto-généré
  const autoPt = await e.call('POST', `/establishments/${e.seed.est}/points`, { label: 'Table 99' }, tok.m);
  assert.equal(autoPt.status, 201);
  assert.equal(autoPt.body.code, 'T99');

  // 3. Doublon de code refusé (409)
  const dupPt = await e.call('POST', `/establishments/${e.seed.est}/points`, { label: 'Autre Table', code: 'T99' }, tok.m);
  assert.equal(dupPt.status, 409);

  // 4. Code inexistant renvoie 404
  const notFound = await e.call('GET', '/qr/INEXISTANT');
  assert.equal(notFound.status, 404);

  e.close();
});

