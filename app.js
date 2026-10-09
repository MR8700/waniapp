/**
 * WANI Vendeur — Tableau de bord Gérant, Barman & Comptoir
 * Gestion des points de livraison, menus réels et commandes en temps réel avec carillon sonore
 */

import { API_BASE } from './config.js';
import * as KS_RAW from './keystore.js';
const KS = KS_RAW.KeyStore || KS_RAW;

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fcfa = n => (Number(n) || 0).toLocaleString('fr-FR') + ' FCFA';
const getApp = () => document.getElementById('app') || document.querySelector('#app') || document.body;
const app = {
  get innerHTML() { return getApp().innerHTML; },
  set innerHTML(v) { getApp().innerHTML = v; },
  querySelectorAll(...a) { return getApp().querySelectorAll(...a); },
  querySelector(...a) { return getApp().querySelector(...a); }
};

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
// PWA INSTALLATION RAPIDE
// ==========================================
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const b = document.getElementById('v-install-btn') || document.getElementById('hdr-install-btn');
  if (b) b.style.display = 'inline-flex';
});

window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  toast('Application WANI Vendeur installée !', 'ok');
});

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

async function triggerInstall() {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') deferredPrompt = null;
  } else {
    const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) && !window.MSStream;
    if (isIOS) {
      alert("Pour installer WANI Vendeur sur votre iPhone/iPad :\n\n1. Appuyez sur le bouton Partager ⎋ (en bas de Safari)\n2. Faites défiler et touchez 'Sur l'écran d'accueil' ⊕\n3. Appuyez sur 'Ajouter'");
    } else {
      alert("Pour installer l'application WANI Vendeur :\n\nOuvrez le menu de votre navigateur (les 3 points ⋮ en haut à droite) et touchez 'Installer l'application' ou 'Ajouter à l'écran d'accueil'.");
    }
  }
}

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
  let pk;
  if (await KS.hasKey()) {
    pk = await KS.publicKey();
  } else {
    pk = await KS.create();
  }
  const ts = Date.now();
  const pop = await KS.sign(`register|${pk}|${ts}`);
  const ua = navigator.userAgent;
  const platform = /Android/.test(ua) ? 'android' : /iPhone|iPad/.test(ua) ? 'ios' : 'web';
  const r = await raw('POST', '/auth/device/register', {
    public_key: pk,
    pop,
    ts,
    display_name: displayName || 'Vendeur',
    invite_code: inviteCode || undefined,
    device_name: platform === 'web' ? 'Terminal Vendeur' : platform,
    platform
  });
  localStorage.setItem('device_id', r.device_id);
  return r;
}

async function login() {
  const did = localStorage.getItem('device_id');
  if (!did) throw new Error('NO_DEVICE_ID');
  const ch = await raw('POST', '/auth/device/challenge', { device_id: did });
  const sig = await KS.sign(`auth|${did}|${ch.nonce}`);
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
          ${!isStandalone() ? `
            <button class="sm sec" id="hdr-install-btn" title="Installer l'application" style="display:inline-flex;align-items:center;gap:4px;border-color:#14b8a6;color:#5eead4;background:rgba(20,184,166,0.15)">
              <span class="material-symbols-outlined text-[18px]">install_mobile</span>
              <span>Installer</span>
            </button>
          ` : ''}
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

  $('#hdr-install-btn')?.addEventListener('click', triggerInstall);
  $('#toggle-service-btn')?.addEventListener('click', () => {
    S.serviceOpen = !S.serviceOpen;
    toast(S.serviceOpen ? 'Service ouvert aux clients' : 'Service en pause');
    shell(title, body, active);
  });
}

function friendlyError(err) {
  const msg = String(err?.message || err || '');
  if (msg.includes('INVALID_INVITE')) {
    return "Ce code d'équipe est introuvable ou a expiré. Si vous êtes le gérant ou souhaitez créer votre établissement, laissez la case de code vide !";
  }
  if (msg.includes('DEVICE_EXISTS')) {
    return "Cet appareil est déjà reconnu sur WANI.";
  }
  if (msg.includes('ESTABLISHMENT_ALREADY_CLAIMED')) {
    return "Cet établissement a déjà un gérant actif.";
  }
  if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
    return "Connexion au serveur impossible. Vérifiez votre connexion internet.";
  }
  return "Impossible d'accéder : " + msg;
}

