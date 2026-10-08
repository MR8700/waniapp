/**
 * WANI Client — Application Mobile-First de Commande à Table & Emporté
 * Zéro mot de passe · Scanner QR Universel (jsQR) · Suivi en direct (SSE)
 */

import { API_BASE } from './config.js';
import * as KS from './keystore.js';

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
  get: (k, d = null) => { try { const v = localStorage.getItem('wc_' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('wc_' + k, JSON.stringify(v)); } catch {} },
  del: k => { try { localStorage.removeItem('wc_' + k); } catch {} }
};

const S = {
  tokens: LS.get('auth', null),
  me: null,
  ctx: LS.get('table_ctx', null), // { establishment, zone, point, token }
  venues: [],
  cats: [],
  products: [],
  cat: '',
  cart: LS.get('cart', {}),
  activeOrder: LS.get('order', null),
  orderStatus: LS.get('order_status', null),
  stream: null
};

// ==========================================
// PWA INSTALLATION RAPIDE
// ==========================================
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const b = document.getElementById('c-install-btn') || document.getElementById('c-hdr-install-btn');
  if (b) b.style.display = 'inline-flex';
});

window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  toast('Application WANI installée !', 'ok');
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
      alert("Pour installer WANI sur votre iPhone/iPad :\n\n1. Appuyez sur le bouton Partager ⎋ (en bas de Safari)\n2. Faites défiler et touchez 'Sur l'écran d'accueil' ⊕\n3. Appuyez sur 'Ajouter'");
    } else {
      alert("Pour installer l'application WANI :\n\nOuvrez le menu de votre navigateur (les 3 points ⋮ en haut à droite) et touchez 'Installer l'application' ou 'Ajouter à l'écran d'accueil'.");
    }
  }
}

// ==========================================
// CLIENT API & AUTHENTIFICATION SANS MOT DE PASSE
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

async function register(displayName) {
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
    display_name: displayName || 'Client',
    device_name: platform === 'web' ? 'Mobile Client' : platform,
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
}

// ==========================================
// TEMPS RÉEL (SSE)
// ==========================================
function connectSse() {
  if (S.stream || !S.tokens?.access) return;
  const url = `${API_BASE}/events?token=${encodeURIComponent(S.tokens.access)}`;
  try {
    const es = new EventSource(url);
    S.stream = es;
    es.addEventListener('ORDER_STATUS', e => {
      try {
        const d = JSON.parse(e.data);
        if (S.activeOrder && d.order_id === S.activeOrder.id) {
          S.activeOrder.status = d.status;
          S.orderStatus = d.status;
          LS.set('order', S.activeOrder);
          LS.set('order_status', d.status);
          toast(statusLabel(d.status), 'info');
          if (location.hash === '#/order') track();
        }
      } catch {}
    });
    es.onerror = () => {
      es.close();
      S.stream = null;
      setTimeout(connectSse, 5000);
    };
  } catch {}
}

function statusLabel(s) {
  switch (s) {
    case 'SUBMITTED': return '⏳ Commande envoyée — En attente du vendeur';
    case 'RECEIVED': return '🔔 Reçue par le vendeur !';
    case 'COMPLETED': return '🎉 Commande servie & terminée';
    case 'CANCELLED': return '❌ Commande annulée';
    case 'REJECTED': return '❌ Commande refusée par l\'établissement';
    default: return s;
  }
}

// ==========================================
// NOTIFICATIONS ET INTERFACE
// ==========================================
function toast(msg, type = 'ok') {
  const d = document.createElement('div');
  d.className = `toast ${type}`;
  d.textContent = msg;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 3400);
}

