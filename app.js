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
// UTILITAIRES : COPIE, PARTAGE, TÉLÉCHARGEMENT & BIOMÉTRIE
// ==========================================
function copyText(text, successMsg = 'Copié dans le presse-papier !') {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => toast(successMsg, 'ok')).catch(() => fallbackCopy(text, successMsg));
  } else {
    fallbackCopy(text, successMsg);
  }
}

function fallbackCopy(text, successMsg) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    toast(successMsg, 'ok');
  } catch {
    prompt('Copiez le texte ci-dessous :', text);
  }
  ta.remove();
}

async function shareText(title, text) {
  if (navigator.share) {
    try {
      await navigator.share({ title, text });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  copyText(text, 'Copié dans le presse-papier pour le partage !');
}

function downloadFile(filename, content) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast('Fichier téléchargé avec succès !', 'ok');
}

function resizeImageToDataUrl(file, maxSize = 240) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let w = img.width, h = img.height;
        if (w > h) {
          if (w > maxSize) { h = Math.round((h * maxSize) / w); w = maxSize; }
        } else {
          if (h > maxSize) { w = Math.round((w * maxSize) / h); h = maxSize; }
        }
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function isBiometricAvailable() {
  if (window.PublicKeyCredential &&
      typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function') {
    try {
      return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch {
      return false;
    }
  }
  return false;
}

async function enableBiometrics() {
  if (!window.PublicKeyCredential) {
    alert("La biométrie n'est pas prise en charge par ce navigateur.");
    return false;
  }
  const avail = await isBiometricAvailable();
  if (!avail) {
    alert("Aucun capteur biométrique (Face ID, empreinte) n'est configuré ou disponible sur cet appareil.");
    return false;
  }
  try {
    const challenge = new Uint8Array(32);
    crypto.getRandomValues(challenge);
    const userId = new Uint8Array(16);
    crypto.getRandomValues(userId);

    const cred = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { name: 'WANI Vendeur' },
        user: {
          id: userId,
          name: S.me?.display_name || 'Vendeur',
          displayName: S.me?.display_name || 'Vendeur'
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 }
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required'
        },
        timeout: 60000
      }
    });
    if (cred) {
      localStorage.setItem('wani_bio_enabled', '1');
      toast('Biométrie activée avec succès !', 'ok');
      return true;
    }
  } catch (err) {
    if (err.name !== 'NotAllowedError') {
      alert("Activation biométrique impossible : " + (err.message || err));
    }
    return false;
  }
  return false;
}