// ==========================================
// ÉCRAN 1 : CONNEXION SANS MOT DE PASSE (ZÉRO JARGON)
// ==========================================
function welcome(err = '') {
  app.innerHTML = `
    <main class="col" style="padding-top:36px;text-align:center">
      <div style="width:76px;height:76px;margin:0 auto 12px;border-radius:50%;background:linear-gradient(135deg,#0d9488,#042f2e);display:grid;place-items:center;box-shadow:0 8px 24px rgba(13,148,136,0.3);border:3px solid #fff;color:#fff">
        <span class="material-symbols-outlined text-[40px]">store</span>
      </div>
      <h1 style="font-size:2rem;font-weight:900;justify-content:center;color:var(--tx)">WANI Vendeur</h1>
      <div style="font-size:0.95rem;color:#0f766e;font-weight:800;margin:-4px auto 14px;letter-spacing:0.5px">Commandez et soyez servi ! · Espace Vendeur</div>
      
      <p class="muted" style="margin:0 auto 16px;max-width:360px">
        Connexion directe sans mot de passe. Gérez vos points de livraison, vos produits et recevez vos commandes en direct.
      </p>

      <div style="margin:0 auto 16px;max-width:360px">
        <button class="big sm sec" id="v-install-btn" style="border:2px solid #0f766e;color:#0f766e;font-weight:800;display:inline-flex;align-items:center;justify-content:center;gap:8px;width:100%;background:#f0fdfa">
          <span class="material-symbols-outlined text-[20px]">install_mobile</span>
          📲 Installer l'application Vendeur
        </button>
      </div>

      <div class="card col" style="text-align:left">
        <label class="muted" style="font-weight:700">Votre Nom ou Prénom</label>
        <input id="v-name" placeholder="Ex: Jean (Gérant), Aminata..." autocomplete="given-name">

        <!-- Bouton principal gérant (sans aucun code requis) -->
        <button class="big" id="v-start-btn" style="margin-top:12px;background:#0f766e">Accéder à mon espace vendeur</button>

        <!-- Option équipe (serveurs avec code d'invitation) -->
        <div style="margin-top:14px;padding-top:12px;border-top:1px dashed var(--bd)">
          <details id="v-invite-details" style="font-size:0.85rem">
            <summary style="cursor:pointer;color:#0f766e;font-weight:700">👉 Vous êtes serveur avec un code d'équipe ?</summary>
            <div style="margin-top:8px">
              <label class="muted" style="font-weight:600;font-size:0.8rem">Code d'invitation (fourni par votre gérant) :</label>
              <input id="v-code" placeholder="Ex: XXXXX-XXXXX" style="margin-top:4px;font-size:0.9rem">
              <div style="font-size:0.75rem;color:#64748b;margin-top:4px">
                💡 <em>Laissez vide si vous êtes le gérant ou créez votre lieu.</em>
              </div>
            </div>
          </details>
        </div>

        ${err ? `<p style="color:var(--er);margin:10px 0 0;font-size:0.85rem;font-weight:600">${esc(err)}</p>` : ''}
      </div>

      <div style="margin-top:20px;font-size:0.85rem;color:var(--tx-muted);font-weight:600">
        ⚡ Commandez et soyez servi !
      </div>
    </main>
  `;

  $('#v-install-btn')?.addEventListener('click', triggerInstall);
  $('#v-start-btn').onclick = async () => {
    $('#v-start-btn').disabled = true;
    try {
      const name = $('#v-name').value.trim() || 'Vendeur';
      const code = ($('#v-code')?.value || '').trim().toUpperCase();
      const did = localStorage.getItem('device_id');
      const hasKey = await KS.hasKey();

      if (did && hasKey) {
        // Appareil déjà enregistré
        try {
          await login();
          if (code) {
            try {
              await api('POST', '/invites/redeem', { code });
              await loadMe();
            } catch (invErr) {
              throw new Error(friendlyError(invErr));
            }
          }
          location.hash = '#/orders';
          route();
          return;
        } catch (err) {
          console.warn('Reconnexion échouée:', err);
          if (code && String(err.message || '').includes("code d'équipe")) throw err;
        }
      }

      // Nouvel appareil
      try {
        await register(name, code);
        await login();
      } catch (regErr) {
        if (String(regErr.message || '').includes('DEVICE_EXISTS')) {
          await login();
          if (code) {
            await api('POST', '/invites/redeem', { code });
            await loadMe();
          }
        } else {
          throw regErr;
        }
      }

      location.hash = '#/orders';
      route();
    } catch (e) {
      $('#v-start-btn').disabled = false;
      welcome(friendlyError(e));
    }
  };
}