function shell(title, body, active = '') {
  app.innerHTML = `
    <header class="app-header">
      <div class="row" style="width:100%;justify-content:space-between;align-items:center">
        <div class="row" style="gap:8px;align-items:center">
          <div style="width:34px;height:34px;border-radius:10px;background:var(--p);color:#fff;display:grid;place-items:center;font-weight:900;font-family:var(--hd);font-size:1.1rem">W</div>
          <b class="hd" style="font-size:1.15rem">${esc(title)}</b>
        </div>
        <div class="row" style="gap:6px;align-items:center">
          ${!isStandalone() ? `
            <button class="sm sec" id="c-hdr-install-btn" title="Installer l'application" style="display:inline-flex;align-items:center;gap:4px">
              <span class="material-symbols-outlined text-[18px]">install_mobile</span>
              <span>Installer</span>
            </button>
          ` : ''}
          ${S.ctx ? `<span class="pill" style="font-size:0.75rem">${esc(S.ctx.point?.label || S.ctx.establishment?.name)}</span>` : ''}
        </div>
      </div>
    </header>
    <main class="col" style="padding-top:14px;padding-bottom:24px">${body}</main>
    <nav class="nav">
      <a href="#/" class="${active === 'home' ? 'on' : ''}">
        <span class="material-symbols-outlined">home</span>Accueil
      </a>
      <a href="#/menu" class="${active === 'menu' ? 'on' : ''}">
        <span class="material-symbols-outlined">restaurant_menu</span>Menu
      </a>
      <a href="#/order" class="${active === 'order' ? 'on' : ''}">
        <span class="material-symbols-outlined">receipt_long</span>Ma Commande
      </a>
      <a href="#/profile" class="${active === 'profile' ? 'on' : ''}">
        <span class="material-symbols-outlined">account_circle</span>Mon Profil
      </a>
    </nav>
  `;

  $('#c-hdr-install-btn')?.addEventListener('click', triggerInstall);
}

// ==========================================
// ÉCRAN 1 : BIENVENUE & CONNEXION RAPIDE (ZÉRO JARGON)
// ==========================================
function welcome(err = '') {
  app.innerHTML = `
    <main class="col" style="padding-top:36px;text-align:center">
      <div style="width:80px;height:80px;margin:0 auto 12px;border-radius:50%;background:linear-gradient(135deg,#ffdbce,#fed7aa);display:grid;place-items:center;box-shadow:0 8px 24px rgba(194,65,12,0.25);border:3px solid #fff">
        <span class="material-symbols-outlined text-[42px]" style="color:var(--p)">sports_bar</span>
      </div>
      <h1 style="font-size:2.2rem;font-weight:900;justify-content:center;color:var(--tx);letter-spacing:-0.5px">WANI</h1>
      <div style="font-size:0.95rem;color:var(--p);font-weight:800;margin:-4px auto 14px;letter-spacing:0.5px">Commandez et soyez servi !</div>
      
      <div class="badge g" style="margin:0 auto 14px;font-size:0.8rem">Connexion instantanée</div>
      
      <p class="muted" style="margin:0 auto 16px;max-width:360px;line-height:1.5">
        <strong>Votre appareil vous reconnaît automatiquement.</strong> Aucun mot de passe à retenir. Vos commandes arrivent directement au bar ou en cuisine.
      </p>

      <div style="margin:0 auto 16px;max-width:360px">
        <button class="big sm sec" id="c-install-btn" style="border:2px solid var(--p);color:var(--p);font-weight:800;display:inline-flex;align-items:center;justify-content:center;gap:8px;width:100%;background:#fff7ed">
          <span class="material-symbols-outlined text-[20px]">install_mobile</span>
          📲 Installer l'application sur cet appareil
        </button>
      </div>

      <div class="card col" style="text-align:left">
        <label class="muted" style="font-weight:700">Votre Prénom ou Surnom</label>
        <input id="name-in" placeholder="Ex: Oumar, Fatou, Alex..." autocomplete="given-name">
        <button class="big" id="start-btn" style="margin-top:10px">Commencer &amp; Commander</button>
        ${err ? `<p style="color:var(--er);margin:8px 0 0;font-size:0.85rem;font-weight:600">${esc(err)}</p>` : ''}
      </div>

      <div style="margin-top:20px;font-size:0.85rem;color:var(--tx-muted);font-weight:600">
        ⚡ Commandez et soyez servi !
      </div>
    </main>
  `;

  $('#c-install-btn')?.addEventListener('click', triggerInstall);
  $('#start-btn').onclick = async () => {
    $('#start-btn').disabled = true;
    try {
      const name = $('#name-in').value.trim() || 'Client';
      const did = localStorage.getItem('device_id');
      const hasKey = await KS.hasKey();
      if (did && hasKey) {
        try {
          await login();
          location.hash = '#/';
          route();
          return;
        } catch (err) {
          console.warn('Reconnexion échouée:', err);
        }
      }
      await register(name);
      await login();
      location.hash = '#/';
      route();
    } catch (e) {
      $('#start-btn').disabled = false;
      welcome('Impossible d\'accéder : ' + (e.message || e));
    }
  };
}