function disableBiometrics() {
  localStorage.removeItem('wani_bio_enabled');
  toast('Biométrie désactivée.', 'info');
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
    const mem = S.me.memberships.find(m => S.currentEst && m.establishment_id === S.currentEst.id) || S.me.memberships[0];
    S.currentEst = {
      id: mem.establishment_id,
      name: mem.name,
      logo: mem.logo || null,
      role: mem.role
    };
    LS.set('current_est', S.currentEst);
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
        <div class="row" style="gap:8px;align-items:center;cursor:pointer" id="hdr-brand-click" title="Gérer l'établissement et les paramètres">
          ${S.currentEst?.logo ? `
            <img src="${esc(S.currentEst.logo)}" alt="Logo" style="width:34px;height:34px;border-radius:8px;object-fit:cover;border:1px solid #14b8a6">
          ` : `
            <div style="width:34px;height:34px;border-radius:8px;background:#0d9488;color:#fff;display:grid;place-items:center;font-weight:900;font-family:var(--hd);font-size:1.15rem">${esc((S.currentEst?.name || 'W').trim()[0].toUpperCase())}</div>
          `}
          <div style="max-width:160px">
            <b class="hd" style="font-size:1.05rem;color:#fff;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(title)}</b>
            <div style="font-size:0.75rem;color:#5eead4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(S.currentEst?.name || 'Vendeur')}</div>
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
        <span class="material-symbols-outlined">settings</span>Bilan & Équipe
      </a>
    </nav>
  `;

  $('#hdr-brand-click')?.addEventListener('click', () => {
    location.hash = '#/stats';
  });
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

      ${(localStorage.getItem('wani_bio_enabled') === '1' && localStorage.getItem('device_id')) ? `
        <div style="margin:0 auto 14px;max-width:360px">
          <button class="big" id="v-bio-login-btn" style="background:#0f766e;width:100%;display:flex;align-items:center;justify-content:center;gap:8px">
            <span class="material-symbols-outlined text-[24px]">fingerprint</span>
            Déverrouiller avec la biométrie
          </button>
        </div>
      ` : ''}

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

        <!-- Option équipe (serveurs avec code d'invitation, code secours ou association) -->
        <div style="margin-top:14px;padding-top:12px;border-top:1px dashed var(--bd)">
          <details id="v-invite-details" style="font-size:0.85rem">
            <summary style="cursor:pointer;color:#0f766e;font-weight:700">👉 Vous avez un code d'invitation, d'association ou de secours ?</summary>
            <div style="margin-top:8px">
              <label class="muted" style="font-weight:600;font-size:0.8rem">Code secret (serveur, association ou secours) :</label>
              <input id="v-code" placeholder="Ex: XXXXX-XXXXX ou WANI-XXXX-YYYY" style="margin-top:4px;font-size:0.9rem;text-transform:uppercase;font-family:monospace">
              <div style="font-size:0.75rem;color:#64748b;margin-top:4px">
                💡 <em>Laissez vide si vous êtes le gérant sur votre appareil habituel.</em>
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

  $('#v-bio-login-btn')?.addEventListener('click', async () => {
    try {
      toast('Vérification biométrique...', 'info');
      await login();
      location.hash = '#/orders';
      route();
    } catch (e) {
      alert('Connexion biométrique : ' + (e.message || e));
    }
  });

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

            ${o.payment_status === 'PAID' ? `
              ${(o.cashed_by_device_id === S.me?.device_id || o.cashed_by_user_id === S.me?.id) ? `
                <div style="background:#ecfdf5;border:1px solid #a7f3d0;padding:8px 10px;border-radius:8px;font-weight:700;color:#047857;margin-bottom:8px;font-size:0.88rem;display:flex;align-items:center;gap:6px">
                  <span class="material-symbols-outlined text-[18px]">verified</span>
                  Somme de ${fcfa(o.total)} encaissée par vous
                </div>
              ` : `
                <div style="background:#f1f5f9;border:1px solid #cbd5e1;padding:8px 10px;border-radius:8px;font-size:0.85rem;color:#334155;margin-bottom:8px;display:flex;align-items:center;gap:6px">
                  <span class="material-symbols-outlined text-[18px]">check_circle</span>
                  Encaissée par <strong>${esc(o.cashed_by_name || 'Équipe')}</strong>${o.cashed_by_device_name ? ` [${esc(o.cashed_by_device_name)}]` : ''}
                </div>
              `}
            ` : ''}

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
      if (method === null) return;
      const methods = { '1': 'CASH', '2': 'ORANGE_MONEY', '3': 'MOOV_MONEY', '4': 'CARD' };
      const chosen = methods[method] || 'CASH';
      try {
        await api('POST', `/orders/${id}/payment`, { method: chosen, amount: Number(total) });
        await api('POST', `/orders/${id}/status`, { status: 'COMPLETED' });
        toast(`Somme de ${fcfa(Number(total))} encaissée par vous !`, 'ok');
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
    // 1. Préfixe dérivé de l'établissement si possible (ex: M pour Maquis, T pour Terrasse)
    let estPfx = '';
    if (S.currentEst?.name) {
      const words = S.currentEst.name.toUpperCase().replace(/[^A-Z0-9\s]/g, '').split(/\s+/).filter(Boolean);
      const stopWords = ['LE', 'LA', 'LES', 'DU', 'DE', 'DES', 'AU', 'AUX', 'CHEZ', 'ET', 'UN', 'UNE'];
      const target = words.filter(w => !stopWords.includes(w));
      if (target.length) estPfx = target[0][0];
    }

    let prefix = estPfx || 'T';
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
      else prefix = estPfx || 'T';

      if (match[2]) {
        const candidate = `${prefix}${String(match[2]).padStart(2, '0')}`;
        if (!existingCodes.includes(candidate)) return candidate;
      }
    }
    for (let i = 1; i <= 99; i++) {
      const candidate = `${prefix}${String(i).padStart(2, '0')}`;
      if (!existingCodes.includes(candidate)) return candidate;
    }
    return `${prefix || 'P'}${Math.floor(10 + Math.random() * 90)}`;
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
          Code unique et facile à mémoriser pour le client afin d'éviter toute confusion avec un autre établissement.
        </div>

        <div id="code-input-area" style="margin-top:10px">
          <label class="muted" style="font-weight:700;font-size:0.8rem">Code court client (ex: T500, M505) :</label>
          <input id="pt-code" value="${initialCode}" style="font-family:monospace;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;margin-top:4px;font-size:1.05rem" maxlength="15" autocomplete="off">
          <div id="code-status" style="font-size:0.75rem;margin-top:4px;font-weight:600;color:#0f766e">
            ✓ Code disponible et unique
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

  let checkTimer = null;
  function triggerCheck() {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(checkCodeAvail, 250);
  }

  async function checkCodeAvail() {
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
    try {
      const res = await raw('GET', `/reception-points/check-code?code=${encodeURIComponent(val)}&est_id=${S.currentEst?.id || ''}`);
      if (!res.available) {
        statusBox.innerHTML = `<span style="color:var(--er)">⚠️ ${esc(res.message || 'Ce code est déjà utilisé.')}</span>`;
        saveBtn.disabled = true;
        return false;
      }
      statusBox.innerHTML = `<span style="color:#0f766e">✓ ${esc(res.message || 'Code disponible et unique ! Vos clients accèderont directement à votre boutique.')}</span>`;
      saveBtn.disabled = false;
      return true;
    } catch {
      statusBox.innerHTML = '<span style="color:#0f766e">✓ Code prêt à être enregistré</span>';
      saveBtn.disabled = false;
      return true;
    }
  }

  labelIn.addEventListener('input', () => {
    if (autoChk.checked) {
      codeIn.value = suggestNextCode(labelIn.value);
      triggerCheck();
    }
  });

  autoChk.addEventListener('change', () => {
    if (autoChk.checked) {
      codeIn.value = suggestNextCode(labelIn.value);
    }
    triggerCheck();
  });

  codeIn.addEventListener('input', () => {
    codeIn.value = codeIn.value.toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    if (autoChk.checked && codeIn.value !== suggestNextCode(labelIn.value)) {
      autoChk.checked = false;
    }
    triggerCheck();
  });

  saveBtn.onclick = async () => {
    const label = labelIn.value.trim();
    const code = (codeIn.value || '').trim().toUpperCase();
    if (!label) return alert('Veuillez entrer un nom ou numéro pour ce point de livraison.');

    saveBtn.disabled = true;
    try {
      await api('POST', `/establishments/${S.currentEst.id}/points`, { label, code });
      closeModal();
      toast('Point de livraison créé avec succès !', 'ok');
      tablesView();
    } catch (e) {
      saveBtn.disabled = false;
      const msg = e.message || String(e);
      const m = msg.match(/ex:\s*([A-Z0-9_-]+)/i);
      const suggestedCode = m ? m[1] : null;
      statusBox.innerHTML = `
        <div style="background:#fef2f2;border:1px solid #fecaca;padding:10px 12px;border-radius:8px;color:#991b1b;font-size:0.85rem;margin-top:6px">
          <div>⚠️ ${esc(msg)}</div>
          ${suggestedCode ? `
            <button type="button" class="sm ok" id="adopt-suggested-code" style="margin-top:8px;background:#0f766e;width:100%">
              👉 Utiliser le code vérifié "${esc(suggestedCode)}"
            </button>
          ` : ''}
        </div>
      `;
      if (suggestedCode) {
        $('#adopt-suggested-code').onclick = () => {
          codeIn.value = suggestedCode;
          triggerCheck();
        };
      }
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
// EXPORTATION & HISTORIQUE DES ENCAISSEMENTS
// ==========================================
function exportOrdersToCsv(orders) {
  const headers = ['Date', 'Heure', 'Point/Table', 'Articles', 'Total_FCFA', 'Mode_Paiement', 'Encaisseur', 'Appareil'];
  const rows = [headers.join(';')];
  for (const o of orders) {
    const d = new Date(o.cashed_at || o.created_at);
    const dateStr = d.toLocaleDateString('fr-FR');
    const timeStr = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const itemsStr = (o.items || []).map(i => `${i.quantity}x ${i.name}`).join(' | ');
    rows.push([
      dateStr,
      timeStr,
      `"${(o.point?.label || o.reception_point_id || '').replace(/"/g, '""')}"`,
      `"${itemsStr.replace(/"/g, '""')}"`,
      o.total,
      o.payment_method || 'CASH',
      `"${(o.cashed_by_name || '').replace(/"/g, '""')}"`,
      `"${(o.cashed_by_device_name || '').replace(/"/g, '""')}"`
    ].join(';'));
  }
  return rows.join('\r\n');
}