// ==========================================
// CRÉATION DE L'ÉTABLISSEMENT SI NOUVEAU VENDEUR
// ==========================================
async function createEstablishmentView() {
  let publicEsts = [];
  try {
    publicEsts = (await raw('GET', '/establishments/public')) || [];
  } catch {}

  getApp().innerHTML = `
    <header class="app-header" style="background:#042f2e;color:#fff;border-bottom-color:#115e59">
      <div class="row" style="width:100%;justify-content:space-between;align-items:center">
        <div class="row" style="gap:8px;align-items:center">
          <div style="width:32px;height:32px;border-radius:8px;background:#0d9488;color:#fff;display:grid;place-items:center;font-weight:900;font-family:var(--hd)">W</div>
          <div>
            <b class="hd" style="font-size:1.1rem;color:#fff">WANI Vendeur</b>
            <div style="font-size:0.75rem;color:#5eead4">Configuration de votre lieu</div>
          </div>
        </div>
      </div>
    </header>
    <main class="col" style="padding:28px 16px;text-align:center">
      <div style="width:76px;height:76px;margin:0 auto 12px;border-radius:50%;background:linear-gradient(135deg,#0d9488,#042f2e);display:grid;place-items:center;color:#fff;box-shadow:0 8px 24px rgba(13,148,136,0.25)">
        <span class="material-symbols-outlined text-[40px]">storefront</span>
      </div>
      <h2 style="font-size:1.6rem;font-weight:900;margin:0 0 6px;color:var(--tx)">Votre lieu de vente</h2>
      <p class="muted" style="margin:0 auto 20px;max-width:380px">
        Prenez la gestion d'un lieu existant ou créez votre propre établissement (bar, restaurant, maquis, buvette).
      </p>

      ${publicEsts.length ? `
        <div class="card col" style="text-align:left;max-width:440px;margin:0 auto 16px;width:100%">
          <b style="font-size:1rem;color:var(--tx)">Gérer un lieu existant :</b>
          <div class="col" style="gap:8px;margin-top:8px">
            ${publicEsts.map(e => `
              <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;background:#f0fdfa;border:1px solid #ccfbf1;border-radius:8px">
                <div>
                  <strong>${esc(e.name)}</strong>
                  <div style="font-size:0.75rem;color:var(--tx-muted)">${(e.points || []).length} tables actives</div>
                </div>
                <button class="sm" data-claim-id="${e.id}" style="background:#0f766e">Gérer</button>
              </div>
            `).join('')}
          </div>
        </div>
        <div style="margin:4px 0 16px;font-weight:700;color:var(--tx-muted);font-size:0.85rem">— OU CRÉER UN NOUVEAU LIEU —</div>
      ` : ''}

      <div class="card col" style="text-align:left;max-width:440px;margin:0 auto;width:100%">
        <label class="muted" style="font-weight:700">Nom de votre établissement</label>
        <input id="new-est-name" placeholder="Ex: Maquis Le Sahel, Bar VIP, Chez Aminata..." style="font-size:1rem;margin-top:6px">
        <button class="big" id="save-est-btn" style="margin-top:14px;background:#0f766e">Enregistrer &amp; Ouvrir l'espace vendeur</button>
      </div>

      <div style="margin-top:24px">
        <button class="sec sm" id="v-switch-user-btn" style="color:var(--er)">Se déconnecter ou changer de compte</button>
      </div>
    </main>
  `;

  getApp().querySelectorAll('[data-claim-id]').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.getAttribute('data-claim-id');
      try {
        const r = await api('POST', `/establishments/${id}/claim`);
        S.currentEst = { id: r.id, name: r.name, role: 'MANAGER' };
        LS.set('current_est', S.currentEst);
        toast('Établissement rattaché avec succès !', 'ok');
        route();
      } catch (err) {
        alert(friendlyError(err));
      }
    };
  });

  $('#save-est-btn').onclick = async () => {
    const name = $('#new-est-name').value.trim();
    if (!name) return alert('Veuillez entrer le nom de votre établissement.');
    try {
      const r = await api('POST', '/establishments', { name });
      S.currentEst = { id: r.id, name: r.name, role: 'MANAGER' };
      LS.set('current_est', S.currentEst);
      toast('Établissement créé avec succès !', 'ok');
      route();
    } catch (err) {
      alert(friendlyError(err));
    }
  };

  $('#v-switch-user-btn')?.addEventListener('click', () => {
    S.tokens = null;
    S.me = null;
    S.currentEst = null;
    LS.del('auth');
    LS.del('current_est');
    welcome();
  });
}