// ==========================================
// ÉCRAN 2 : ACCUEIL & SCANNER UNIVERSEL (FONCTIONNE SUR TOUS LES APPAREILS)
// ==========================================
async function home() {
  if (!S.me) return welcome();
  connectSse();

  let venuesHtml = '';
  try {
    const list = await raw('GET', '/establishments/public');
    S.venues = list || [];
  } catch {}

  shell('WANI', `
    <div class="card" style="text-align:center;padding:24px 16px">
      <b style="font-size:1.2rem;display:block">Bonjour ${esc(S.me.user.display_name)} 👋</b>
      <p class="muted" style="margin:4px 0 16px">
        ${S.ctx ? `Vous êtes installé à : <strong>${esc(S.ctx.establishment?.name)} · ${esc(S.ctx.point?.label)}</strong>` : 'Scannez le QR code sur votre table pour voir la carte et commander.'}
      </p>

      <button class="big" id="open-cam-btn" style="width:100%;margin-bottom:10px;display:flex;align-items:center;justify-content:center;gap:8px">
        <span class="material-symbols-outlined text-[24px]">qr_code_scanner</span>
        Scanner le QR code de ma table
      </button>

      <label class="btn sec" style="width:100%;display:flex;align-items:center;justify-content:center;gap:6px;cursor:pointer">
        <span class="material-symbols-outlined text-[20px]">photo_camera</span>
        Prendre une photo du QR code
        <input type="file" id="qr-file-input" accept="image/*" capture="environment" style="display:none">
      </label>

      ${S.ctx ? `
        <div style="margin-top:16px;display:flex;gap:8px;justify-content:center">
          <a class="btn ok" href="#/menu" style="flex:1">Voir le menu</a>
          <button class="sec sm" id="clear-table-btn">Changer</button>
        </div>
      ` : ''}
    </div>

    <!-- Scanner Vidéo Intégré (affiché au clic) -->
    <div id="cam-box" class="card" style="display:none;padding:12px;text-align:center">
      <div style="position:relative;width:100%;max-width:360px;margin:0 auto;border-radius:12px;overflow:hidden;background:#000">
        <video id="cam-video" style="width:100%;height:auto;display:block" playsinline muted autoplay></video>
        <canvas id="cam-canvas" style="display:none"></canvas>
        <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:200px;height:200px;border:3px solid var(--p);border-radius:16px;box-shadow:0 0 0 9999px rgba(0,0,0,0.4)"></div>
      </div>
      <p class="muted" style="margin:10px 0 6px;font-size:0.85rem">Pointez la caméra vers le QR code de la table</p>
      <button class="sec sm" id="close-cam-btn">Fermer la caméra</button>
    </div>

    <!-- Choix direct sans scanner -->
    <div class="card" style="margin-top:14px">
      <b style="display:block;margin-bottom:8px">Ou choisissez votre lieu &amp; table directement :</b>
      ${S.venues.length ? `
        <div class="col" style="gap:8px">
          ${S.venues.map(v => `
            <details style="background:#fff;border:1px solid var(--bd);border-radius:10px;padding:8px 12px">
              <summary style="font-weight:700;cursor:pointer">${esc(v.name)} (${(v.points || []).length} tables)</summary>
              <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px">
                ${(v.points || []).map(p => `
                  <button class="sm sec" data-pick-venue="${v.id}" data-pick-point="${p.id}" data-point-name="${esc(p.label)}" data-venue-name="${esc(v.name)}">
                    🪑 ${esc(p.label)}
                  </button>
                `).join('') || '<p class="muted" style="font-size:0.8rem">Aucun point de livraison configuré pour ce lieu.</p>'}
              </div>
            </details>
          `).join('')}
        </div>
      ` : '<p class="muted" style="font-size:0.85rem">Aucun lieu de vente ouvert pour le moment.</p>'}
    </div>
  `, 'home');

  $('#open-cam-btn')?.addEventListener('click', startScanner);
  $('#close-cam-btn')?.addEventListener('click', stopScanner);
  $('#qr-file-input')?.addEventListener('change', handleQrFile);
  $('#clear-table-btn')?.addEventListener('click', () => {
    S.ctx = null;
    LS.del('table_ctx');
    home();
  });

  app.querySelectorAll('[data-pick-venue]').forEach(b => {
    b.onclick = async () => {
      const vName = b.dataset.venueName, pName = b.dataset.pointName;
      S.ctx = {
        establishment: { id: b.dataset.pickVenue, name: vName },
        point: { id: b.dataset.pickPoint, label: pName },
        zone: 'Sur place'
      };
      LS.set('table_ctx', S.ctx);
      toast(`Installé à : ${pName} (${vName})`);
      location.hash = '#/menu';
      route();
    };
  });
}