function exportOrdersToTxt(orders, title = 'Rapport des Encaissements') {
  const total = orders.reduce((sum, o) => sum + (o.total || 0), 0);
  const lines = [
    `=== WANI — ${title.toUpperCase()} ===`,
    `Établissement : ${S.currentEst?.name || 'WANI'}`,
    `Date d'export : ${new Date().toLocaleString('fr-FR')}`,
    `Nombre de commandes : ${orders.length}`,
    `Total encaissé : ${fcfa(total)}`,
    '--------------------------------------------------',
    ''
  ];
  for (const o of orders) {
    const d = new Date(o.cashed_at || o.created_at);
    const dateStr = d.toLocaleDateString('fr-FR');
    const timeStr = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const itemsStr = (o.items || []).map(i => `${i.quantity}× ${i.name}`).join(', ');
    lines.push(`• Commande #${(o.id || '').slice(0, 6)} — ${dateStr} à ${timeStr}`);
    lines.push(`  Table : ${o.point?.label || o.reception_point_id || 'Table'}`);
    lines.push(`  Articles : ${itemsStr}`);
    lines.push(`  Montant : ${fcfa(o.total)} (${o.payment_method || 'Espèces'})`);
    if (o.cashed_by_name) {
      lines.push(`  Encaissé par : ${o.cashed_by_name}${o.cashed_by_device_name ? ` [${o.cashed_by_device_name}]` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function showCashedOrdersModal(orders, title = 'Commandes Encaissées') {
  const total = orders.reduce((sum, o) => sum + (o.total || 0), 0);
  const m = document.createElement('div');
  m.className = 'modal-back';
  m.innerHTML = `
    <div class="modal-box col" style="max-width:520px;max-height:85vh;position:relative">
      <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:8px">
        <b class="hd" style="font-size:1.2rem">${esc(title)}</b>
        <button class="sm sec" id="close-cashings-modal">✕</button>
      </div>

      <div style="background:#ecfdf5;border:1px solid #a7f3d0;padding:12px;border-radius:10px;text-align:center;margin-bottom:12px">
        <span style="font-size:0.8rem;color:#047857;font-weight:700">Total encaissé</span>
        <b style="font-size:1.8rem;color:#047857;display:block;margin:2px 0">${fcfa(total)}</b>
        <div style="font-size:0.8rem;color:#065f46">${orders.length} commande(s) enregistrée(s)</div>
      </div>

      <!-- Actions Exportables -->
      <div class="row" style="gap:6px;flex-wrap:wrap;justify-content:center;margin-bottom:12px">
        <button class="sm sec" id="copy-cashings-btn">📋 Copier</button>
        <button class="sm sec" id="csv-cashings-btn" style="border-color:#0f766e;color:#0f766e">💾 CSV</button>
        <button class="sm sec" id="txt-cashings-btn">📄 TXT</button>
        <button class="sm ok" id="share-cashings-btn" style="background:#0f766e">📲 Partager</button>
      </div>

      <!-- Liste détaillée des commandes -->
      <div class="col" style="gap:8px;overflow-y:auto;max-height:360px;padding-right:4px">
        ${orders.length ? orders.map(o => `
          <div class="card col" style="padding:10px;border-left:4px solid #059669;gap:4px">
            <div class="row" style="justify-content:space-between;align-items:center">
              <div>
                <strong>Table ${esc(o.point?.label || o.reception_point_id || 'Table')}</strong>
                <span class="muted" style="font-size:0.75rem;margin-left:6px">
                  ${new Date(o.cashed_at || o.created_at).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <b style="color:#047857;font-size:1.05rem">${fcfa(o.total)}</b>
            </div>
            <div style="font-size:0.85rem;color:var(--tx-muted)">
              ${(o.items || []).map(i => `${i.quantity}× ${esc(i.name)}`).join(', ')}
            </div>
            <div class="row" style="justify-content:space-between;align-items:center;font-size:0.78rem;margin-top:2px;color:#64748b">
              <span>💳 ${esc(o.payment_method || 'CASH')}</span>
              ${o.cashed_by_name ? `<span>👤 ${esc(o.cashed_by_name)}${o.cashed_by_device_name ? ` [${esc(o.cashed_by_device_name)}]` : ''}</span>` : ''}
            </div>
          </div>
        `).join('') : `
          <div class="muted" style="text-align:center;padding:24px">Aucune commande encaissée pour le moment.</div>
        `}
      </div>
    </div>
  `;
  document.body.appendChild(m);

  $('#close-cashings-modal').onclick = () => m.remove();
  m.onclick = (e) => { if (e.target === m) m.remove(); };

  $('#copy-cashings-btn').onclick = () => {
    const txt = exportOrdersToTxt(orders, title);
    copyText(txt, 'Rapport copié dans le presse-papiers !');
  };
  $('#csv-cashings-btn').onclick = () => {
    const csv = exportOrdersToCsv(orders);
    downloadFile(`encaissements-wani-${Date.now()}.csv`, csv, 'text/csv;charset=utf-8;');
    toast('Fichier CSV téléchargé !', 'ok');
  };
  $('#txt-cashings-btn').onclick = () => {
    const txt = exportOrdersToTxt(orders, title);
    downloadFile(`encaissements-wani-${Date.now()}.txt`, txt, 'text/plain;charset=utf-8;');
    toast('Rapport texte téléchargé !', 'ok');
  };
  $('#share-cashings-btn').onclick = () => {
    const txt = exportOrdersToTxt(orders, title);
    shareText(`${title} - ${S.currentEst?.name}`, txt);
  };
}

// ==========================================
// ÉCRAN 5 : BILAN, ÉQUIPE & PARAMÈTRES ÉTABLISSEMENT
// ==========================================
async function statsView() {
  if (!S.currentEst) return;
  let stats = { revenue_paid: 0, orders: [], is_manager: false, cashed_orders: [], my_cashed_orders: [], cashiers: [] };
  try {
    stats = await api('GET', `/statistics?establishment_id=${S.currentEst.id}`);
  } catch {}

  const isManager = S.currentEst?.role === 'MANAGER' || !!stats.is_manager;
  const bioActive = localStorage.getItem('wani_bio_enabled') === '1';

  shell('Bilan & Équipe', `
    <!-- 1. En-tête Établissement : Logo & Nom modifiables -->
    <div class="card col" style="gap:14px;text-align:left">
      <div class="row" style="justify-content:space-between;align-items:center">
        <b style="font-size:1.15rem;color:var(--tx)">Votre Établissement</b>
        <span class="pill" style="font-size:0.75rem">${isManager ? 'Gérant Principal' : 'Serveur / Équipe'}</span>
      </div>

      <!-- Aperçu et modification du Logo -->
      <div class="row" style="gap:14px;align-items:center;background:#f8fafc;padding:12px;border-radius:12px;border:1px solid #e2e8f0">
        <div style="position:relative;width:68px;height:68px;border-radius:14px;background:#0d9488;display:grid;place-items:center;color:#fff;font-weight:900;font-size:2rem;overflow:hidden;border:2px solid #14b8a6;box-shadow:0 4px 10px rgba(13,148,136,0.15)">
          ${S.currentEst?.logo ? `
            <img src="${esc(S.currentEst.logo)}" alt="Logo" style="width:100%;height:100%;object-fit:cover">
          ` : `
            <span>${esc((S.currentEst?.name || 'W').trim()[0].toUpperCase())}</span>
          `}
        </div>

        <div class="col" style="gap:6px;flex:1">
          <div style="font-size:0.85rem;font-weight:700">Logo de l'établissement :</div>
          <div class="row" style="gap:6px;flex-wrap:wrap">
            <label class="btn sm" style="background:#0f766e;color:#fff;cursor:pointer;display:inline-flex;align-items:center;gap:4px">
              <span class="material-symbols-outlined text-[16px]">add_photo_alternate</span>
              Changer le logo
              <input type="file" id="est-logo-file" accept="image/*" style="display:none">
            </label>
            ${S.currentEst?.logo ? `
              <button class="sec sm" id="est-logo-del-btn" style="color:var(--er);border-color:#fecaca">
                <span class="material-symbols-outlined text-[16px]">delete</span>
                Enlever
              </button>
            ` : ''}
          </div>
          <div style="font-size:0.75rem;color:#64748b">Format photo/carré (PNG, JPG). Visible par tous vos clients.</div>
        </div>
      </div>

      <!-- Modification du Nom de l'établissement -->
      <div class="col" style="gap:6px">
        <label class="muted" style="font-weight:700;font-size:0.85rem">Nom de l'établissement :</label>
        <div class="row" style="gap:8px">
          <input id="est-name-in" value="${esc(S.currentEst?.name || '')}" style="font-size:1rem;font-weight:700;flex:1" placeholder="Ex: Maquis Le Régal...">
          <button class="ok" id="save-est-name-btn" style="background:#0f766e;white-space:nowrap;padding:0 16px">Enregistrer</button>
        </div>
      </div>
    </div>

    <!-- 2. Section Encaissements / Bilan Financier -->
    ${!isManager ? `
      <!-- Vue Serveur / Invité : UNIQUEMENT ses propres encaissements -->
      <div class="card col clickable" id="my-cashings-card" style="text-align:center;padding:22px 16px;background:#ecfdf5;border:2px solid #6ee7b7;border-radius:12px;cursor:pointer;box-shadow:0 2px 8px rgba(16,185,129,0.1)">
        <span style="font-size:0.85rem;color:#047857;font-weight:700">Somme encaissée par vous</span>
        <b style="font-size:2.2rem;color:#047857;display:block;margin:4px 0">${fcfa(stats.my_revenue_paid || 0)}</b>
        <div style="display:inline-flex;align-items:center;gap:6px;background:#059669;color:#fff;padding:6px 14px;border-radius:999px;font-size:0.85rem;font-weight:700;margin:4px auto 0">
          <span class="material-symbols-outlined text-[16px]">receipt_long</span>
          ${stats.my_orders_count || 0} commande(s) encaissée(s) par vous • Toucher pour voir le détail 🔍
        </div>
      </div>
    ` : `
      <!-- Vue Gérant Principal : Recette globale et Historique complet filtrable -->
      <div class="card" style="text-align:center;padding:20px 16px;background:#ecfdf5;border-color:#6ee7b7">
        <span class="muted" style="font-size:0.85rem">Recette totale de l'établissement</span>
        <b style="font-size:2.2rem;color:#047857;display:block;margin-top:4px">${fcfa(stats.revenue_paid || 0)}</b>
        <div class="muted" style="font-size:0.85rem;margin-top:4px">${stats.total_orders_count || 0} commande(s) encaissée(s) au total</div>
        ${stats.my_revenue_paid ? `
          <div style="font-size:0.8rem;color:#065f46;margin-top:6px;font-weight:600">
            (Dont ${fcfa(stats.my_revenue_paid)} encaissés personnellement par vous)
          </div>
        ` : ''}
      </div>

      <!-- Historique des commandes encaissées filtrable pour le gérant -->
      <div class="card col" style="gap:12px">
        <div class="row" style="justify-content:space-between;align-items:center">
          <b style="font-size:1.1rem;color:var(--tx)">📋 Commandes encaissées &amp; Équipe</b>
          <button class="sm sec" id="btn-all-orders" style="font-size:0.75rem">Toutes les commandes</button>
        </div>

        <!-- Filtres interactifs : Date, Heure, Nom Encaisseur -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;background:#f8fafc;padding:10px;border-radius:10px;border:1px solid #e2e8f0">
          <div class="col" style="gap:4px">
            <label style="font-size:0.75rem;font-weight:700;color:var(--tx-muted)">Date :</label>
            <div class="row" style="gap:4px">
              <input type="date" id="filter-date" style="padding:6px;font-size:0.82rem;flex:1">
              <button class="sm sec" id="btn-today-filter" style="padding:0 8px;font-size:0.75rem">Auj.</button>
            </div>
          </div>

          <div class="col" style="gap:4px">
            <label style="font-size:0.75rem;font-weight:700;color:var(--tx-muted)">Créneau horaire :</label>
            <select id="filter-hour" style="padding:6px;font-size:0.82rem">
              <option value="">Toutes les heures</option>
              <option value="matin">Matin (06h - 12h)</option>
              <option value="midi">Midi (12h - 15h)</option>
              <option value="aprem">Après-midi (15h - 19h)</option>
              <option value="soir">Soirée (19h - 00h)</option>
              <option value="nuit">Nuit (00h - 06h)</option>
            </select>
          </div>

          <div class="col" style="gap:4px;grid-column:span 2">
            <label style="font-size:0.75rem;font-weight:700;color:var(--tx-muted)">Nom de l'encaisseur :</label>
            <select id="filter-cashier" style="padding:6px;font-size:0.85rem">
              <option value="">Tous les encaisseurs</option>
              ${(stats.cashiers || []).map(c => `
                <option value="${esc(c.user_id)}">${esc(c.name || 'Inconnu')}</option>
              `).join('')}
            </select>
          </div>
        </div>

        <!-- Barre de résumé dynamique & Exports -->
        <div class="row" style="justify-content:space-between;align-items:center;background:#f0fdfa;border:1px solid #ccfbf1;padding:8px 10px;border-radius:8px">
          <div id="filter-summary-txt" style="font-size:0.85rem;font-weight:700;color:#0f766e"></div>
          <div class="row" style="gap:4px">
            <button class="sm sec" id="copy-filtered-btn" title="Copier le résumé">📋 Copier</button>
            <button class="sm sec" id="csv-filtered-btn" title="Télécharger CSV" style="border-color:#0f766e;color:#0f766e">💾 CSV</button>
            <button class="sm ok" id="share-filtered-btn" style="background:#0f766e" title="Partager">📲 Partager</button>
          </div>
        </div>

        <!-- Liste des commandes filtrées -->
        <div id="filtered-orders-list" class="col" style="gap:8px;max-height:420px;overflow-y:auto;padding-right:2px"></div>
      </div>
    `}

    <!-- 3. Inviter un serveur / employé (accessible au gérant) -->
    ${isManager ? `
      <div class="card col" style="gap:10px">
        <b style="font-size:1.1rem">Inviter un serveur / employé</b>
        <p class="muted" style="margin:0;font-size:0.85rem">
          Générez un code temporaire pour permettre à un serveur ou caissier d'accéder au tableau de bord sans mot de passe.
        </p>
        <button class="big sm" id="gen-invite-btn" style="background:#0f766e">Générer un code serveur (24h)</button>
        <div id="invite-box" style="display:none;padding:12px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;text-align:center">
          <div id="invite-code-txt" style="font-family:monospace;font-size:1.4rem;font-weight:900;letter-spacing:2px;color:#042f2e;margin-bottom:8px"></div>
          <div class="row" style="gap:8px;justify-content:center">
            <button class="sm sec" id="copy-invite-btn">📋 Copier le code</button>
            <button class="sm ok" id="share-invite-btn" style="background:#0f766e">📲 Partager</button>
          </div>
        </div>
      </div>
    ` : ''}

    <!-- 4. Sécurité, Biométrie, Appareils & Codes de secours -->
    <div class="card col" style="gap:12px">
      <b style="font-size:1.1rem;color:var(--tx)">Sécurité &amp; Accès sans mot de passe</b>

      <!-- Biométrie -->
      <div style="background:#f0fdfa;border:1px solid #ccfbf1;padding:12px;border-radius:10px">
        <div class="row" style="justify-content:space-between;align-items:center">
          <div style="font-weight:700;color:#0f766e;display:flex;align-items:center;gap:6px">
            <span class="material-symbols-outlined text-[20px]">fingerprint</span>
            Biométrie (Face ID / Empreinte)
          </div>
          ${bioActive ? `
            <span class="badge g" style="font-size:0.75rem">Active</span>
          ` : `
            <span class="badge orange" style="font-size:0.75rem">Désactivée</span>
          `}
        </div>
        <p class="muted" style="margin:6px 0 10px;font-size:0.8rem">
          Déverrouillez rapidement l'espace vendeur avec l'empreinte digitale ou Face ID de cet appareil.
        </p>
        ${bioActive ? `
          <button class="sm sec" id="toggle-bio-btn" style="color:var(--er);border-color:#fecaca">Désactiver la biométrie</button>
        ` : `
          <button class="sm ok" id="toggle-bio-btn" style="background:#0f766e">Activer la biométrie</button>
        `}
      </div>

      <!-- Ajouter un autre appareil -->
      <div style="background:#f8fafc;border:1px solid var(--bd);padding:12px;border-radius:10px">
        <b style="display:block;font-size:0.95rem;margin-bottom:4px">📱 Ajouter un autre appareil (téléphone, tablette)</b>
        <p class="muted" style="margin:0 0 10px;font-size:0.8rem">
          Associez un autre appareil pour gérer vos commandes simultanément sans mot de passe.
        </p>
        <button class="sm sec" id="add-device-btn" style="border:1.5px solid #0f766e;color:#0f766e;font-weight:700">
          + Associer un nouvel appareil
        </button>
        <div id="device-box" style="display:none;margin-top:10px;padding:12px;background:#fff;border-radius:8px;border:1px solid #e2e8f0;text-align:center">
          <div style="font-size:0.75rem;color:#64748b;margin-bottom:4px">Code d'association (valable 24h) :</div>
          <div id="device-code-txt" style="font-family:monospace;font-size:1.4rem;font-weight:900;letter-spacing:2px;color:#0f766e;margin-bottom:8px"></div>
          <div class="row" style="gap:8px;justify-content:center">
            <button class="sm sec" id="copy-device-btn">📋 Copier</button>
            <button class="sm ok" id="share-device-btn" style="background:#0f766e">📲 Partager</button>
          </div>
          <div style="font-size:0.75rem;color:#64748b;margin-top:8px;line-height:1.3">
            Sur votre autre appareil, ouvrez WANI Vendeur, touchez « Code d'invitation ou d'association » et entrez ce code.
          </div>
        </div>
      </div>

      <!-- Codes de secours -->
      <div style="background:#fffbeb;border:1px solid #fef3c7;padding:12px;border-radius:10px">
        <div style="display:flex;align-items:center;gap:6px;font-weight:700;color:#92400e;margin-bottom:4px">
          <span class="material-symbols-outlined text-[20px]">shield</span>
          Codes de secours (Récupération d'urgence)
        </div>
        <p class="muted" style="margin:0 0 10px;font-size:0.8rem;color:#78350f">
          En cas de perte ou de panne de cet appareil, ces codes secrets vous permettent de récupérer immédiatement votre compte sans mot de passe.
        </p>
        <button class="sm sec" id="show-backup-btn" style="border:1.5px solid #d97706;color:#b45309;font-weight:700;background:#fff">
          🛡️ Voir / Générer mes codes de secours
        </button>

        <div id="backup-box" style="display:none;margin-top:10px;padding:12px;background:#fff;border-radius:8px;border:1px solid #fde68a">
          <div style="font-size:0.78rem;font-weight:700;color:#92400e;margin-bottom:8px">Vos 5 codes de secours secrets (usage unique, 1 an) :</div>
          <div id="backup-list" style="display:grid;grid-template-columns:1fr;gap:6px;font-family:monospace;font-weight:800;font-size:1.05rem;color:#1e293b;padding:8px;background:#fefce8;border-radius:6px;margin-bottom:10px"></div>
          <div class="row" style="gap:6px;flex-wrap:wrap;justify-content:center">
            <button class="sm sec" id="copy-backup-btn">📋 Copier les codes</button>
            <button class="sm sec" id="download-backup-btn" style="border-color:#d97706;color:#92400e">💾 Télécharger (.txt)</button>
            <button class="sm ok" id="share-backup-btn" style="background:#0f766e">📲 Partager</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 5. Déconnexion -->
    <div class="card col" style="margin-top:12px">
      <b style="font-size:1.1rem">Déconnexion</b>
      <button class="sec sm" id="v-logout-btn" style="color:var(--er);margin-top:8px">Se déconnecter de cet appareil</button>
    </div>
  `, 'stats');

  // Clic sur le bilan personnel (invité)
  $('#my-cashings-card')?.addEventListener('click', () => {
    showCashedOrdersModal(stats.my_cashed_orders || [], 'Vos encaissements personnels');
  });

  // Logique de filtrage des commandes pour le gérant
  if (isManager) {
    const allCashedOrders = stats.cashed_orders || [];
    const dateInput = $('#filter-date');
    const hourSelect = $('#filter-hour');
    const cashierSelect = $('#filter-cashier');
    const summaryTxt = $('#filter-summary-txt');
    const listContainer = $('#filtered-orders-list');

    let currentFiltered = [...allCashedOrders];

    function applyFilters() {
      if (!listContainer) return;
      const dateVal = dateInput?.value || '';
      const hourVal = hourSelect?.value || '';
      const cashierVal = cashierSelect?.value || '';

      currentFiltered = allCashedOrders.filter(o => {
        const d = new Date(o.cashed_at || o.created_at);
        if (dateVal) {
          const isoDate = d.toISOString().slice(0, 10);
          if (isoDate !== dateVal) return false;
        }
        if (hourVal) {
          const h = d.getHours();
          if (hourVal === 'matin' && (h < 6 || h >= 12)) return false;
          if (hourVal === 'midi' && (h < 12 || h >= 15)) return false;
          if (hourVal === 'aprem' && (h < 15 || h >= 19)) return false;
          if (hourVal === 'soir' && (h < 19 || h > 23)) return false;
          if (hourVal === 'nuit' && (h >= 6)) return false;
        }
        if (cashierVal && o.cashed_by_user_id !== cashierVal) {
          return false;
        }
        return true;
      });

      const sum = currentFiltered.reduce((acc, o) => acc + (o.total || 0), 0);
      if (summaryTxt) {
        summaryTxt.textContent = `${currentFiltered.length} commande(s) • Total : ${fcfa(sum)}`;
      }

      if (!currentFiltered.length) {
        listContainer.innerHTML = '<div class="muted" style="text-align:center;padding:24px;font-size:0.85rem">Aucune commande correspondant à ces filtres.</div>';
        return;
      }

      listContainer.innerHTML = currentFiltered.map(o => `
        <div class="card col clickable" data-order-detail-id="${o.id}" style="padding:10px;border-left:4px solid #059669;gap:4px;cursor:pointer">
          <div class="row" style="justify-content:space-between;align-items:center">
            <div>
              <strong>Table ${esc(o.point?.label || o.reception_point_id || 'Table')}</strong>
              <span class="muted" style="font-size:0.75rem;margin-left:6px">
                ${new Date(o.cashed_at || o.created_at).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            <b style="color:#047857;font-size:1.05rem">${fcfa(o.total)}</b>
          </div>
          <div style="font-size:0.85rem;color:var(--tx-muted)">
            ${(o.items || []).map(i => `${i.quantity}× ${esc(i.name)}`).join(', ')}
          </div>
          <div class="row" style="justify-content:space-between;align-items:center;font-size:0.78rem;margin-top:2px;color:#64748b">
            <span>💳 ${esc(o.payment_method || 'CASH')}</span>
            <span>👤 ${esc(o.cashed_by_name || 'Équipe')}${o.cashed_by_device_name ? ` [${esc(o.cashed_by_device_name)}]` : ''}</span>
          </div>
        </div>
      `).join('');

      listContainer.querySelectorAll('[data-order-detail-id]').forEach(card => {
        card.onclick = () => {
          const id = card.getAttribute('data-order-detail-id');
          const target = currentFiltered.find(x => x.id === id);
          if (target) showCashedOrdersModal([target], `Détail Commande #${target.id.slice(0, 6)}`);
        };
      });
    }

    dateInput?.addEventListener('input', applyFilters);
    hourSelect?.addEventListener('change', applyFilters);
    cashierSelect?.addEventListener('change', applyFilters);

    $('#btn-today-filter')?.addEventListener('click', () => {
      if (dateInput) {
        dateInput.value = new Date().toISOString().slice(0, 10);
        applyFilters();
      }
    });

    $('#btn-all-orders')?.addEventListener('click', () => {
      if (dateInput) dateInput.value = '';
      if (hourSelect) hourSelect.value = '';
      if (cashierSelect) cashierSelect.value = '';
      applyFilters();
    });

    $('#copy-filtered-btn')?.addEventListener('click', () => {
      const txt = exportOrdersToTxt(currentFiltered, 'Commandes Filtrées');
      copyText(txt, 'Rapport des commandes filtrées copié !');
    });

    $('#csv-filtered-btn')?.addEventListener('click', () => {
      const csv = exportOrdersToCsv(currentFiltered);
      downloadFile(`commandes-encaissees-${Date.now()}.csv`, csv, 'text/csv;charset=utf-8;');
      toast('Export CSV téléchargé !', 'ok');
    });

    $('#share-filtered-btn')?.addEventListener('click', () => {
      const txt = exportOrdersToTxt(currentFiltered, 'Commandes Filtrées');
      shareText(`Commandes Encaissées - ${S.currentEst?.name}`, txt);
    });

    applyFilters();
  }

  // Gérer l'upload du logo
  $('#est-logo-file')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      toast('Traitement du logo...', 'info');
      const dataUrl = await resizeImageToDataUrl(file, 240);
      await api('PATCH', `/establishments/${S.currentEst.id}`, { logo: dataUrl });
      S.currentEst.logo = dataUrl;
      LS.set('current_est', S.currentEst);
      toast('Logo mis à jour avec succès !', 'ok');
      statsView();
    } catch (err) {
      alert('Erreur lors du changement de logo : ' + (err.message || err));
    }
  });

  // Retirer le logo
  $('#est-logo-del-btn')?.addEventListener('click', async () => {
    if (confirm('Voulez-vous retirer le logo de votre établissement ?')) {
      try {
        await api('PATCH', `/establishments/${S.currentEst.id}`, { logo: null });
        S.currentEst.logo = null;
        LS.set('current_est', S.currentEst);
        toast('Logo retiré.', 'info');
        statsView();
      } catch (err) {
        alert('Erreur: ' + (err.message || err));
      }
    }
  });

  // Enregistrer le nom de l'établissement
  $('#save-est-name-btn')?.addEventListener('click', async () => {
    const name = ($('#est-name-in')?.value || '').trim();
    if (!name) return alert("Veuillez renseigner le nom de l'établissement.");
    try {
      await api('PATCH', `/establishments/${S.currentEst.id}`, { name });
      S.currentEst.name = name;
      LS.set('current_est', S.currentEst);
      toast("Nom de l'établissement mis à jour !", 'ok');
      statsView();
    } catch (err) {
      alert('Erreur : ' + (err.message || err));
    }
  });

  // Générer un code serveur
  $('#gen-invite-btn')?.addEventListener('click', async () => {
    try {
      const r = await api('POST', `/establishments/${S.currentEst.id}/invites`, { role: 'STAFF' });
      const b = $('#invite-box');
      const txt = $('#invite-code-txt');
      b.style.display = 'block';
      txt.textContent = r.code;
      toast('Code serveur généré ! Donnez ce code au serveur.');
      $('#copy-invite-btn').onclick = () => copyText(r.code, 'Code serveur copié !');
      $('#share-invite-btn').onclick = () => shareText(`Code serveur ${S.currentEst.name}`, `Votre code d'accès serveur pour ${S.currentEst.name} : ${r.code}`);
    } catch (e) {
      alert('Erreur: ' + e.message);
    }
  });

  // Activer / désactiver la biométrie
  $('#toggle-bio-btn')?.addEventListener('click', async () => {
    if (localStorage.getItem('wani_bio_enabled') === '1') {
      disableBiometrics();
      statsView();
    } else {
      const ok = await enableBiometrics();
      if (ok) statsView();
    }
  });

  // Ajouter un appareil
  $('#add-device-btn')?.addEventListener('click', async () => {
    try {
      const r = await api('POST', '/me/devices', { ttl: 86400e3 });
      const b = $('#device-box');
      const txt = $('#device-code-txt');
      b.style.display = 'block';
      txt.textContent = r.code;
      toast('Code d\'association créé (valable 24h) !');
      $('#copy-device-btn').onclick = () => copyText(r.code, 'Code d\'association copié !');
      $('#share-device-btn').onclick = () => shareText(`Associer un appareil à ${S.currentEst.name}`, `Code d'association pour ajouter votre appareil à ${S.currentEst.name} sur WANI : ${r.code}`);
    } catch (e) {
      alert('Erreur: ' + e.message);
    }
  });

  // Codes de secours
  $('#show-backup-btn')?.addEventListener('click', async () => {
    try {
      toast('Génération des codes de secours...', 'info');
      const r = await api('POST', '/me/backup-codes');
      const codes = r.codes || [];
      const box = $('#backup-box');
      const list = $('#backup-list');
      box.style.display = 'block';
      list.innerHTML = codes.map(c => `<div>🔑 ${esc(c)}</div>`).join('');

      const content = `CODES DE SECOURS WANI - ${S.currentEst.name}\n` +
        `Date : ${new Date().toLocaleDateString('fr-FR')}\n` +
        `Utilisateur : ${S.me?.display_name || 'Gérant'}\n\n` +
        `Conservez ces codes en lieu sûr. Chaque code permet de reconnecter votre compte sans mot de passe en cas de perte de votre appareil.\n\n` +
        codes.map((c, i) => `${i + 1}. ${c}`).join('\n') + `\n`;

      $('#copy-backup-btn').onclick = () => copyText(codes.join('\n'), 'Tous les codes de secours ont été copiés !');
      $('#download-backup-btn').onclick = () => downloadFile('wani-codes-secours.txt', content);
      $('#share-backup-btn').onclick = () => shareText(`Codes de secours WANI - ${S.currentEst.name}`, content);
      toast('Codes de secours générés avec succès !', 'ok');
    } catch (e) {
      alert('Erreur lors de la génération des codes : ' + (e.message || e));
    }
  });

  // Déconnexion de cet appareil
  $('#v-logout-btn')?.addEventListener('click', () => {
    if (confirm('Voulez-vous vous déconnecter de cet appareil ?')) {
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
