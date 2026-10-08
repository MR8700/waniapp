/**
 * WANI Vendeur — Tableau de bord Gérant, Barman & Comptoir
 * Gestion des points de livraison, menus réels et commandes en temps réel avec carillon sonore
 */

import { API_BASE } from './config.js';
import * as KS from './keystore.js';

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fcfa = n => (Number(n) || 0).toLocaleString('fr-FR') + ' FCFA';
const app = $('#app');

const LS = {
  get: (k, d = null) => { try { const v = localStorage.getItem('wv_' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('wv_' + k, JSON.stringify(v)); } catch {} },
  del: k => { try { localStorage.removeItem('wv_' + k); } catch {} }
};

const S = {
  tokens: LS.get('auth', null),
  me: null,
  currentEst: LS.get('current_est', null),
  orders: [],
  products: [],
  categories: [],
  points: [],
  stream: null,
  serviceOpen: true,
  audioCtx: null
};

// ==========================================
// CLIENT API & AUTHENTIFICATION
// ==========================================
async function raw(method, path, body = null, token = null) {
  const h = { 'content-type': 'application/json' };
  if (token) h['authorization'] = 'Bearer ' + token;
  const res = await fetch(API_BASE + path, {
    method,
    headers: h,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const err = new Error(json?.message || `Erreur ${res.status}`);
    err.code = json?.code;
    err.status = res.status;
    throw err;
  }
  return json;
}

async function api(method, path, body = null) {
  if (!S.tokens?.access) throw new Error('NON_AUTHENTIFIE');
  try {
    return await raw(method, path, body, S.tokens.access);
  } catch (err) {
    if (err.status === 401 && S.tokens.refresh) {
      await refresh();
      return await raw(method, path, body, S.tokens.access);
    }
    throw err;
  }
}

async function refresh() {
  if (!S.tokens?.refresh) throw new Error('SESSION_EXPIREE');
  try {
    const r = await raw('POST', '/auth/session/refresh', { refresh_token: S.tokens.refresh });
    S.tokens = { access: r.access_token, refresh: r.refresh_token };
    LS.set('auth', S.tokens);
  } catch (e) {
    S.tokens = null;
    LS.del('auth');
    throw e;
  }
}

async function register(displayName, inviteCode = '') {
  const pk = await KS.getPublicKeyBase64();
  const did = await KS.getDeviceId();
  const regSig = await KS.signAuth(`register|${did}|${pk}`);
  return await raw('POST', '/auth/device/register', {
    device_id: did,
    public_key: pk,
    device_name: 'Terminal Vendeur',
    platform: 'web',
    display_name: displayName || 'Vendeur',
    invite_code: inviteCode || undefined,
    registration_signature: regSig
  });
}

async function login() {
  const did = await KS.getDeviceId();
  const ch = await raw('POST', '/auth/device/challenge', { device_id: did });
  const sig = await KS.signAuth(`auth|${did}|${ch.nonce}`);
  const r = await raw('POST', '/auth/device/verify', {
    device_id: did,
    nonce: ch.nonce,
    signature: sig
  });
  S.tokens = { access: r.access_token, refresh: r.refresh_token };
  LS.set('auth', S.tokens);
  await loadMe();
}

async function loadMe() {
  if (!S.tokens?.access) return;
  S.me = await api('GET', '/me');
  if (S.me?.memberships?.length) {
    if (!S.currentEst || !S.me.memberships.find(m => m.establishment_id === S.currentEst.id)) {
      S.currentEst = {
        id: S.me.memberships[0].establishment_id,
        name: S.me.memberships[0].name,
        role: S.me.memberships[0].role
      };
      LS.set('current_est', S.currentEst);
    }
  }
}

// ==========================================
// CARILLON SONORE WEB AUDIO
// ==========================================
function playOrderChime() {
  try {
    const ctx = S.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    S.audioCtx = ctx;
    if (ctx.state === 'suspended') ctx.resume();

    const t = ctx.currentTime;
    const osc1 = ctx.createOscillator(), g1 = ctx.createGain();
    osc1.type = 'sine'; osc1.frequency.setValueAtTime(587.33, t); // Ré 5
    g1.gain.setValueAtTime(0.2, t); g1.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    osc1.connect(g1); g1.connect(ctx.destination);
    osc1.start(t); osc1.stop(t + 0.45);

    const osc2 = ctx.createOscillator(), g2 = ctx.createGain();
    osc2.type = 'triangle'; osc2.frequency.setValueAtTime(880, t + 0.12); // La 5
    g2.gain.setValueAtTime(0.25, t + 0.12); g2.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
    osc2.connect(g2); g2.connect(ctx.destination);
    osc2.start(t + 0.12); osc2.stop(t + 0.7);
  } catch {}
}

// ==========================================
// TEMPS RÉEL (SSE)
// ==========================================
function connectSse() {
  if (S.stream || !S.tokens?.access || !S.currentEst) return;
  const url = `${API_BASE}/events?token=${encodeURIComponent(S.tokens.access)}&establishment_id=${S.currentEst.id}`;
  try {
    const es = new EventSource(url);
    S.stream = es;
    es.addEventListener('NEW_ORDER', () => {
      playOrderChime();
      toast('🔔 Nouvelle commande reçue !', 'ok');
      if (location.hash === '#/' || location.hash === '#/orders') loadOrders();
    });
    es.addEventListener('ORDER_STATUS', () => {
      if (location.hash === '#/' || location.hash === '#/orders') loadOrders();
    });
    es.onerror = () => {
      es.close();
      S.stream = null;
      setTimeout(connectSse, 5000);
    };
  } catch {}
}

function toast(msg, type = 'ok') {
  const d = document.createElement('div');
  d.className = `toast ${type}`;
  d.textContent = msg;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 3200);
}

function shell(title, body, active = '') {
  app.innerHTML = `
    <header class="app-header" style="background:#042f2e;color:#fff;border-bottom-color:#115e59">
      <div class="row" style="width:100%;justify-content:space-between;align-items:center">
        <div class="row" style="gap:8px;align-items:center">
          <div style="width:32px;height:32px;border-radius:8px;background:#0d9488;color:#fff;display:grid;place-items:center;font-weight:900;font-family:var(--hd)">W</div>
          <div>
            <b class="hd" style="font-size:1.1rem;color:#fff">${esc(title)}</b>
            <div style="font-size:0.75rem;color:#5eead4">${esc(S.currentEst?.name || 'Vendeur')}</div>
          </div>
        </div>
        <div class="row" style="gap:6px">
          <button class="sm sec" id="toggle-service-btn" style="background:${S.serviceOpen ? '#059669' : '#dc2626'};color:#fff;border:none">
            ${S.serviceOpen ? '● Ouvert' : '■ En pause'}
          </button>
        </div>
      </div>
    </header>
    <main class="col" style="padding-top:14px;padding-bottom:24px">${body}</main>
    <nav class="nav" style="background:#042f2e;border-top-color:#115e59">
      <a href="#/orders" class="${active === 'orders' ? 'on' : ''}" style="color:${active === 'orders' ? '#2dd4bf' : '#99f6e4'}">
        <span class="material-symbols-outlined">receipt_long</span>Commandes
      </a>
      <a href="#/tables" class="${active === 'tables' ? 'on' : ''}" style="color:${active === 'tables' ? '#2dd4bf' : '#99f6e4'}">
        <span class="material-symbols-outlined">table_restaurant</span>Tables & QR
      </a>
      <a href="#/menu" class="${active === 'menu' ? 'on' : ''}" style="color:${active === 'menu' ? '#2dd4bf' : '#99f6e4'}">
        <span class="material-symbols-outlined">restaurant</span>Produits
      </a>
      <a href="#/stats" class="${active === 'stats' ? 'on' : ''}" style="color:${active === 'stats' ? '#2dd4bf' : '#99f6e4'}">
        <span class="material-symbols-outlined">analytics</span>Bilan
      </a>
    </nav>
  `;

  $('#toggle-service-btn')?.addEventListener('click', () => {
    S.serviceOpen = !S.serviceOpen;
    toast(S.serviceOpen ? 'Service ouvert aux clients' : 'Service en pause');
    shell(title, body, active);
  });
}

// ==========================================
// ÉCRAN 1 : CONNEXION SANS MOT DE PASSE (ZÉRO JARGON)
// ==========================================
function welcome(err = '') {
  app.innerHTML = `
    <main class="col" style="padding-top:40px;text-align:center">
      <div style="width:76px;height:76px;margin:0 auto 12px;border-radius:50%;background:linear-gradient(135deg,#0d9488,#042f2e);display:grid;place-items:center;box-shadow:0 8px 24px rgba(13,148,136,0.3);border:3px solid #fff;color:#fff">
        <span class="material-symbols-outlined text-[40px]">store</span>
      </div>
      <h1 style="font-size:2rem;font-weight:900;justify-content:center;color:var(--tx)">WANI Vendeur</h1>
      <div style="font-size:0.85rem;color:#0f766e;font-weight:800;margin:-6px auto 14px;text-transform:uppercase;letter-spacing:1px">Espace Gestion &amp; Barman</div>
      
      <p class="muted" style="margin:0 auto 20px;max-width:360px">
        Connexion rapide et sécurisée sans mot de passe. Gérez vos points de livraison, vos produits et recevez vos commandes en direct.
      </p>

      <div class="card col" style="text-align:left">
        <label class="muted" style="font-weight:700">Votre Nom ou Prénom</label>
        <input id="v-name" placeholder="Ex: Jean (Gérant), Aminata..." autocomplete="given-name">

        <label class="muted" style="font-weight:700;margin-top:6px">Code d'équipe (facultatif si vous êtes déjà invité)</label>
        <input id="v-code" placeholder="Code d'association (ex: XXXXX-XXXXX)">

        <button class="big" id="v-start-btn" style="margin-top:10px;background:#0f766e">Accéder à mon espace vendeur</button>
        ${err ? `<p style="color:var(--er);margin:8px 0 0;font-size:0.85rem;font-weight:600">${esc(err)}</p>` : ''}
      </div>

      <div style="margin-top:20px;font-size:0.85rem;color:var(--tx-muted)">
        Nouveau vendeur ? Cliquez sur accéder pour enregistrer votre lieu de vente en 1 clic.
      </div>
    </main>
  `;

  $('#v-start-btn').onclick = async () => {
    $('#v-start-btn').disabled = true;
    try {
      const name = $('#v-name').value.trim() || 'Vendeur';
      const code = $('#v-code').value.trim();
      await register(name, code);
      await login();
      location.hash = '#/orders';
      route();
    } catch (e) {
      welcome('Impossible d\'accéder : ' + e.message);
    }
  };
}

// ==========================================
// CRÉATION DE L'ÉTABLISSEMENT SI NOUVEAU VENDEUR
// ==========================================
function createEstablishmentModal() {
  const m = document.createElement('div');
  m.className = 'modal-back';
  m.innerHTML = `
    <div class="modal-box col" style="max-width:440px">
      <b class="hd" style="font-size:1.25rem">Créer votre lieu de vente</b>
      <p class="muted" style="margin:4px 0 14px">Donnez un nom à votre buvette, maquis, bar ou restaurant pour commencer à recevoir des commandes.</p>

      <label class="muted" style="font-weight:700">Nom de l'établissement</label>
      <input id="new-est-name" placeholder="Ex: Maquis La Paillote, Bar VIP...">

      <button class="big" id="save-est-btn" style="margin-top:14px;background:#0f766e">Créer mon établissement</button>
    </div>
  `;
  document.body.appendChild(m);

  $('#save-est-btn').onclick = async () => {
    const name = $('#new-est-name').value.trim();
    if (!name) return alert('Veuillez entrer le nom de votre établissement.');
    try {
      const r = await api('POST', '/establishments', { name });
      S.currentEst = { id: r.id, name: r.name, role: 'MANAGER' };
      LS.set('current_est', S.currentEst);
      m.remove();
      toast('Établissement créé avec succès !');
      route();
    } catch (err) {
      alert('Erreur : ' + err.message);
    }
  };
}

// ==========================================
// ÉCRAN 2 : RÉCEPTION DES COMMANDES EN TEMPS RÉEL
// ==========================================
async function loadOrders() {
  if (!S.currentEst) return;
  try {
    const list = await api('GET', `/orders?establishment_id=${S.currentEst.id}`);
    S.orders = list || [];
    renderOrders();
  } catch {}
}

function renderOrders() {
  const activeOrders = S.orders.filter(o => !['COMPLETED', 'CANCELLED', 'REJECTED'].includes(o.status));

  shell('Commandes en Direct', `
    <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:8px">
      <b style="font-size:1.15rem">${activeOrders.length} commande(s) en cours</b>
      <button class="sm sec" id="refresh-orders-btn">🔄 Actualiser</button>
    </div>

    ${activeOrders.length ? `
      <div class="col" style="gap:12px">
        ${activeOrders.map(o => `
          <div class="card col" style="border-left:5px solid ${o.status === 'SUBMITTED' ? '#ea580c' : o.status === 'RECEIVED' ? '#0284c7' : '#059669'}">
            <div class="row" style="justify-content:space-between;align-items:flex-start">
              <div>
                <b class="hd" style="font-size:1.25rem">Table ${esc(o.point?.label || o.reception_point_id)}</b>
                <div class="muted" style="font-size:0.8rem">${new Date(o.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
              </div>
              <span class="badge ${o.status === 'SUBMITTED' ? 'orange' : 'g'}">
                ${o.status === 'SUBMITTED' ? 'À confirmer' : o.status === 'RECEIVED' ? 'Reçue' : o.status === 'PREPARING' ? 'En cuisine' : 'Prête'}
              </span>
            </div>

            <!-- Articles -->
            <div class="col" style="gap:4px;margin:10px 0;padding:8px;background:#f8fafc;border-radius:8px">
              ${(o.items || []).map(i => `
                <div class="row" style="justify-content:space-between;font-size:0.95rem">
                  <span><strong>${i.quantity}×</strong> ${esc(i.name)}</span>
                  <b>${fcfa(i.total || (i.unit_price * i.quantity))}</b>
                </div>
              `).join('')}
              ${o.note ? `<div style="font-size:0.82rem;color:var(--p);margin-top:4px">📝 Note: ${esc(o.note)}</div>` : ''}
              <div class="row" style="justify-content:space-between;border-top:1px solid #e2e8f0;padding-top:4px;margin-top:4px;font-weight:900">
                <span>Total :</span>
                <span>${fcfa(o.total)}</span>
              </div>
            </div>

            <!-- Actions Vendeur Directes -->
            <div class="row" style="gap:8px;flex-wrap:wrap">
              ${o.status === 'SUBMITTED' ? `
                <button class="ok sm" data-status-btn="${o.id}:RECEIVED" style="flex:1;background:#059669;color:#fff">
                  ✓ Confirmer (Reçue)
                </button>
              ` : ''}
              ${o.status === 'RECEIVED' ? `
                <button class="sm ok" data-pay-btn="${o.id}:${o.total}" style="flex:1;background:#0f766e;color:#fff">
                  💳 Encaisser &amp; Clôturer (${fcfa(o.total)})
                </button>
              ` : ''}
              <button class="sec sm" data-cancel-btn="${o.id}" style="color:var(--er)">Refuser</button>
            </div>
          </div>
        `).join('')}
      </div>
    ` : `
      <div class="card" style="text-align:center;padding:40px 16px">
        <span class="material-symbols-outlined text-[48px]" style="color:#059669">task_alt</span>
        <b style="font-size:1.15rem;display:block;margin-top:10px">Toutes les tables sont servies !</b>
        <p class="muted" style="margin:4px 0 0">En attente de nouvelles commandes clients en direct.</p>
      </div>
    `}
  `, 'orders');

  $('#refresh-orders-btn')?.addEventListener('click', loadOrders);

  app.querySelectorAll('[data-status-btn]').forEach(b => {
    b.onclick = async () => {
      const [id, st] = b.dataset.statusBtn.split(':');
      try {
        await api('POST', `/orders/${id}/status`, { status: st });
        toast('Statut mis à jour ! Le client est notifié.');
        loadOrders();
      } catch (e) {
        toast('Erreur: ' + e.message, 'error');
      }
    };
  });

  app.querySelectorAll('[data-pay-btn]').forEach(b => {
    b.onclick = async () => {
      const [id, total] = b.dataset.payBtn.split(':');
      const method = prompt('Mode de paiement : 1: Espèces, 2: Orange Money, 3: Moov Money, 4: Carte', '1');
      const methods = { '1': 'CASH', '2': 'ORANGE_MONEY', '3': 'MOOV_MONEY', '4': 'CARD' };
      const chosen = methods[method] || 'CASH';
      try {
        await api('POST', `/orders/${id}/payments`, { method: chosen, amount: Number(total) });
        await api('POST', `/orders/${id}/status`, { status: 'COMPLETED' });
        toast('Commande encaissée et clôturée !');
        loadOrders();
      } catch (e) {
        toast('Erreur encaissement : ' + e.message, 'error');
      }
    };
  });

  app.querySelectorAll('[data-cancel-btn]').forEach(b => {
    b.onclick = async () => {
      const id = b.dataset.cancelBtn;
      if (confirm('Voulez-vous annuler / refuser cette commande ?')) {
        await api('POST', `/orders/${id}/status`, { status: 'REJECTED' });
        toast('Commande refusée');
        loadOrders();
      }
    };
  });
}

// ==========================================
// ÉCRAN 3 : GESTION DES POINTS DE LIVRAISON (TABLES & QR CODES)
// ==========================================
async function tablesView() {
  if (!S.currentEst) return;
  try {
    S.points = await api('GET', `/establishments/${S.currentEst.id}/points`);
  } catch {
    S.points = [];
  }

  shell('Points de Livraison', `
    <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:10px">
      <b style="font-size:1.15rem">${S.points.length} point(s) de livraison</b>
      <button class="big sm" id="add-point-btn" style="background:#0f766e">+ Ajouter une table</button>
    </div>

    ${S.points.length ? `
      <div class="col" style="gap:10px">
        ${S.points.map(p => `
          <div class="card row" style="justify-content:space-between;align-items:center">
            <div>
              <b style="font-size:1.1rem;display:block">🪑 ${esc(p.label)}</b>
              <div class="muted" style="font-size:0.8rem">Code : <strong>${esc(p.code)}</strong> • ${esc(p.zone || 'Sur place')}</div>
            </div>
            <div class="row" style="gap:6px">
              ${p.token ? `
                <button class="sm sec" data-show-qr="${p.token}" data-label="${esc(p.label)}">
                  📷 Voir QR
                </button>
              ` : ''}
              <button class="sm sec" data-del-point="${p.id}" style="color:var(--er)">✕</button>
            </div>
          </div>
        `).join('')}
      </div>
    ` : `
      <div class="card" style="text-align:center;padding:36px 16px">
        <span class="material-symbols-outlined text-[44px]" style="color:var(--tx-muted)">table_restaurant</span>
        <b style="display:block;margin-top:10px;font-size:1.1rem">Aucune table enregistrée</b>
        <p class="muted" style="margin:4px 0 16px">Ajoutez vos tables ou comptoirs pour générer les QR codes clients.</p>
        <button class="big" id="empty-add-pt" style="background:#0f766e">+ Créer ma première table</button>
      </div>
    `}
  `, 'tables');

  $('#add-point-btn')?.addEventListener('click', showAddPointModal);
  $('#empty-add-pt')?.addEventListener('click', showAddPointModal);

  app.querySelectorAll('[data-show-qr]').forEach(b => {
    b.onclick = () => {
      const token = b.dataset.showQr;
      const label = b.dataset.label;
      const clientUrl = `${window.location.origin.replace('vendeur.', 'client.')}/?q=${token}`;
      const qrImg = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(clientUrl)}`;

      const m = document.createElement('div');
      m.className = 'modal-back';
      m.innerHTML = `
        <div class="modal-box col" style="max-width:380px;text-align:center">
          <div class="row" style="justify-content:space-between;align-items:center">
            <b class="hd" style="font-size:1.2rem">QR Code : ${esc(label)}</b>
            <button class="sm sec" id="close-qr">✕</button>
          </div>
          <p class="muted" style="margin:6px 0 14px;font-size:0.85rem">Placez ce QR code sur la table pour que les clients commandent directement.</p>
          <div style="background:#fff;padding:12px;border-radius:12px;display:inline-block;margin:0 auto">
            <img src="${qrImg}" alt="QR Code" style="width:200px;height:200px;display:block">
          </div>
          <button class="big" id="print-qr" style="margin-top:14px;background:#0f766e">🖨️ Imprimer le QR Code</button>
        </div>
      `;
      document.body.appendChild(m);
      $('#close-qr').onclick = () => m.remove();
      $('#print-qr').onclick = () => window.print();
    };
  });

  app.querySelectorAll('[data-del-point]').forEach(b => {
    b.onclick = async () => {
      if (confirm('Désactiver ce point de livraison ?')) {
        await api('DELETE', `/reception-points/${b.dataset.delPoint}`);
        toast('Point désactivé');
        tablesView();
      }
    };
  });
}

function showAddPointModal() {
  const m = document.createElement('div');
  m.className = 'modal-back';
  m.innerHTML = `
    <div class="modal-box col" style="max-width:420px">
      <b class="hd" style="font-size:1.25rem">Ajouter une table ou un point</b>
      <p class="muted" style="margin:4px 0 14px">Un QR code unique sera automatiquement créé pour cette table.</p>

      <label class="muted" style="font-weight:700">Nom / Libellé de la table</label>
      <input id="pt-label" placeholder="Ex: Table 1, Terrasse VIP, Comptoir...">

      <label class="muted" style="font-weight:700;margin-top:8px">Code court</label>
      <input id="pt-code" placeholder="Ex: T1, VIP, BAR...">

      <button class="big" id="save-pt-btn" style="margin-top:14px;background:#0f766e">Enregistrer &amp; Générer le QR</button>
    </div>
  `;
  document.body.appendChild(m);

  $('#save-pt-btn').onclick = async () => {
    const label = $('#pt-label').value.trim();
    const code = $('#pt-code').value.trim() || label.slice(0, 5).toUpperCase();
    if (!label) return alert('Veuillez entrer un libellé.');
    try {
      await api('POST', `/establishments/${S.currentEst.id}/points`, { label, code });
      m.remove();
      toast('Table créée avec succès !');
      tablesView();
    } catch (e) {
      alert('Erreur: ' + e.message);
    }
  };
}

// ==========================================
// ÉCRAN 4 : GESTION DES PRODUITS & MENUS
// ==========================================
async function menuView() {
  if (!S.currentEst) return;
  try {
    const [prods, cats] = await Promise.all([
      api('GET', `/products?establishment_id=${S.currentEst.id}`),
      api('GET', `/categories?establishment_id=${S.currentEst.id}`)
    ]);
    S.products = prods || [];
    S.categories = cats || [];
  } catch {
    S.products = [];
    S.categories = [];
  }

  shell('Gestion des Produits', `
    <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:10px">
      <b style="font-size:1.15rem">${S.products.length} produit(s) au menu</b>
      <button class="big sm" id="add-prod-btn" style="background:#0f766e">+ Ajouter un article</button>
    </div>

    ${S.products.length ? `
      <div class="col" style="gap:10px">
        ${S.products.map(p => `
          <div class="card pc" style="padding:10px">
            <div class="row" style="align-items:center;gap:12px">
              <div style="width:52px;height:52px;border-radius:8px;background:#e2e8f0;display:grid;place-items:center;font-size:1.5rem">
                ${p.image ? `<img src="${esc(p.image)}" style="width:100%;height:100%;object-fit:cover;border-radius:8px">` : '🍽️'}
              </div>
              <div style="flex:1">
                <b style="font-size:1.05rem;display:block">${esc(p.name)}</b>
                <div class="price" style="font-size:1rem">${fcfa(p.price)}</div>
              </div>
              <div class="row" style="gap:6px">
                <button class="sm ${p.available ? 'ok' : 'sec'}" data-toggle-prod="${p.id}:${p.available ? '0' : '1'}">
                  ${p.available ? '✓ Dispo' : 'Rupture'}
                </button>
                <button class="sm sec" data-del-prod="${p.id}" style="color:var(--er)">✕</button>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    ` : `
      <div class="card" style="text-align:center;padding:36px 16px">
        <span class="material-symbols-outlined text-[44px]" style="color:var(--tx-muted)">menu_book</span>
        <b style="display:block;margin-top:10px;font-size:1.1rem">Votre carte est vide</b>
        <p class="muted" style="margin:4px 0 16px">Ajoutez vos boissons, plats ou grillades pour que les clients puissent les commander.</p>
        <button class="big" id="empty-add-prod" style="background:#0f766e">+ Ajouter un premier produit</button>
      </div>
    `}
  `, 'menu');

  $('#add-prod-btn')?.addEventListener('click', showAddProdModal);
  $('#empty-add-prod')?.addEventListener('click', showAddProdModal);

  app.querySelectorAll('[data-toggle-prod]').forEach(b => {
    b.onclick = async () => {
      const [id, av] = b.dataset.toggleProd.split(':');
      await api('PATCH', `/products/${id}`, { available: av === '1' });
      toast('Disponibilité mise à jour !');
      menuView();
    };
  });

  app.querySelectorAll('[data-del-prod]').forEach(b => {
    b.onclick = async () => {
      if (confirm('Supprimer ce produit de la carte ?')) {
        await api('DELETE', `/products/${b.dataset.delProd}`);
        toast('Produit supprimé');
        menuView();
      }
    };
  });
}

function showAddProdModal() {
  const m = document.createElement('div');
  m.className = 'modal-back';
  m.innerHTML = `
    <div class="modal-box col" style="max-width:440px">
      <b class="hd" style="font-size:1.25rem">Ajouter un produit</b>

      <label class="muted" style="font-weight:700;margin-top:8px">Nom du produit</label>
      <input id="np-name" placeholder="Ex: Poulet braisé, Bouteille Brakina...">

      <label class="muted" style="font-weight:700;margin-top:8px">Prix (FCFA)</label>
      <input id="np-price" type="number" placeholder="Ex: 3500">

      <label class="muted" style="font-weight:700;margin-top:8px">Description (optionnel)</label>
      <input id="np-desc" placeholder="Ex: Bouteille 65cl servie glacée...">

      <button class="big" id="save-np-btn" style="margin-top:14px;background:#0f766e">Enregistrer le produit</button>
    </div>
  `;
  document.body.appendChild(m);

  $('#save-np-btn').onclick = async () => {
    const name = $('#np-name').value.trim();
    const price = Number($('#np-price').value);
    const description = $('#np-desc').value.trim();
    if (!name || isNaN(price) || price < 0) return alert('Nom et prix valides requis.');
    try {
      await api('POST', '/products', {
        establishment_id: S.currentEst.id,
        name,
        price,
        description
      });
      m.remove();
      toast('Produit ajouté au menu !');
      menuView();
    } catch (e) {
      alert('Erreur: ' + e.message);
    }
  };
}

// ==========================================
// ÉCRAN 5 : BILAN DES VENTES & ÉQUIPE
// ==========================================
async function statsView() {
  if (!S.currentEst) return;
  let stats = { revenue_paid: 0, orders: [] };
  try {
    stats = await api('GET', `/statistics?establishment_id=${S.currentEst.id}`);
  } catch {}

  shell('Bilan & Équipe', `
    <div class="card" style="text-align:center;padding:24px 16px;background:#ecfdf5;border-color:#6ee7b7">
      <span class="muted" style="font-size:0.85rem">Recette totale encaissée</span>
      <b style="font-size:2rem;color:#047857;display:block;margin-top:4px">${fcfa(stats.revenue_paid || 0)}</b>
    </div>

    <div class="card col" style="gap:10px;margin-top:12px">
      <b style="font-size:1.1rem">Inviter un serveur / employé</b>
      <p class="muted" style="margin:0;font-size:0.85rem">
        Générez un code temporaire pour permettre à un serveur ou caissier d'accéder au tableau de bord sans mot de passe.
      </p>
      <button class="big sm" id="gen-invite-btn" style="background:#0f766e">Générer un code serveur (24h)</button>
      <div id="invite-box" style="display:none;padding:10px;background:#f8fafc;border-radius:8px;font-family:monospace;font-size:1.2rem;text-align:center;font-weight:900"></div>
    </div>

    <div class="card col" style="margin-top:12px">
      <b style="font-size:1.1rem">Déconnexion</b>
      <button class="sec sm" id="v-logout-btn" style="color:var(--er);margin-top:8px">Se déconnecter de ce terminal</button>
    </div>
  `, 'stats');

  $('#gen-invite-btn')?.addEventListener('click', async () => {
    try {
      const r = await api('POST', `/establishments/${S.currentEst.id}/invites`, { role: 'STAFF' });
      const b = $('#invite-box');
      b.style.display = 'block';
      b.textContent = r.code;
      toast('Code généré ! Donnez ce code au serveur.');
    } catch (e) {
      alert('Erreur: ' + e.message);
    }
  });

  $('#v-logout-btn')?.addEventListener('click', () => {
    if (confirm('Voulez-vous vous déconnecter ?')) {
      S.tokens = null;
      S.me = null;
      LS.del('auth');
      welcome();
    }
  });
}

// ==========================================
// ROUTAGE PRINCIPAL
// ==========================================
async function route() {
  const h = location.hash.replace('#/', '').split('?')[0];
  if (!S.tokens?.access) return welcome();

  if (!S.me) {
    try { await loadMe(); } catch { return welcome(); }
  }

  if (!S.currentEst && (!S.me?.memberships || !S.me.memberships.length)) {
    return createEstablishmentModal();
  }

  connectSse();

  switch (h) {
    case 'tables': return tablesView();
    case 'menu': return menuView();
    case 'stats': return statsView();
    default: return loadOrders();
  }
}

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', async () => {
  if (S.tokens?.access) {
    try {
      await loadMe();
      route();
      return;
    } catch {
      S.tokens = null;
      LS.del('auth');
    }
  }
  welcome();
});