// ==========================================
// MOTEUR DU SCANNER UNIVERSEL (JSQR + CANVAS)
// ==========================================
let scannerStream = null;
let scannerAnim = null;

async function startScanner() {
  const box = $('#cam-box');
  const video = $('#cam-video');
  const canvas = $('#cam-canvas');
  if (!box || !video || !canvas) return;

  box.style.display = 'block';
  try {
    scannerStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } }
    });
    video.srcObject = scannerStream;
    await video.play();

    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    function tick() {
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        if (window.jsQR) {
          const code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
          if (code && code.data) {
            stopScanner();
            handleScannedUrl(code.data);
            return;
          }
        }
      }
      scannerAnim = requestAnimationFrame(tick);
    }
    scannerAnim = requestAnimationFrame(tick);
  } catch (err) {
    box.style.display = 'none';
    toast('Accès caméra refusé : utilisez la photo ou le choix direct', 'error');
  }
}

function stopScanner() {
  if (scannerAnim) cancelAnimationFrame(scannerAnim);
  if (scannerStream) {
    scannerStream.getTracks().forEach(t => t.stop());
    scannerStream = null;
  }
  const box = $('#cam-box');
  if (box) box.style.display = 'none';
}

async function handleQrFile(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const img = new Image();
  img.src = URL.createObjectURL(file);
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const id = ctx.getImageData(0, 0, c.width, c.height);
    if (window.jsQR) {
      const code = window.jsQR(id.data, id.width, id.height);
      if (code && code.data) {
        handleScannedUrl(code.data);
        return;
      }
    }
    toast('Aucun QR code trouvé sur cette photo', 'error');
  };
}

async function handleScannedUrl(data) {
  let token = data;
  try {
    const u = new URL(data);
    token = u.searchParams.get('q') || token;
  } catch {}

  try {
    const info = await raw('GET', '/qr/' + encodeURIComponent(token));
    S.ctx = {
      establishment: info.establishment,
      zone: info.zone,
      point: info.point,
      token
    };
    LS.set('table_ctx', S.ctx);
    toast(`Installé à : ${info.point.label} (${info.establishment.name})`);
    location.hash = '#/menu';
    route();
  } catch (err) {
    toast('QR Code inconnu ou expiré', 'error');
  }
}