// ==========================================
// ÉCRAN 2 : RÉCEPTION DES COMMANDES EN TEMPS RÉEL
// ==========================================
async function loadOrders() {
  if (!S.currentEst) return createEstablishmentView();
  try {
    const list = await api('GET', `/orders?establishment_id=${S.currentEst.id}`);
    S.orders = list || [];
    renderOrders();
  } catch {
    renderOrders();
  }
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
      <button class="big sm" id="add-point-btn" style="background:#0f766e">+ Ajouter un point de livraison</button>
    </div>

    ${S.points.length ? `
      <div class="col" style="gap:10px">
        ${S.points.map(p => `
          <div class="card row" style="justify-content:space-between;align-items:center">
            <div>
              <b style="font-size:1.1rem;display:block">🪑 ${esc(p.label)}</b>
              <div class="muted" style="font-size:0.85rem">
                Code court client : <strong style="color:#0f766e;font-family:monospace;letter-spacing:1px">${esc(p.code)}</strong> • ${esc(p.zone || 'Sur place')}
              </div>
            </div>
            <div class="row" style="gap:6px">
              ${p.token ? `
                <button class="sm sec" data-show-qr="${p.token}" data-label="${esc(p.label)}" data-code="${esc(p.code)}">
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
        <b style="display:block;margin-top:10px;font-size:1.1rem">Aucun point de livraison configuré</b>
        <p class="muted" style="margin:4px 0 16px">Ajoutez vos tables, terrasses ou comptoirs pour générer les QR codes et codes clients.</p>
        <button class="big" id="empty-add-pt" style="background:#0f766e">+ Ajouter un point de livraison</button>
      </div>
    `}
  `, 'tables');

  $('#add-point-btn')?.addEventListener('click', showAddPointModal);
  $('#empty-add-pt')?.addEventListener('click', showAddPointModal);

  app.querySelectorAll('[data-show-qr]').forEach(b => {
    b.onclick = () => {
      const token = b.dataset.showQr;
      const label = b.dataset.label;
      const code = b.dataset.code;
      const clientUrl = `${window.location.origin.replace('vendeur.', 'client.')}/?q=${token}`;
      const qrImg = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(clientUrl)}`;

      const m = document.createElement('div');
      m.className = 'modal-back';
      m.innerHTML = `
        <div class="modal-box col" style="max-width:380px;text-align:center">
          <div class="row" style="justify-content:space-between;align-items:center">
            <b class="hd" style="font-size:1.2rem">Point : ${esc(label)}</b>
            <button class="sm sec" id="close-qr">✕</button>
          </div>
          <p class="muted" style="margin:6px 0 10px;font-size:0.85rem">Placez ce QR code sur la table ou le comptoir pour que les clients commandent directement.</p>

          <div style="background:#fff;padding:12px;border-radius:12px;display:inline-block;margin:0 auto">
            <img src="${qrImg}" alt="QR Code" style="width:200px;height:200px;display:block">
          </div>

          <div style="background:#f0fdfa;border:1px solid #ccfbf1;padding:8px 12px;border-radius:8px;margin:12px 0 4px;text-align:center">
            <div style="font-size:0.8rem;color:#0f766e;font-weight:700">Code court à saisir :</div>
            <div style="font-size:1.4rem;font-weight:900;letter-spacing:2px;font-family:monospace;color:#042f2e">${esc(code)}</div>
            <div style="font-size:0.75rem;color:#64748b;margin-top:2px">
              Le client peut scanner le QR code OU saisir ce code dans l'application WANI.
            </div>
          </div>

          <button class="big" id="print-qr" style="margin-top:10px;background:#0f766e">🖨️ Imprimer l'étiquette QR</button>
        </div>
      `;
      document.body.appendChild(m);
      $('#close-qr').onclick = () => m.remove();
      m.onclick = (e) => { if (e.target === m) m.remove(); };
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
  const existingCodes = (S.points || []).map(p => (p.code || '').toUpperCase());

  function suggestNextCode(label = '') {
    let prefix = 'T';
    const clean = label.trim();
    const match = clean.match(/^(table|terrasse|salon|vip|paillote|bar|comptoir|chambre)\s*(\d+)?/i);
    if (match) {
      const word = match[1].toUpperCase();
      if (word.startsWith('TER')) prefix = 'TER';
      else if (word.startsWith('SAL')) prefix = 'SAL';
      else if (word.startsWith('PAIL')) prefix = 'P';
      else if (word.startsWith('VIP')) prefix = 'VIP';
      else if (word.startsWith('BAR') || word.startsWith('COMP')) prefix = 'BAR';
      else if (word.startsWith('CHAM')) prefix = 'CH';
      else prefix = 'T';
      if (match[2]) {
        const candidate = `${prefix}${String(match[2]).padStart(2, '0')}`;
        if (!existingCodes.includes(candidate)) return candidate;
      }
    }
    for (let i = 1; i <= 99; i++) {
      const candidate = `${prefix}${String(i).padStart(2, '0')}`;
      if (!existingCodes.includes(candidate)) return candidate;
    }
    return `P${Math.floor(10 + Math.random() * 90)}`;
  }

  const initialCode = suggestNextCode('');

  const m = document.createElement('div');
  m.className = 'modal-back';
  m.innerHTML = `
    <div class="modal-box col" style="max-width:440px;position:relative">
      <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:6px">
        <b class="hd" style="font-size:1.25rem;color:var(--tx)">Ajouter un point de livraison</b>
        <button class="sm sec" id="close-modal-x" style="padding:4px 8px;font-weight:900" title="Fermer la modale">✕</button>
      </div>
      <p class="muted" style="margin:0 0 16px;font-size:0.85rem">
        Indiquez le point où la commande doit être livrée (table, terrasse, paillote, comptoir, salon VIP...).
      </p>

      <label class="muted" style="font-weight:700">Nom ou numéro du point de livraison</label>
      <input id="pt-label" placeholder="Ex: Table 1, Paillote 4, VIP 2, Comptoir..." style="font-size:1rem" autocomplete="off">

      <div style="margin:14px 0 6px;padding:12px;background:#f0fdfa;border:1px solid #ccfbf1;border-radius:10px">
        <label style="display:flex;align-items:center;gap:8px;font-weight:700;cursor:pointer;color:#0f766e">
          <input type="checkbox" id="pt-auto-code" checked style="width:18px;height:18px;accent-color:#0f766e">
          Générer automatiquement un code court unique
        </label>
        <div style="font-size:0.75rem;color:#0d9488;margin-top:4px;line-height:1.4">
          Code court et facile à mémoriser pour le client afin de diriger directement vers votre boutique.
        </div>

        <div id="code-input-area" style="margin-top:10px">
          <label class="muted" style="font-weight:700;font-size:0.8rem">Code court client (ex: T01, J04) :</label>
          <input id="pt-code" value="${initialCode}" style="font-family:monospace;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;margin-top:4px;font-size:1.05rem" maxlength="15" autocomplete="off">
          <div id="code-status" style="font-size:0.75rem;margin-top:4px;font-weight:600;color:#0f766e">
            ✓ Code disponible et facile à saisir
          </div>
        </div>
      </div>

      <div class="row" style="gap:8px;margin-top:16px;justify-content:flex-end">
        <button class="sec" id="cancel-pt-btn">Annuler</button>
        <button class="big" id="save-pt-btn" style="background:#0f766e;padding:0 20px">Enregistrer le point</button>
      </div>
    </div>
  `;
  document.body.appendChild(m);

  const closeModal = () => {
    window.removeEventListener('keydown', onKeyDown);
    m.remove();
  };
  const onKeyDown = (e) => {
    if (e.key === 'Escape') closeModal();
  };
  window.addEventListener('keydown', onKeyDown);

  $('#close-modal-x').onclick = closeModal;
  $('#cancel-pt-btn').onclick = closeModal;
  m.onclick = (e) => { if (e.target === m) closeModal(); };

  const labelIn = $('#pt-label');
  const codeIn = $('#pt-code');
  const autoChk = $('#pt-auto-code');
  const statusBox = $('#code-status');
  const saveBtn = $('#save-pt-btn');

  function validateCode() {
    const val = (codeIn.value || '').trim().toUpperCase();
    if (!val) {
      statusBox.innerHTML = '<span style="color:var(--er)">⚠️ Le code court ne peut pas être vide.</span>';
      saveBtn.disabled = true;
      return false;
    }
    if (existingCodes.includes(val)) {
      statusBox.innerHTML = `<span style="color:var(--er)">⚠️ Le code "${esc(val)}" existe déjà dans votre établissement.</span>`;
      saveBtn.disabled = true;
      return false;
    }
    statusBox.innerHTML = '<span style="color:#0f766e">✓ Code disponible et facile à saisir</span>';
    saveBtn.disabled = false;
    return true;
  }

  labelIn.addEventListener('input', () => {
    if (autoChk.checked) {
      codeIn.value = suggestNextCode(labelIn.value);
      validateCode();
    }
  });

  autoChk.addEventListener('change', () => {
    if (autoChk.checked) {
      codeIn.value = suggestNextCode(labelIn.value);
    }
    validateCode();
  });

  codeIn.addEventListener('input', () => {
    codeIn.value = codeIn.value.toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    if (autoChk.checked && codeIn.value !== suggestNextCode(labelIn.value)) {
      autoChk.checked = false;
    }
    validateCode();
  });

  saveBtn.onclick = async () => {
    const label = labelIn.value.trim();
    const code = (codeIn.value || '').trim().toUpperCase();
    if (!label) return alert('Veuillez entrer un nom ou numéro pour ce point de livraison.');
    if (!validateCode()) return;

    saveBtn.disabled = true;
    try {
      await api('POST', `/establishments/${S.currentEst.id}/points`, { label, code });
      closeModal();
      toast('Point de livraison créé avec succès !', 'ok');
      tablesView();
    } catch (e) {
      saveBtn.disabled = false;
      alert('Erreur: ' + (e.message || e));
    }
  };

  labelIn.focus();
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
    return createEstablishmentView();
  }

  connectSse();

  switch (h) {
    case 'tables': return tablesView();
    case 'menu': return menuView();
    case 'stats': return statsView();
    default: return loadOrders();
  }
}

async function init() {
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
  if (localStorage.getItem('device_id') && (await KS.hasKey())) {
    try {
      await login();
      route();
      return;
    } catch {}
  }
  welcome();
}

window.addEventListener('hashchange', route);

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