// ==========================================
// ÉCRAN 3 : MENU DES PRODUITS (DONNÉES RÉELLES DU VENDEUR)
// ==========================================
async function menu() {
  if (!S.ctx) {
    toast('Sélectionnez d\'abord une table', 'info');
    location.hash = '#/';
    return route();
  }

  // Chargement strict des vrais produits du vendeur
  try {
    const [prods, cats] = await Promise.all([
      api('GET', `/products?establishment_id=${S.ctx.establishment.id}`),
      api('GET', `/categories?establishment_id=${S.ctx.establishment.id}`)
    ]);
    S.products = prods || [];
    S.cats = cats || [];
  } catch {
    S.products = [];
    S.cats = [];
  }

  const lines = Object.entries(S.cart).map(([id, q]) => {
    const p = S.products.find(x => x.id === id);
    return p ? { ...p, q } : null;
  }).filter(Boolean);

  const cartCount = lines.reduce((acc, l) => acc + l.q, 0);
  const cartTotal = lines.reduce((acc, l) => acc + (l.price * l.q), 0);

  const filterProd = S.cat ? S.products.filter(p => p.category_id === S.cat) : S.products;

  shell(S.ctx.establishment.name, `
    <div class="card tb">
      <div style="font-size:1.6rem">🪑</div>
      <div style="flex:1">
        <b class="hd" style="font-size:1.15rem">${esc(S.ctx.point.label)}</b>
        <div class="muted">${esc(S.ctx.zone || 'Sur place')}</div>
      </div>
      <span class="pill">En direct</span>
    </div>

    ${S.cats.length ? `
      <div class="chips">
        <button class="${S.cat ? '' : 'on'}" data-cat="">Tout</button>
        ${S.cats.map(c => `<button class="${S.cat === c.id ? 'on' : ''}" data-cat="${c.id}">${esc(c.name)}</button>`).join('')}
      </div>
    ` : ''}

    ${filterProd.length ? `
      <div class="col" style="gap:12px;margin-top:12px">
        ${filterProd.map(p => `
          <div class="card pc">
            <div class="ph">
              ${p.image ? `<img src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy">` : `<span>🍽️</span>`}
              ${p.available ? '' : '<em class="so">Rupture</em>'}
            </div>
            <div class="row" style="align-items:center">
              <div style="flex:1">
                <b class="hd" style="font-size:1.05rem">${esc(p.name)}</b>
                ${p.description ? `<div class="muted" style="font-size:0.85rem">${esc(p.description)}</div>` : ''}
                <div class="price" style="margin-top:4px">${fcfa(p.price)}</div>
              </div>
              <div>
                ${S.cart[p.id] ? `
                  <div class="qty">
                    <button data-sub="${p.id}">−</button>
                    <b>${S.cart[p.id]}</b>
                    <button data-add="${p.id}">+</button>
                  </div>
                ` : `
                  <button class="rd" data-add="${p.id}" ${p.available ? '' : 'disabled'}>+</button>
                `}
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    ` : `
      <div class="card" style="text-align:center;padding:36px 16px;margin-top:14px">
        <span class="material-symbols-outlined text-[44px]" style="color:var(--tx-muted)">storefront</span>
        <b style="display:block;margin-top:10px;font-size:1.1rem">Aucun produit au menu pour le moment</b>
        <p class="muted" style="margin:4px 0 0">Le vendeur n'a pas encore ajouté d'articles pour cet établissement.</p>
      </div>
    `}

    <!-- Dock Panier Flottant 3D -->
    ${cartCount > 0 ? `
      <div class="cart-dock" id="cart-dock">
        <div class="dock-content">
          <div class="dock-badge">🛒 ${cartCount}</div>
          <div class="dock-info">
            <span class="dock-label">Panier en cours</span>
            <span class="dock-total">${fcfa(cartTotal)}</span>
          </div>
          <button class="dock-btn" id="view-cart-btn">Commander ➔</button>
        </div>
      </div>
    ` : ''}
  `, 'menu');

  app.querySelectorAll('[data-cat]').forEach(b => {
    b.onclick = () => { S.cat = b.dataset.cat; menu(); };
  });

  app.querySelectorAll('[data-add]').forEach(b => {
    b.onclick = () => {
      const id = b.dataset.add;
      S.cart[id] = (S.cart[id] || 0) + 1;
      LS.set('cart', S.cart);
      menu();
    };
  });

  app.querySelectorAll('[data-sub]').forEach(b => {
    b.onclick = () => {
      const id = b.dataset.sub;
      if (S.cart[id] > 1) S.cart[id]--;
      else delete S.cart[id];
      LS.set('cart', S.cart);
      menu();
    };
  });

  $('#view-cart-btn')?.addEventListener('click', showCartModal);
}

function showCartModal() {
  const lines = Object.entries(S.cart).map(([id, q]) => {
    const p = S.products.find(x => x.id === id);
    return p ? { ...p, q } : null;
  }).filter(Boolean);

  const total = lines.reduce((acc, l) => acc + (l.price * l.q), 0);

  const m = document.createElement('div');
  m.className = 'modal-back';
  m.innerHTML = `
    <div class="modal-box col" style="max-width:440px">
      <div class="row" style="justify-content:space-between;align-items:center">
        <b class="hd" style="font-size:1.25rem">Votre Commande</b>
        <button class="sm sec" id="close-m">✕</button>
      </div>
      <div class="muted" style="margin-bottom:12px">Table : ${esc(S.ctx.point.label)} (${esc(S.ctx.establishment.name)})</div>

      <div class="col" style="gap:8px;max-height:240px;overflow-y:auto">
        ${lines.map(l => `
          <div class="row" style="justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--bd)">
            <div>
              <b>${esc(l.name)}</b>
              <div class="muted" style="font-size:0.8rem">${l.q} × ${fcfa(l.price)}</div>
            </div>
            <b>${fcfa(l.price * l.q)}</b>
          </div>
        `).join('')}
      </div>

      <div class="row" style="justify-content:space-between;margin-top:14px;font-size:1.15rem;font-weight:900">
        <span>Total :</span>
        <span style="color:var(--p)">${fcfa(total)}</span>
      </div>

      <label class="muted" style="font-weight:700;margin-top:10px">Une précision pour la cuisine / le bar ? (optionnel)</label>
      <input id="order-note" placeholder="Ex: Sans piment, boisson bien fraîche...">

      <button class="big" id="send-order-btn" style="margin-top:14px">Envoyer ma commande</button>
    </div>
  `;
  document.body.appendChild(m);

  $('#close-m').onclick = () => m.remove();
  $('#send-order-btn').onclick = async () => {
    $('#send-order-btn').disabled = true;
    try {
      const items = lines.map(l => ({ product_id: l.id, quantity: l.q }));
      const note = $('#order-note').value.trim();
      const idempotencyKey = 'ord_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);

      const ord = await raw('POST', '/orders', {
        establishment_id: S.ctx.establishment.id,
        reception_point_id: S.ctx.point.id,
        qr_token: S.ctx.token,
        items,
        note
      }, S.tokens.access, { 'idempotency-key': idempotencyKey });

      S.cart = {};
      LS.del('cart');
      S.activeOrder = ord;
      S.orderStatus = ord.status;
      LS.set('order', ord);
      LS.set('order_status', ord.status);

      m.remove();
      toast('Commande envoyée au vendeur !', 'ok');
      location.hash = '#/order';
      route();
    } catch (err) {
      $('#send-order-btn').disabled = false;
      toast('Erreur lors de l\'envoi : ' + err.message, 'error');
    }
  };
}

// ==========================================
// ÉCRAN 4 : SUIVI DE COMMANDE EN TEMPS RÉEL (REÇU PAR LE VENDEUR OU PAS)
// ==========================================
async function track() {
  if (!S.activeOrder) {
    shell('Ma Commande', `
      <div class="card" style="text-align:center;padding:36px 16px">
        <span class="material-symbols-outlined text-[44px]" style="color:var(--tx-muted)">receipt_long</span>
        <b style="display:block;margin-top:10px;font-size:1.15rem">Aucune commande en cours</b>
        <p class="muted" style="margin:4px 0 16px">Sélectionnez une table et choisissez vos consommations.</p>
        <a class="btn big" href="#/menu">Voir le menu</a>
      </div>
    `, 'order');
    return;
  }

  // Actualisation statut
  try {
    const updated = await api('GET', `/orders/${S.activeOrder.id}`);
    if (updated) {
      S.activeOrder = updated;
      S.orderStatus = updated.status;
      LS.set('order', updated);
    }
  } catch {}

  const st = S.activeOrder.status;

  // Calcul état d'avancement direct
  const steps = [
    { key: 'SUBMITTED', label: '1. Envoyée', desc: 'En attente de prise en charge par le vendeur' },
    { key: 'RECEIVED', label: '2. Reçue par le vendeur', desc: 'Confirmée ! Votre commande arrive à votre table' },
    { key: 'COMPLETED', label: '3. Servie & Terminée', desc: 'Commande servie avec succès' }
  ];

  const orderLevels = { SUBMITTED: 1, RECEIVED: 2, PREPARING: 2, READY: 2, DELIVERED: 2, COMPLETED: 3 };
  const currentLevel = orderLevels[st] || 1;

  shell('Suivi Commande', `
    <div class="card" style="text-align:center;padding:20px 16px">
      <div class="badge ${st === 'RECEIVED' || st === 'PREPARING' || st === 'READY' ? 'g' : 'orange'}" style="font-size:0.85rem;margin:0 auto 8px">
        ${esc(statusLabel(st))}
      </div>
      <b style="font-size:1.3rem;display:block">Table ${esc(S.activeOrder.point?.label || '')}</b>
      <div class="muted">${esc(S.activeOrder.establishment?.name || '')} • ${new Date(S.activeOrder.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
    </div>

    <!-- Stepper 3D en direct -->
    <div class="card" style="margin-top:12px">
      <b style="display:block;margin-bottom:14px">État de votre commande :</b>
      <div class="col" style="gap:14px">
        ${steps.map((sp, idx) => {
          const stepNum = idx + 1;
          const isDone = currentLevel > stepNum;
          const isCurrent = currentLevel === stepNum;
          return `
            <div class="row" style="align-items:flex-start;gap:12px">
              <div style="width:32px;height:32px;border-radius:50%;display:grid;place-items:center;font-weight:800;font-size:0.85rem;${isCurrent ? 'background:var(--p);color:#fff;box-shadow:0 0 12px rgba(194,65,12,0.4);animation:pulse 2s infinite' : isDone ? 'background:#059669;color:#fff' : 'background:#e2e8f0;color:#64748b'}">
                ${isDone ? '✓' : stepNum}
              </div>
              <div style="flex:1">
                <b style="${isCurrent ? 'color:var(--p)' : ''}">${esc(sp.label)}</b>
                <div class="muted" style="font-size:0.82rem">${esc(sp.desc)}</div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>

    <!-- Détail des articles -->
    <div class="card" style="margin-top:12px">
      <b style="display:block;margin-bottom:8px">Articles commandés :</b>
      ${(S.activeOrder.items || []).map(i => `
        <div class="row" style="justify-content:space-between;padding:4px 0;font-size:0.9rem">
          <span>${i.quantity} × ${esc(i.name)}</span>
          <b>${fcfa(i.total || (i.unit_price * i.quantity))}</b>
        </div>
      `).join('')}
      <div class="row" style="justify-content:space-between;margin-top:10px;padding-top:8px;border-top:1px solid var(--bd);font-weight:900">
        <span>Total :</span>
        <span style="color:var(--p)">${fcfa(S.activeOrder.total)}</span>
      </div>
    </div>

    <div style="text-align:center;margin-top:16px">
      <a class="btn sec sm" href="#/menu">Commander un supplément</a>
    </div>
  `, 'order');
}

// ==========================================
// ÉCRAN 5 : MON PROFIL SANS JARGON
// ==========================================
function profile() {
  shell('Mon Profil', `
    <div class="card" style="text-align:center;padding:24px 16px">
      <div style="width:64px;height:64px;border-radius:50%;background:#fee2e2;color:var(--p);display:grid;place-items:center;margin:0 auto 10px;font-size:1.8rem;font-weight:900">
        ${esc(S.me?.user?.display_name?.[0] || 'C')}
      </div>
      <b class="hd" style="font-size:1.3rem">${esc(S.me?.user?.display_name || 'Client')}</b>
      <div class="badge g" style="margin:6px auto 0;font-size:0.75rem">Connexion sécurisée par cet appareil</div>
    </div>

    <div class="card col" style="gap:10px;margin-top:12px">
      <b style="font-size:1rem">Sécurité &amp; Accès</b>
      <p class="muted" style="margin:0;font-size:0.85rem">
        Cet appareil vous connecte automatiquement à WANI sans mot de passe.
      </p>

      <button class="sec sm" id="setup-pin-btn" style="width:100%">
        Configurer un code PIN de secours (6 chiffres)
      </button>

      <button class="sec sm" id="setup-bio-btn" style="width:100%">
        Activer la reconnaissance (Empreinte / Visage)
      </button>

      <button class="sec sm" id="logout-btn" style="color:var(--er);margin-top:8px">
        Déconnexion de cet appareil
      </button>
    </div>
  `, 'profile');

  $('#setup-pin-btn')?.addEventListener('click', async () => {
    const pin = prompt('Entrez votre code de secours à 6 chiffres :');
    if (!pin || !/^\d{6}$/.test(pin)) return alert('Le code doit comporter exactement 6 chiffres.');
    await KS.setPin(pin);
    toast('Code de secours à 6 chiffres configuré avec succès !');
  });

  $('#setup-bio-btn')?.addEventListener('click', async () => {
    try {
      await KS.registerBiometric(S.me.user.display_name);
      toast('Reconnaissance activée !');
    } catch {
      toast('Biométrie non disponible sur cet appareil', 'info');
    }
  });

  $('#logout-btn')?.addEventListener('click', () => {
    if (confirm('Voulez-vous vraiment vous déconnecter ?')) {
      S.tokens = null;
      S.me = null;
      LS.del('auth');
      LS.del('table_ctx');
      welcome();
    }
  });
}

// ==========================================
// ROUTAGE PRINCIPAL
// ==========================================
async function route() {
  const h = location.hash.replace('#/', '').split('?')[0];
  if (!S.tokens?.access) {
    // Si une table est passée dans l'URL ?q=token
    const q = new URLSearchParams(location.search).get('q');
    if (q) LS.set('pending_qr', q);
    return welcome();
  }

  if (!S.me) {
    try { await loadMe(); } catch { return welcome(); }
  }

  // Traiter un éventuel QR en attente
  const pq = LS.get('pending_qr', null);
  if (pq) {
    LS.del('pending_qr');
    try {
      const info = await raw('GET', '/qr/' + encodeURIComponent(pq));
      S.ctx = { establishment: info.establishment, zone: info.zone, point: info.point, token: pq };
      LS.set('table_ctx', S.ctx);
      location.hash = '#/menu';
      return menu();
    } catch {}
  }

  switch (h) {
    case 'menu': return menu();
    case 'order': return track();
    case 'profile': return profile();
    default: return home();
  }
}

async function init() {
  // Détecter un token QR direct dans l'URL
  const q = new URLSearchParams(location.search).get('q');
  if (q) LS.set('pending_qr', q);

  if (S.tokens?.access) {
    try {
      await loadMe();
      connectSse();
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
      connectSse();
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
