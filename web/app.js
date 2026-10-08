import { KeyStore as K } from './keystore.js';

const $ = document.querySelector.bind(document), app = $('#app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fcfa = n => new Intl.NumberFormat('fr-FR').format(n) + ' FCFA';
const EMO = { Boissons: '🍺', Grillades: '🍗', Accompagnements: '🍌', Plats: '🍛', Desserts: '🍨', Autres: '🍽️' };
const LS = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v))
};

const ST = {
  EXPIRED: 'Expirée', REJECTED: 'Refusée', CANCELLED: 'Annulée',
  SUBMITTED: 'Envoyée (En attente)', RECEIVED: 'Reçue par le vendeur', PREPARING: 'En préparation',
  READY: 'Prête', DELIVERING: 'En livraison', DELIVERED: 'Livrée à table', COMPLETED: 'Terminée'
};
const FLOW = ['SUBMITTED', 'RECEIVED', 'PREPARING', 'READY', 'DELIVERING', 'DELIVERED', 'COMPLETED'];

const S = {
  tok: null,
  me: null,
  ctx: LS.get('ctx', null),
  cart: LS.get('cart', {}),
  products: LS.get('menu', []),
  cats: LS.get('cats', []),
  pending: LS.get('pending', null),
  voice: null,
  poll: null,
  cat: null,
  serviceOpen: LS.get('serviceOpen', true),
  eventSource: null
};

// Synthétiseur de carillon sonore Web Audio (0 latence, 100% natif)
function playOrderChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(587.33, now); // D5
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(880, now + 0.14); // A5

    gain.gain.setValueAtTime(0.25, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.65);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);

    osc1.start(now);
    osc1.stop(now + 0.14);
    osc2.start(now + 0.14);
    osc2.stop(now + 0.65);
  } catch {}
}

const toast = (m, isIcon = 'check_circle') => {
  const existing = $('.toast');
  if (existing) existing.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `<span class="material-symbols-outlined text-[20px]" style="color:#10b981">${isIcon}</span><span>${esc(m)}</span>`;
  document.body.append(t);
  setTimeout(() => t.remove(), 3200);
};

// ---------- API + authentification par clé d'appareil ----------
async function raw(method, path, body, headers = {}) {
  const r = await fetch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(S.tok ? { authorization: 'Bearer ' + S.tok } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || r.status), { status: r.status, code: j.error });
  return j;
}

// Modal de saisie du Code de Secours en cas de défaillance biométrique
function promptBackupCodeModal() {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-content">
        <div style="width:52px;height:52px;border-radius:50%;background:#ffdbce;color:var(--p);display:grid;place-items:center;margin:0 auto 12px">
          <span class="material-symbols-outlined text-[28px]">lock_reset</span>
        </div>
        <h2 style="margin:0 0 6px">Code de Secours</h2>
        <p class="muted" style="margin:0 0 16px">Biométrie indisponible. Saisissez votre code PIN de secours à 6 chiffres.</p>
        <input id="modal-pin" type="tel" maxlength="6" pattern="[0-9]*" class="pin-display" placeholder="••••••" autocomplete="one-time-code" autofocus>
        <p id="modal-err" style="color:var(--er);font-size:0.85rem;margin:6px 0 12px;min-height:20px"></p>
        <div class="row">
          <button class="sec" id="modal-cancel" style="flex:1">Annuler</button>
          <button class="ok" id="modal-ok" style="flex:1">Déverrouiller</button>
        </div>
      </div>
    `;
    document.body.append(overlay);
    const pinInput = overlay.querySelector('#modal-pin');
    pinInput.focus();

    overlay.querySelector('#modal-cancel').onclick = () => {
      overlay.remove();
      resolve(null);
    };

    const submit = () => {
      const val = pinInput.value.trim().replace(/\D/g, '');
      if (val.length < 6) {
        overlay.querySelector('#modal-err').textContent = 'Veuillez saisir les 6 chiffres';
        return;
      }
      overlay.remove();
      resolve(val);
    };

    overlay.querySelector('#modal-ok').onclick = submit;
    pinInput.onkeyup = e => { if (e.key === 'Enter') submit(); };
  });
}

async function login() {
  try {
    await K.unlock(promptBackupCodeModal);
  } catch (err) {
    if (String(err.message).startsWith('LOCKOUT:')) {
      toast(err.message, 'error');
    } else if (err.message === 'INVALID_BACKUP_CODE') {
      toast('Code de secours incorrect', 'error');
    }
    throw err;
  }

  const id = localStorage.getItem('device_id');
  if (!id) throw new Error('NO_DEVICE_ID');
  const { nonce } = await raw('POST', '/auth/device/challenge', { device_id: id });
  const signature = await K.sign(`auth|${id}|${nonce}`);
  S.tok = (await raw('POST', '/auth/device/verify', { device_id: id, nonce, signature })).access_token;
  initRealtime();
}

async function api(method, path, body, headers) {
  try {
    return await raw(method, path, body, headers);
  } catch (e) {
    if (e.status === 401 && localStorage.getItem('device_id')) {
      await login();
      return raw(method, path, body, headers);
    }
    throw e;
  }
}

async function register(name, invite_code) {
  const public_key = await K.create();
  const ts = Date.now();
  const pop = await K.sign(`register|${public_key}|${ts}`);
  const ua = navigator.userAgent;
  const platform = /Android/.test(ua) ? 'android' : /iPhone|iPad/.test(ua) ? 'ios' : 'web';
  try {
    const r = await raw('POST', '/auth/device/register', {
      public_key,
      pop,
      ts,
      display_name: name,
      invite_code: invite_code || undefined,
      device_name: platform === 'web' ? 'Navigateur Sécurisé' : platform,
      platform
    });
    localStorage.setItem('device_id', r.device_id);
  } catch (e) {
    await K.wipe();
    throw e;
  }
}

const online = () => navigator.onLine;

// ---------- TEMPS RÉEL (SSE + Polling Fallback) ----------
function initRealtime() {
  if (S.eventSource) {
    try { S.eventSource.close(); } catch {}
  }
  if (!S.tok) return;

  try {
    const es = new EventSource('/events?token=' + encodeURIComponent(S.tok));
    S.eventSource = es;

    es.addEventListener('NEW_ORDER', e => {
      try {
        const data = JSON.parse(e.data);
        const est = S.me?.memberships?.[0]?.establishment_id;
        if (est && String(data.establishment_id) === String(est)) {
          playOrderChime();
          toast(`Nouvelle commande Table ${data.order?.point?.code || ''}`, 'notifications_active');
          if (location.hash === '#/staff' || location.hash === '#/manager') {
            route();
          }
        }
      } catch {}
    });

    es.addEventListener('ORDER_STATUS', e => {
      try {
        const data = JSON.parse(e.data);
        const last = LS.get('lastOrder');
        if (last && String(last) === String(data.order_id)) {
          toast(`Commande mise à jour : ${ST[data.status] || data.status}`, 'sync');
          if (location.hash === '#/order') route();
        }
        if (location.hash === '#/staff' || location.hash === '#/manager') route();
      } catch {}
    });

    es.addEventListener('ORDER_PAID', () => {
      if (location.hash === '#/staff' || location.hash === '#/order' || location.hash === '#/manager') route();
    });

    es.addEventListener('STOCK_UPDATE', () => {
      loadMenu().then(() => {
        if (location.hash === '#/menu' || location.hash === '#/manager') route();
      });
    });

    es.onerror = () => {
      // Reconnexion automatique assurée par le navigateur
    };
  } catch {}
}

// ---------- DONNÉES ----------
async function loadMenu() {
  if (!S.ctx) return;
  try {
    const [p, c] = await Promise.all([
      api('GET', '/products?establishment_id=' + S.ctx.establishment.id),
      api('GET', '/categories?establishment_id=' + S.ctx.establishment.id)
    ]);
    S.products = p;
    S.cats = c;
    LS.set('menu', S.products);
    LS.set('cats', S.cats);
  } catch {}
}

async function scan(token) {
  const c = await raw('GET', '/qr/' + encodeURIComponent(token));
  S.ctx = { ...c, token };
  LS.set('ctx', S.ctx);
  S.cart = {};
  LS.set('cart', {});
  await loadMenu();
}

const cartLines = () => Object.entries(S.cart).map(([id, q]) => ({ p: S.products.find(p => p.id === id), q })).filter(l => l.p && l.q > 0);
const total = () => cartLines().reduce((a, l) => a + l.p.price * l.q, 0);
const setQ = (id, d) => {
  S.cart[id] = Math.max(0, Math.min(99, (S.cart[id] || 0) + d));
  if (!S.cart[id]) delete S.cart[id];
  LS.set('cart', S.cart);
};

// ---------- VUES & SHELL 3D ----------
const shell = (title, body, tab, sub = '') => {
  const staff = S.me?.memberships?.some(m => m.role !== 'CLIENT'),
        mgr = S.me?.memberships?.some(m => m.role === 'MANAGER') || S.me?.is_admin,
        isAdmin = !!S.me?.is_admin;

  app.innerHTML = `
    ${online() ? '' : '<div style="background:#fff7ed;color:#9a3412;padding:8px 16px;font-size:0.85rem;font-weight:700;text-align:center;border-bottom:1px solid #fed7aa">Hors connexion — consultation hors ligne active</div>'}
    <header>
      <div>
        <h1>
          <span class="material-symbols-outlined brand-icon">sports_bar</span>
          ${esc(title)}
          ${S.ctx && tab === 'menu' ? '<span class="open-pill">Ouvert</span>' : ''}
        </h1>
        <small>${esc(sub)}</small>
      </div>
      <div class="av">${esc((S.me?.display_name || '?')[0]?.toUpperCase())}</div>
    </header>
    <main>${body}</main>
    <nav>
      ${[
        ['#/', 'deck', 'Accueil', 'home'],
        ['#/menu', 'restaurant_menu', 'Menu', 'menu'],
        ['#/order', 'receipt_long', 'Ma Table', 'order'],
        staff ? ['#/staff', 'notifications_active', 'Barman', 'staff'] : null,
        mgr ? ['#/manager', 'query_stats', 'Gérant', 'manager'] : null,
        isAdmin ? ['#/admin', 'admin_panel_settings', 'Admin', 'admin'] : null,
        ['#/profile', 'lock', 'Sécurité', 'profile']
      ].filter(Boolean).map(([h, i, l, t]) => `
        <a href="${h}" class="${t === tab ? 'on' : ''}">
          <span class="material-symbols-outlined nav-icon">${i}</span>
          <span>${l}</span>
        </a>
      `).join('')}
    </nav>
  `;
};

const ctxLine = () => S.ctx ? `${S.ctx.establishment.name} · ${S.ctx.point.label} · ${S.ctx.zone}` : 'Aucune table sélectionnée';

// ÉCRAN DE BIENVENUE : L'appareil est la clé d'accès (sans mot de passe)
function welcome(err = '') {
  app.innerHTML = `
    <main class="col" style="padding-top:36px;text-align:center">
      <div style="width:72px;height:72px;margin:0 auto 10px;border-radius:50%;background:linear-gradient(135deg,#ffdbce,#fed7aa);display:grid;place-items:center;box-shadow:0 8px 20px rgba(194,65,12,0.25);border:2px solid #fff">
        <span class="material-symbols-outlined text-[36px]" style="color:var(--p)">sports_bar</span>
      </div>
      <h1 style="font-size:2rem;font-weight:900;justify-content:center;color:var(--tx);letter-spacing:-0.5px">WANI</h1>
      <div style="font-size:0.85rem;color:var(--p);font-weight:700;margin:-6px auto 10px;text-transform:uppercase;letter-spacing:1px">Emmener · Commander · Servir</div>
      <div class="badge g" style="margin:0 auto 12px;font-size:0.75rem">Connexion instantanée</div>
      <p class="muted" style="margin:0 auto 20px;max-width:380px;line-height:1.5">
        <strong>Votre appareil vous reconnaît automatiquement.</strong> Aucun mot de passe à retenir ni à taper. Commandez directement en toute simplicité.
      </p>
      <div class="card col" style="text-align:left">
        <label class="muted" style="font-weight:700">Votre Nom ou Prénom</label>
        <input id="n" placeholder="Ex : Oumar, Fatou, Client..." autocomplete="given-name">
        <label class="muted" style="font-weight:700;margin-top:4px">Code d'équipe / gérant (facultatif)</label>
        <input id="c" placeholder="Code d'association (ex: XXXXX-XXXXX)" autocapitalize="characters">
        <button class="big" id="go" style="margin-top:8px">Commencer &amp; Commander</button>
        ${err ? `<p style="color:var(--er);margin:6px 0 0;font-size:0.85rem;font-weight:600">${esc(err)}</p>` : ''}
      </div>
      <details style="text-align:left;margin-top:12px;background:#fff;padding:12px;border-radius:12px;border:1px solid var(--bd)">
        <summary class="muted" style="cursor:pointer;font-weight:700">Changement de téléphone ?</summary>
        <p class="muted" style="font-size:0.82rem;margin:8px 0">Restaurez votre compte facilement sur votre nouvel appareil.</p>
        <button class="sec sm" id="rec">Demander la restauration du compte</button>
      </details>
    </main>
  `;

  $('#go').onclick = async () => {
    $('#go').disabled = true;
    try {
      await register($('#n').value.trim() || 'Client', $('#c').value.trim());
      await login();
      await bioOffer();
    } catch (e) {
      welcome(({ INVALID_INVITE: 'Code d’invitation invalide ou expiré', DEVICE_EXISTS: 'Appareil déjà enregistré' })[e.code] || 'Impossible de créer l’accès (' + e.message + ')');
    }
  };

  $('#rec').onclick = async () => {
    try {
      const pk = await K.create(), ts = Date.now(), pop = await K.sign(`register|${pk}|${ts}`);
      const r = await raw('POST', '/auth/recovery/request', {
        public_key: pk, pop, ts,
        device_name: 'Nouvel appareil',
        platform: 'web',
        claimed_name: $('#n')?.value || 'Client'
      });
      LS.set('recovery', r.request_id);
      toast('Demande de récupération transmise : ' + r.request_id.slice(0, 8));
      watchRecovery();
    } catch (e) {
      toast('Erreur ' + e.message, 'error');
    }
  };
}

function watchRecovery() {
  const id = LS.get('recovery');
  if (!id) return;
  const t = setInterval(async () => {
    const r = await raw('GET', '/auth/recovery/' + id).catch(() => null);
    if (r?.status === 'APPROVED') {
      clearInterval(t);
      localStorage.setItem('device_id', r.device_id);
      localStorage.removeItem('recovery');
      await login();
      start();
    }
  }, 4000);
}

// Configuration optionnelle de la biométrie + Génération du Code de Secours
async function bioOffer() {
  const info = await K.getProtectionInfo();
  if (info.isProtected) return start();

  const generatedCode = K.generateRandomBackupCode();
  app.innerHTML = `
    <main class="col" style="padding-top:40px;text-align:center">
      <div style="width:64px;height:64px;margin:0 auto 12px;border-radius:50%;background:#ecfdf5;color:#059669;display:grid;place-items:center;box-shadow:0 6px 16px rgba(5,150,105,0.25)">
        <span class="material-symbols-outlined text-[32px]">fingerprint</span>
      </div>
      <h1 style="font-size:1.6rem;justify-content:center">Protection de l'appareil</h1>
      <p class="muted" style="margin:0 auto 16px;max-width:360px">
        Activez la biométrie (Face ID / Empreinte) comme couche de protection optionnelle, accompagnée de votre <strong>code de secours</strong>.
      </p>
      <div class="card col" style="text-align:left">
        <div class="row">
          <span style="font-weight:700">Code de secours généré :</span>
          <span class="badge" style="font-size:1rem;letter-spacing:3px;font-family:var(--hd)">${generatedCode.slice(0,3)} ${generatedCode.slice(3)}</span>
        </div>
        <p class="muted" style="font-size:0.8rem;margin:4px 0">
          Ce code à 6 chiffres est votre filet de sécurité pour déverrouiller la clé si le capteur biométrique échoue.
        </p>
        <button class="big ok" id="y" style="margin-top:6px">Activer la biométrie & Sauvegarder</button>
        <button class="sec big" id="no">Continuer sans biométrie</button>
      </div>
    </main>
  `;

  $('#y').onclick = async () => {
    try {
      await K.enableProtection(S.me?.display_name, generatedCode);
      toast('Biométrie & code de secours activés !');
    } catch {
      toast('Protection configurée avec le code de secours');
    }
    start();
  };

  $('#no').onclick = start;
}

// ACCUEIL : Scan QR caméra + Sélection manuelle
function home() {
  shell('Accueil', `
    <div class="card tb">
      <div class="table-icon">🪑</div>
      <div style="flex:1">
        <b class="hd" style="font-size:1.15rem">${esc(S.ctx ? S.ctx.point.label : 'Aucune table')}</b>
        <div class="muted">${esc(S.ctx ? S.ctx.zone + ' • ' + S.ctx.establishment.name : 'Scannez le QR de votre table')}</div>
      </div>
      ${S.ctx ? '<span class="badge g">Connecté</span>' : '<span class="badge">En attente</span>'}
    </div>
    <div class="card col">
      <button class="big" id="cam" style="display:flex;align-items:center;justify-content:center;gap:8px">
        <span class="material-symbols-outlined text-[24px]">qr_code_scanner</span>
        Scanner le QR de la table
      </button>
      <label class="btn sec sm" style="margin-top:6px;display:flex;align-items:center;justify-content:center;gap:6px;cursor:pointer">
        <span class="material-symbols-outlined text-[18px]">photo_camera</span>
        Prendre une photo du QR
        <input type="file" id="pic-qr" accept="image/*" capture="environment" style="display:none">
      </label>
      <video id="vid" playsinline muted style="display:none;width:100%;border-radius:14px;border:2px solid var(--p);box-shadow:0 8px 20px rgba(0,0,0,0.15)"></video>
      <canvas id="qr-cvs" style="display:none"></canvas>
      <div class="row" style="margin-top:6px">
        <input id="code" placeholder="Code du token QR (ex: J04, S01...)">
        <button class="sec sm" id="ok" style="width:110px">Valider</button>
      </div>
      <button class="sec sm" id="man" style="margin-top:4px">Choisir ma table dans la liste</button>
      <div id="lst"></div>
    </div>
    ${S.ctx ? '<div class="row" style="margin-top:10px"><a class="btn big ok" href="#/menu">Voir le menu & Commander →</a><button class="sec sm" id="chg">Changer de table</button></div>' : ''}
  `, 'home', 'Bonjour ' + (S.me?.display_name || ''));

  $('#ok').onclick = async () => {
    try {
      await scan($('#code').value.trim());
      location.hash = '#/menu';
    } catch {
      toast('QR invalide ou expiré', 'error');
    }
  };
  $('#cam').onclick = camScan;
  $('#pic-qr')?.addEventListener('change', e => {
    const file = e.target.files?.[0];
    if (!file) return;
    const img = new Image();
    img.src = URL.createObjectURL(file);
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const cx = c.getContext('2d'); cx.drawImage(img, 0, 0);
      const id = cx.getImageData(0, 0, c.width, c.height);
      const res = window.jsQR ? window.jsQR(id.data, id.width, id.height) : null;
      if (res?.data) {
        const t = res.data.includes('q=') ? (new URL(res.data, 'http://x').searchParams.get('q') || res.data) : res.data;
        scan(t).then(() => { location.hash = '#/menu'; }).catch(() => toast('QR invalide ou expiré', 'error'));
      } else {
        toast('Aucun QR code trouvé sur cette photo', 'error');
      }
    };
  });
  $('#man').onclick = manual;
  $('#chg')?.addEventListener('click', () => { S.ctx = null; LS.set('ctx', null); home(); });
}

async function camScan() {
  const v = $('#vid');
  const cvs = $('#qr-cvs');
  const st = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } }
  }).catch(() => null);
  if (!st) return toast('Accès caméra refusé ou indisponible', 'error');
  v.style.display = 'block';
  v.srcObject = st;
  await v.play().catch(() => {});
  const ctx = cvs ? cvs.getContext('2d', { willReadFrequently: true }) : null;
  const stop = () => { st.getTracks().forEach(t => t.stop()); v.style.display = 'none'; };
  const loop = async () => {
    if (!v.isConnected || v.paused || v.ended) return stop();
    if (v.readyState === v.HAVE_ENOUGH_DATA && ctx) {
      cvs.width = v.videoWidth; cvs.height = v.videoHeight;
      ctx.drawImage(v, 0, 0, cvs.width, cvs.height);
      const img = ctx.getImageData(0, 0, cvs.width, cvs.height);
      let found = null;
      if (window.jsQR) {
        const r = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        if (r?.data) found = r.data;
      }
      if (!found && 'BarcodeDetector' in window) {
        try {
          const det = new BarcodeDetector({ formats: ['qr_code'] });
          const r = await det.detect(v);
          if (r[0]) found = r[0].rawValue;
        } catch {}
      }
      if (found) {
        stop();
        const t = found.includes('q=') ? (new URL(found, 'http://x').searchParams.get('q') || found) : found;
        try {
          await scan(t);
          location.hash = '#/menu';
          return;
        } catch {
          toast('QR invalide ou expiré', 'error');
          return home();
        }
      }
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

async function manual() {
  const ests = await api('GET', '/establishments');
  let h = '';
  for (const e of ests) {
    const zs = await api('GET', `/establishments/${e.id}/zones`);
    h += `<div style="margin-top:12px"><b>${esc(e.name)}</b></div>` + zs.map(z => `
      <div class="muted" style="margin:4px 0 2px">${esc(z.name)}</div>
      <div class="row" style="flex-wrap:wrap;justify-content:flex-start;gap:6px">
        ${z.points.map(p => `
          <button class="sec sm" data-pt="${e.id}|${esc(e.name)}|${esc(z.name)}|${p.id}|${esc(p.code)}|${esc(p.label)}">
            ${esc(p.code)}
          </button>
        `).join('')}
      </div>
    `).join('');
  }
  $('#lst').innerHTML = h;
  $('#lst').onclick = async e => {
    const d = e.target.dataset.pt;
    if (!d) return;
    const [id, name, zone, pid, code, label] = d.split('|');
    S.ctx = { establishment: { id, name }, zone, point: { id: pid, code, label }, token: null };
    LS.set('ctx', S.ctx);
    S.cart = {};
    await loadMenu();
    location.hash = '#/menu';
  };
}

// MENU : Grille de cartes 3D avec photos, étiquettes fraîcheur & dock de panier
function menu() {
  if (!S.ctx) return home();
  const by = c => S.products.filter(p => p.category_id === c.id);
  const lines = cartLines(), n = lines.reduce((a, l) => a + l.q, 0);

  shell(S.ctx.establishment.name, `
    <div class="card tb">
      <div class="table-icon">🪑</div>
      <div style="flex:1">
        <b class="hd" style="font-size:1.15rem">${esc(S.ctx.point.label)}</b>
        <div class="muted">${esc(S.ctx.zone)} • Service rapide</div>
      </div>
      <span class="pill">Frais &amp; Dispo</span>
    </div>

    <div class="chips">
      <button class="${S.cat ? '' : 'on'}" data-cat="">Tout le menu</button>
      ${S.cats.map(c => `<button class="${S.cat === c.id ? 'on' : ''}" data-cat="${c.id}">${esc(c.name)}</button>`).join('')}
    </div>

    <button class="sec sm" id="mic" style="width:100%;margin:10px 0;display:flex;align-items:center;justify-content:center;gap:6px">
      <span class="material-symbols-outlined text-[20px]" style="color:var(--p)">mic</span>
      Commander directement à la voix
    </button>

    ${S.cats.filter(c => !S.cat || S.cat === c.id).map(c => by(c).length ? `
      <h2>${esc(c.name)}</h2>
      ${by(c).map(p => `
        <div class="card pc">
          <div class="ph">
            ${p.image ? `<img src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy">` : `<span>${EMO[c.name] || '🍽️'}</span>`}
            <div class="tag-overlay ${c.name === 'Boissons' ? 'green' : 'orange'}">
              <span class="material-symbols-outlined text-[13px]">${c.name === 'Boissons' ? 'ac_unit' : 'local_fire_department'}</span>
              <span>${c.name === 'Boissons' ? 'Très fraîche' : 'Chaud & Braisé'}</span>
            </div>
            ${p.available ? '' : '<em class="so">Indisponible</em>'}
          </div>
          <div class="row">
            <div>
              <b class="hd" style="font-size:1.05rem">${esc(p.name)}</b>
              <div class="muted">${esc(p.description)}</div>
              <div class="price" style="margin-top:2px">${fcfa(p.price)}</div>
            </div>
            ${S.cart[p.id] ? `
              <div class="qty">
                <button data-m="${p.id}" aria-label="Moins">−</button>
                <b style="min-width:20px;text-align:center">${S.cart[p.id]}</b>
                <button data-a="${p.id}" aria-label="Plus">+</button>
              </div>
            ` : `
              <button class="rd" data-a="${p.id}" ${p.available ? '' : 'disabled'} aria-label="Ajouter">+</button>
            `}
          </div>
    ` : '').join('')}

    ${!S.products.length ? `
      <div class="card" style="text-align:center;padding:36px 16px;margin-top:14px">
        <span class="material-symbols-outlined text-[44px]" style="color:var(--tx-muted)">storefront</span>
        <b style="display:block;margin-top:10px;font-size:1.1rem">Aucun produit au menu pour le moment</b>
        <p class="muted" style="margin:4px 0 0">Le vendeur n'a pas encore ajouté d'articles pour cet établissement.</p>
      </div>
    ` : ''}

    ${n ? `
      <div class="bar">
        <div class="bar-dock">
          <div style="display:flex;align-items:center;gap:10px">
            <div class="bar-cart-icon">
              <span class="material-symbols-outlined">shopping_bag</span>
              <span class="cart-count">${n}</span>
            </div>
            <div>
              <div class="muted" style="font-size:0.75rem">${n > 1 ? n + ' articles choisis' : '1 article choisi'}</div>
              <div class="price" style="font-size:1.2rem">${fcfa(total())}</div>
            </div>
          </div>
          <button class="btn ok" id="cart" style="padding:10px 18px">
            Commander à la table →
          </button>
        </div>
      </div>
    ` : ''}
  `, 'menu', ctxLine());

  app.onclick = e => {
    const a = e.target.dataset;
    if (e.target.dataset.cat !== undefined) {
      S.cat = e.target.dataset.cat || null;
      menu();
    }
    if (a.a) { setQ(a.a, 1); menu(); }
    if (a.m) { setQ(a.m, -1); menu(); }
  };
  $('#cart')?.addEventListener('click', cart);
  $('#mic').onclick = voiceUI;
}

// PANIER & ENVOI
function cart(err = '') {
  const L = cartLines();
  shell('Panier', `
    ${L.map(l => `
      <div class="card row">
        <div>
          <b class="hd">${esc(l.p.name)}</b>
          <div class="muted">${l.q} × ${fcfa(l.p.price)}</div>
        </div>
        <b class="price">${fcfa(l.p.price * l.q)}</b>
      </div>
    `).join('')}
    <textarea id="note" placeholder="Précision cuisine / bar (ex: bien frais, piment à part, avec glaçons)"></textarea>
    <div class="row" style="margin:14px 0">
      <h2 style="margin:0">Total Commande</h2>
      <span class="price" style="font-size:1.35rem">${fcfa(total())}</span>
    </div>
    ${S.pending ? '<div class="card" style="border-color:var(--er)"><b>Envoi en cours ou en attente réseau.</b><div class="muted">La même clé d’idempotence est conservée pour éviter tout doublon.</div></div>' : ''}
    ${err ? `<p style="color:var(--er);font-weight:700">${esc(err)}</p>` : ''}
    <button class="big ok" id="send" ${L.length ? '' : 'disabled'}>
      ${S.pending ? 'Réessayer l’envoi' : 'Envoyer la commande au bar'}
    </button>
  `, 'menu', ctxLine());

  $('#send').onclick = send;
}

async function send() {
  const btn = $('#send');
  btn.disabled = true;
  S.pending ||= {
    key: crypto.randomUUID(),
    items: cartLines().map(l => ({ product_id: l.p.id, quantity: l.q })),
    note: $('#note')?.value || '',
    voice: S.voice?.id
  };
  LS.set('pending', S.pending);

  try {
    if (!online()) throw new Error('offline');
    const o = await api('POST', '/orders', {
      qr_token: S.ctx.token,
      reception_point_id: S.ctx.token ? undefined : S.ctx.point.id,
      items: S.pending.items,
      note: S.pending.note,
      voice_message_id: S.pending.voice
    }, { 'idempotency-key': S.pending.key });

    S.pending = null;
    localStorage.removeItem('pending');
    S.cart = {};
    LS.set('cart', {});
    S.voice = null;
    LS.set('lastOrder', o.id);
    done(o);
  } catch (e) {
    if (e.status >= 400 && e.status < 500 && e.status !== 401) {
      S.pending = null;
      localStorage.removeItem('pending');
      return cart(({ OUT_OF_STOCK: 'Rupture : ' + e.message, QR_INVALID: 'Table invalide, rescannez le QR' })[e.code] || 'Commande refusée');
    }
    cart('Erreur de transmission : réessayez');
  }
}

function done(o) {
  shell('Confirmation', `
    <div class="card" style="text-align:center;padding:24px 16px">
      <div style="width:72px;height:72px;margin:0 auto 12px;border-radius:50%;background:linear-gradient(135deg,#059669,#006c49);color:#fff;display:grid;place-items:center;font-size:2.5rem;box-shadow:0 0 0 10px rgba(108,248,187,0.3)">
        ✓
      </div>
      <h2 class="hd" style="font-size:1.4rem">Commande bien reçue !</h2>
      <p class="muted">
        Le bar a accusé réception.<br>
        <strong>Table ${esc(o.point?.code)} · ${esc(o.point?.zone)}</strong>
      </p>
      ${o.items.map(l => `
        <div class="row" style="margin:4px 0">
          <span>${l.quantity} × ${esc(l.name)}</span>
          <span class="muted">${fcfa(l.total)}</span>
        </div>
      `).join('')}
      <hr style="border:none;border-top:1px solid var(--bd);margin:12px 0">
      <div class="row">
        <b>Total</b>
        <b class="price">${fcfa(o.total)}</b>
      </div>
    </div>
    <a class="btn big ok" href="#/order" style="text-align:center">Suivre l'avancement en direct</a>
    <p style="text-align:center;margin-top:12px"><a href="#/menu" class="muted">Commander un complément</a></p>
  `, 'order');
}

// SUIVI EN DIRECT (Ma Table) : Stepper animé & Temps Réel
async function track() {
  const id = LS.get('lastOrder', null);
  if (!id) return shell('Ma Table', '<div class="card"><p class="muted">Aucune commande en cours à votre table.</p><a class="btn big" href="#/menu">Consulter la carte</a></div>', 'order');

  const draw = async () => {
    let o;
    try { o = await api('GET', '/orders/' + id); LS.set('o:' + id, o); }
    catch { o = LS.get('o:' + id, null); }
    if (!o) return;

    const currIdx = FLOW.indexOf(o.status);
    const bad = ['CANCELLED', 'REJECTED', 'EXPIRED'].includes(o.status);

    shell('Ma Table', `
      <div class="card col">
        <div class="row">
          <div>
            <span class="badge ${bad ? 'r' : 'g'}">${ST[o.status] || o.status}</span>
            <h2 style="margin:4px 0 0">Table ${esc(o.point?.code)} · ${esc(o.point?.zone)}</h2>
          </div>
          <span class="font-price text-[1.4rem]">${fcfa(o.total)}</span>
        </div>

        <!-- Stepper Visuel 3D -->
        <div class="stepper-container">
          <div class="stepper-line">
            <div class="stepper-progress" style="width:${bad ? 0 : Math.max(0, (currIdx / (FLOW.length - 1)) * 100)}%"></div>
          </div>
          ${FLOW.map((step, idx) => {
            const isDone = idx < currIdx && !bad;
            const isActive = idx === currIdx && !bad;
            return `
              <div class="step-node ${isDone ? 'done' : ''} ${isActive ? 'active' : ''}">
                ${isDone ? '✓' : idx + 1}
              </div>
            `;
          }).join('')}
        </div>
        <div class="row muted" style="font-size:0.75rem;justify-content:space-between">
          <span>Envoyée</span>
          <span>En cuisine</span>
          <span>Prête</span>
          <span>Livrée</span>
        </div>

        <div style="background:#f8fafc;padding:12px;border-radius:12px;border:1px solid var(--bd);margin-top:6px">
          ${o.items.map(l => `
            <div class="row" style="margin:4px 0">
              <span><strong>${l.quantity}×</strong> ${esc(l.name)}</span>
              <span>${fcfa(l.total)}</span>
            </div>
          `).join('')}
        </div>

        <div class="row" style="margin-top:4px">
          <span class="badge ${o.payment_status === 'PAID' ? 'g' : ''}">
            ${o.payment_status === 'PAID' ? '✓ Règlement confirmé' : 'À régler au comptoir ou au serveur'}
          </span>
        </div>

        ${o.status === 'SUBMITTED' ? '<button class="dng sm" id="x" style="margin-top:8px">Annuler ma commande</button>' : ''}
      </div>
    `, 'order', 'Suivi synchronisé en temps réel');

    $('#x')?.addEventListener('click', async () => {
      await api('POST', `/orders/${id}/cancel`);
      draw();
    });
  };

  await draw();
  S.poll = setInterval(() => location.hash === '#/order' ? draw() : clearInterval(S.poll), 4000);
}

// HISTORIQUE
async function histView() {
  let l;
  try { l = await api('GET', '/orders'); LS.set('hist', l); }
  catch { l = LS.get('hist', []); }

  shell('Historique', l.map(o => `
    <div class="card row">
      <div>
        <b class="hd">${new Date(o.created_at).toLocaleString('fr-FR')}</b>
        <div class="muted">${o.items.map(i => i.quantity + '× ' + esc(i.name)).join(', ')}</div>
      </div>
      <div style="text-align:right">
        <div class="price">${fcfa(o.total)}</div>
        <span class="badge ${['CANCELLED','REJECTED'].includes(o.status) ? 'r' : 'g'}">${ST[o.status]}</span>
      </div>
    </div>
  `).join('') || '<div class="card"><p class="muted">Aucune commande enregistrée.</p></div>', 'history');
}

// SÉCURITÉ & PROFIL : L'appareil est la clé d'accès + Biométrie & Code de Secours
async function profile() {
  const devs = await api('GET', '/me/devices').catch(() => []);
  const info = await K.getProtectionInfo();

  shell('Sécurité', `
    <div class="card col">
      <div class="row">
        <div>
          <b class="hd" style="font-size:1.15rem">${esc(S.me.display_name)}</b>
          <div class="muted">Identifiant : ${esc(S.me.id.slice(0, 8))}...</div>
        </div>
        <span class="badge g">Clé Active</span>
      </div>
      <div style="background:#f8fafc;padding:10px 12px;border-radius:10px;font-size:0.8rem;border:1px solid var(--bd)">
        <strong>Aucun mot de passe</strong> : cet appareil stocke votre clé privée non-exportable dans le matériel.
      </div>
    </div>

    <h2>Protection Biométrique & Code de Secours</h2>
    <div class="card col">
      <div class="row">
        <div>
          <b class="hd">Biométrie &amp; PIN de secours</b>
          <div class="muted">
            ${info.isProtected ? 'Protège l’accès avec Face ID / Empreinte + Code PIN' : 'Accès direct sans verrou'}
          </div>
        </div>
        <button class="sm ${info.isProtected ? 'ok' : 'sec'}" id="bio-toggle">
          ${info.isProtected ? 'ACTIVE' : 'DÉSACTIVÉE'}
        </button>
      </div>
      ${info.isProtected ? `
        <div class="row" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--bd)">
          <span class="muted" style="font-size:0.82rem">Code de secours configuré</span>
          <button class="sec sm" id="regen-pin">Nouveau PIN</button>
        </div>
      ` : ''}
    </div>

    <h2>Appareils Autorisés</h2>
    ${devs.map(d => `
      <div class="card row">
        <div>
          <b class="hd">${esc(d.device_name)}</b>
          ${d.current ? '<span class="badge g" style="margin-left:6px">Cet appareil</span>' : ''}
          <div class="muted">
            ${d.status === 'ACTIVE' ? '✓ Actif' : 'Révoqué'} · Dernier accès ${new Date(d.last_seen_at).toLocaleDateString('fr-FR')}
          </div>
        </div>
        ${d.status === 'ACTIVE' && !d.current ? `<button class="dng sm" data-rev="${d.id}">Révoquer</button>` : ''}
      </div>
    `).join('')}

    <button class="sec big" id="add">+ Lier un nouvel appareil</button>
    <div id="code"></div>
  `, 'profile');

  $('#bio-toggle').onclick = async () => {
    if (info.isProtected) {
      await K.disableProtection();
      toast('Protection désactivée');
    } else {
      const pin = K.generateRandomBackupCode();
      await K.enableProtection(S.me?.display_name, pin);
      toast(`Protection activée (PIN: ${pin})`);
    }
    profile();
  };

  $('#regen-pin')?.addEventListener('click', async () => {
    const pin = K.generateRandomBackupCode();
    await K.setBackupCode(pin);
    toast(`Nouveau PIN de secours : ${pin}`);
  });

  $('#add').onclick = async () => {
    const c = await api('POST', '/me/devices');
    $('#code').innerHTML = `
      <div class="card col" style="text-align:center">
        <div class="muted">Saisissez ce code d'association sur le nouvel appareil (5 minutes) :</div>
        <b style="font-size:1.8rem;letter-spacing:4px;color:var(--p)">${esc(c.code)}</b>
      </div>
    `;
  };

  app.onclick = async e => {
    if (e.target.dataset.rev) {
      await api('DELETE', '/me/devices/' + e.target.dataset.rev);
      profile();
    }
  };
}

// POSTE BARMAN & CAISSE : Réception de commandes en direct (Pro 3D)
async function staff() {
  const est = S.me?.memberships?.[0]?.establishment_id;
  if (!est) return;

  const methods = await api('GET', '/payment-methods');
  const NEXT = {
    SUBMITTED: 'RECEIVED',
    RECEIVED: 'PREPARING',
    PREPARING: 'READY',
    READY: 'DELIVERING',
    DELIVERING: 'DELIVERED',
    DELIVERED: 'COMPLETED'
  };

  const draw = async () => {
    const os = (await api('GET', '/orders?establishment_id=' + est))
      .filter(o => !['COMPLETED', 'CANCELLED', 'REJECTED', 'EXPIRED'].includes(o.status))
      .sort((x, y) => (x.created_at || 0) - (y.created_at || 0));

    const totalToCollect = os.filter(o => o.payment_status !== 'PAID').reduce((sum, o) => sum + o.total, 0);

    shell('Barman', `
      <!-- Top Duty Barman Panel -->
      <div class="barman-duty-panel">
        <div>
          <div class="muted" style="font-size:0.75rem;text-transform:uppercase;letter-spacing:0.05em">Poste de commande</div>
          <b class="hd" style="font-size:1.25rem">Caisse &amp; Barman</b>
          <div style="display:flex;align-items:center;gap:6px;margin-top:2px;font-size:0.8rem">
            <span class="pulse-dot"></span>
            <span style="color:#059669;font-weight:700">Flux en direct (${os.length} active${os.length > 1 ? 's' : ''})</span>
          </div>
        </div>
        <button class="sm ${S.serviceOpen ? 'ok' : 'sec'}" id="toggle-service">
          ${S.serviceOpen ? 'Service Ouvert' : 'En Pause'}
        </button>
      </div>

      <!-- Quick KPI Cards 3D -->
      <div class="kpi-grid">
        <div class="kpi-card">
          <div style="width:38px;height:38px;border-radius:50%;background:#fff7ed;color:var(--p);display:grid;place-items:center">
            <span class="material-symbols-outlined text-[20px]">pending_actions</span>
          </div>
          <div>
            <div class="muted" style="font-size:0.75rem">Commandes actives</div>
            <b class="hd" style="font-size:1.1rem">${os.length} tables</b>
          </div>
        </div>
        <div class="kpi-card">
          <div style="width:38px;height:38px;border-radius:50%;background:#ecfdf5;color:#059669;display:grid;place-items:center">
            <span class="material-symbols-outlined text-[20px]">payments</span>
          </div>
          <div>
            <div class="muted" style="font-size:0.75rem">À encaisser</div>
            <b class="hd" style="font-size:1.1rem">${fcfa(totalToCollect)}</b>
          </div>
        </div>
      </div>

      <div class="row" style="margin:10px 0 6px">
        <h2 style="margin:0;display:flex;align-items:center;gap:6px">
          <span class="material-symbols-outlined text-[22px]" style="color:var(--p)">notifications_active</span>
          Commandes des tables
        </h2>
        <span class="badge" style="font-weight:800">Priorité Bar</span>
      </div>

      <!-- Cartes de réception des commandes 3D -->
      ${os.map(o => {
        const mins = Math.max(0, Math.floor((Date.now() - o.created_at) / 60000));
        return `
          <div class="card col order-card-barman ${o.status.toLowerCase()}">
            <div class="row">
              <div>
                <div class="row" style="gap:8px">
                  <span class="hd" style="font-size:1.25rem;letter-spacing:-0.01em">TABLE ${esc(o.point?.code)}</span>
                  <span class="badge">${esc(o.point?.zone || 'Bar')}</span>
                </div>
                <div class="order-time-badge">
                  <span class="material-symbols-outlined text-[15px]">schedule</span>
                  Commandé il y a ${mins} min
                </div>
              </div>
              <div class="price" style="font-size:1.3rem">${fcfa(o.total)}</div>
            </div>

            <!-- Liste des articles commandés -->
            <div style="background:#f8fafc;padding:10px 12px;border-radius:12px;border:1px solid var(--bd)">
              ${o.items.map(i => `
                <div class="row" style="margin:4px 0">
                  <div style="display:flex;align-items:center;gap:8px">
                    <span class="badge" style="background:#ffdbce;color:var(--p);font-size:0.75rem">${i.quantity}x</span>
                    <strong style="font-size:0.9rem">${esc(i.name)}</strong>
                  </div>
                  <span class="muted" style="font-size:0.8rem">${esc(i.note || '')}</span>
                </div>
              `).join('')}
            </div>

            ${o.voice ? `
              <div class="row" style="background:#fff7ed;padding:6px 10px;border-radius:10px">
                <button class="sec sm" data-play="${o.voice.id}">
                  <span class="material-symbols-outlined text-[16px]">play_arrow</span> Écouter note vocale
                </button>
                <span class="muted" style="font-size:0.8rem">« ${esc(o.voice.transcription)} »</span>
              </div>
            ` : ''}

            <!-- Règlement -->
            <div class="row">
              <span class="muted" style="font-size:0.82rem">Paiement :</span>
              <span class="badge ${o.payment_status === 'PAID' ? 'g' : 'r'}">
                ${o.payment_status === 'PAID' ? '✓ Payé (' + (o.payment_method || 'Comptoir') + ')' : 'Non payé'}
              </span>
            </div>

            <!-- Actions Barman Tactiles 3D -->
            <div class="row" style="gap:8px;margin-top:4px">
              ${o.status !== 'DELIVERED' ? `
                <button class="ok big" data-st="${o.id}:DELIVERED" style="flex:2">
                  <span class="material-symbols-outlined text-[20px]">check_circle</span> Servi à Table ✓
                </button>
              ` : `
                <button class="ok big" data-st="${o.id}:COMPLETED" style="flex:2" ${o.payment_status === 'PAID' ? '' : 'disabled'}>
                  ✓ Clôturer la table
                </button>
              `}
              ${NEXT[o.status] && NEXT[o.status] !== 'DELIVERED' ? `
                <button class="sec sm" data-st="${o.id}:${NEXT[o.status]}" style="flex:1">
                  → ${ST[NEXT[o.status]]}
                </button>
              ` : ''}
              ${o.status === 'SUBMITTED' ? `
                <button class="dng sm" data-st="${o.id}:REJECTED">Refuser</button>
              ` : ''}
            </div>

            <!-- Encaissement Rapide 1-clic -->
            ${o.payment_status !== 'PAID' ? `
              <div class="row" style="flex-wrap:wrap;gap:6px;padding-top:6px;border-top:1px dashed var(--bd)">
                <span class="muted" style="font-size:0.75rem;width:100%">Encaisser maintenant :</span>
                ${methods.map(m => `
                  <button class="sec sm" data-pay="${o.id}:${m}" style="flex:1;min-width:80px">
                    ${m === 'CASH' ? 'Espèces' : m === 'ORANGE_MONEY' ? 'Orange' : m === 'MOOV_MONEY' ? 'Moov' : m}
                  </button>
                `).join('')}
              </div>
            ` : ''}
          </div>
        `;
      }).join('') || `
        <div class="card" style="text-align:center;padding:32px 16px;background:#ecfdf5;border-color:rgba(16,185,129,0.3)">
          <div style="width:52px;height:52px;border-radius:50%;background:#059669;color:#fff;display:grid;place-items:center;margin:0 auto 10px">
            <span class="material-symbols-outlined text-[28px]">thumb_up</span>
          </div>
          <b class="hd" style="font-size:1.2rem;color:#059669">Toutes les tables sont servies !</b>
          <p class="muted" style="margin:4px 0 0">En attente de nouvelles commandes au comptoir.</p>
        </div>
      `}
    `, 'staff', S.me.memberships[0]?.name || 'WANI');

    $('#toggle-service')?.addEventListener('click', () => {
      S.serviceOpen = !S.serviceOpen;
      LS.set('serviceOpen', S.serviceOpen);
      toast(S.serviceOpen ? 'Service ouvert' : 'Service en pause');
      draw();
    });
  };

  app.onclick = async e => {
    const d = e.target.dataset;
    try {
      if (d.st) {
        const [id, s] = d.st.split(':');
        await api('POST', `/orders/${id}/status`, { status: s });
      }
      if (d.pay) {
        const [id, m] = d.pay.split(':');
        await api('POST', `/orders/${id}/payment`, { method: m });
        toast('Paiement validé avec succès !');
      }
      if (d.play) {
        const b = await fetch(`/voice/${d.play}/audio`, { headers: { authorization: 'Bearer ' + S.tok } }).then(r => r.blob());
        new Audio(URL.createObjectURL(b)).play();
        return;
      }
      draw();
    } catch (er) {
      toast('Action refusée : ' + (er.code || er.message), 'error');
    }
  };

  await draw();
  const t = setInterval(() => location.hash === '#/staff' ? draw() : clearInterval(t), 4000);
}

// GÉRANT : Tableau de bord, Stock, Équipe, Zones & Tables
async function manager() {
  const m = S.me?.memberships?.find(m => m.role === 'MANAGER') || S.me?.memberships?.[0];
  if (!m) return;
  const est = m.establishment_id;

  const [st, inv, qr, prods, staffList, zones] = await Promise.all([
    api('GET', '/statistics?establishment_id=' + est),
    api('GET', '/inventory?establishment_id=' + est),
    api('GET', `/establishments/${est}/qr`),
    api('GET', '/products?establishment_id=' + est),
    api('GET', `/establishments/${est}/staff`).catch(() => []),
    api('GET', `/establishments/${est}/zones`).catch(() => [])
  ]);

  shell('Gérant', `
    <div class="card col">
      <div class="row">
        <div>
          <span class="muted">Recettes encaissées</span>
          <div class="price" style="font-size:1.6rem">${fcfa(st.revenue_paid)}</div>
        </div>
        <span class="badge g">Direct</span>
      </div>
      <div class="muted" style="font-size:0.8rem">
        Top : ${st.top_products.map(t => esc(t.name) + ' (' + t.qty + ')').join(', ') || 'Aucun'}
      </div>
    </div>

    <h2>Disponibilité Cuisine &amp; Frigo</h2>
    ${prods.map(p => `
      <div class="card row">
        <div>
          <b class="hd">${esc(p.name)}</b>
          <div class="muted">Stock : ${p.stock ?? 'Non suivi'} · ${fcfa(p.price)}</div>
        </div>
        <div class="row" style="gap:6px">
          <button class="sm ${p.available ? 'ok' : 'sec'}" data-av="${p.id}:${p.available ? 0 : 1}">
            ${p.available ? 'Au frais' : 'Rupture'}
          </button>
          <button class="sm" data-buy="${p.id}">+10</button>
        </div>
      </div>
    `).join('')}

    <h2>Ajouter un Produit ou une Zone</h2>
    <div class="card col">
      <div class="row">
        <input id="cat-name" placeholder="Nom nouvelle catégorie">
        <button class="sm sec" id="add-cat-btn" style="width:110px">Ajouter Cat</button>
      </div>
      <div class="row" style="margin-top:4px">
        <input id="zone-name" placeholder="Nom nouvelle zone (ex: Cour Arrière)">
        <button class="sm sec" id="add-zone-btn" style="width:110px">Ajouter Zone</button>
      </div>
      ${zones.length ? `
        <div class="row" style="margin-top:4px">
          <input id="point-code" placeholder="Code table (ex: J05, T02)" style="flex:1">
          <select id="point-zone" style="flex:1">
            ${zones.map(z => `<option value="${z.id}">${esc(z.name)}</option>`).join('')}
          </select>
          <button class="sm ok" id="add-point-btn">Créer Table</button>
        </div>
      ` : ''}
    </div>

    <h2>Équipe &amp; Codes d'accès</h2>
    <div class="card col">
      <div class="row">
        <button class="sec sm" data-inv="STAFF" style="flex:1">Code Serveur</button>
        <button class="sec sm" data-inv="MANAGER" style="flex:1">Code Gérant</button>
      </div>
      <div id="invc" style="margin-top:6px"></div>
      ${staffList.length ? `
        <div style="margin-top:8px;border-top:1px solid var(--bd);padding-top:8px">
          <b class="muted" style="font-size:0.8rem">Membres actuels :</b>
          ${staffList.map(u => `
            <div class="row" style="margin:4px 0">
              <span>${esc(u.display_name)} <span class="badge ${u.role === 'MANAGER' ? '' : 'g'}">${u.role}</span></span>
              ${u.id !== S.me?.id ? `<button class="dng sm" data-del-staff="${u.id}">Retirer</button>` : ''}
            </div>
          `).join('')}
        </div>
      ` : ''}
    </div>

    <h2>Tables &amp; QR Codes</h2>
    ${qr.map(q => `
      <div class="card row">
        <div>
          <b class="hd">${esc(q.label)} (${esc(q.code)})</b>
          <div class="muted">${esc(q.zone)}</div>
        </div>
        <div class="row" style="gap:6px">
          <a class="badge" href="/?q=${q.token}" target="_blank">Lien QR</a>
          <button class="sm sec" data-rotate-qr="${q.point_id}" title="Renouveler le QR">🔄</button>
        </div>
      </div>
    `).join('')}
  `, 'manager', m.name);

  app.onclick = async e => {
    const d = e.target.dataset;
    try {
      if (d.av) {
        const [id, v] = d.av.split(':');
        await api('PATCH', '/products/' + id, { available: v === '1' });
        manager();
      }
      if (d.buy) {
        await api('POST', '/inventory/movements', { product_id: d.buy, type: 'PURCHASE', quantity: 10 });
        manager();
      }
      if (d.inv) {
        const r = await api('POST', `/establishments/${est}/invites`, { role: d.inv });
        $('#invc').innerHTML = `<div style="background:#fff7ed;padding:8px;border-radius:8px;border:1px solid #fed7aa;text-align:center"><b>${esc(r.code)}</b> <span class="muted">(24h, usage unique)</span></div>`;
      }
      if (d.rotateQr) {
        await api('POST', `/reception-points/${d.rotateQr}/qr/rotate`);
        toast('QR Code de la table renouvelé avec succès !');
        manager();
      }
      if (d.delStaff) {
        await api('DELETE', `/establishments/${est}/staff/${d.delStaff}`);
        toast('Membre retiré de l’équipe');
        manager();
      }
    } catch (er) {
      toast(er.code || 'Erreur', 'error');
    }
  };

  $('#add-cat-btn')?.addEventListener('click', async () => {
    const name = $('#cat-name')?.value.trim();
    if (!name) return;
    await api('POST', '/categories', { establishment_id: est, name });
    toast('Catégorie créée !');
    manager();
  });

  $('#add-zone-btn')?.addEventListener('click', async () => {
    const name = $('#zone-name')?.value.trim();
    if (!name) return;
    await api('POST', `/establishments/${est}/zones`, { name });
    toast('Zone créée !');
    manager();
  });

  $('#add-point-btn')?.addEventListener('click', async () => {
    const code = $('#point-code')?.value.trim();
    const zoneId = $('#point-zone')?.value;
    if (!code || !zoneId) return;
    await api('POST', `/zones/${zoneId}/points`, { code });
    toast(`Table ${code} créée avec son QR !`);
    manager();
  });
}

// ADMIN : Validation des demandes de récupération d'appareils
async function admin() {
  if (!S.me?.is_admin) return home();

  const reqs = await api('GET', '/admin/recovery').catch(() => []);

  shell('Administration', `
    <div class="card col">
      <div class="row">
        <div>
          <b class="hd" style="font-size:1.25rem">Panneau Administrateur</b>
          <div class="muted">Validation hors-bande des changements d'appareils</div>
        </div>
        <span class="badge" style="background:#ba1a1a;color:#fff">ADMIN</span>
      </div>
    </div>

    <h2>Demandes de Récupération (${reqs.filter(r => r.status === 'PENDING').length} en attente)</h2>
    ${reqs.map(r => `
      <div class="card col" style="border-left:4px solid ${r.status === 'PENDING' ? '#d97706' : r.status === 'APPROVED' ? '#059669' : '#dc2626'}">
        <div class="row">
          <div>
            <b class="hd">${esc(r.claimed_name || 'Client Inconnu')}</b>
            <div class="muted">Plateforme : ${esc(r.platform || 'web')} · ${new Date(r.created_at).toLocaleString('fr-FR')}</div>
          </div>
          <span class="badge ${r.status === 'APPROVED' ? 'g' : r.status === 'REJECTED' ? 'r' : ''}">
            ${r.status}
          </span>
        </div>
        <div class="muted" style="font-size:0.75rem;word-break:break-all">
          Clé : ${esc(r.public_key.slice(0, 32))}...
        </div>
        ${r.status === 'PENDING' ? `
          <div class="row" style="gap:8px;margin-top:6px">
            <button class="ok sm" data-approve="${r.id}" style="flex:1">✓ Approuver la clé</button>
            <button class="dng sm" data-reject="${r.id}" style="flex:1">✕ Rejeter</button>
          </div>
        ` : ''}
      </div>
    `).join('') || '<div class="card"><p class="muted">Aucune demande de récupération enregistrée.</p></div>'}
  `, 'admin', 'Supervision globale');

  app.onclick = async e => {
    const d = e.target.dataset;
    if (d.approve) {
      const targetUserId = prompt('Saisissez l’ID utilisateur cible à lier à ce nouvel appareil (vérification d’identité préalable obligatoire) :');
      if (!targetUserId) return;
      try {
        await api('POST', `/admin/recovery/${d.approve}/approve`, { user_id: targetUserId.trim() });
        toast('Nouvel appareil approuvé et lié avec succès !');
        admin();
      } catch (err) {
        toast('Erreur approbation : ' + (err.code || err.message), 'error');
      }
    }
    if (d.reject) {
      try {
        await api('POST', `/admin/recovery/${d.reject}/reject`);
        toast('Demande rejetée');
        admin();
      } catch (err) {
        toast('Erreur rejet', 'error');
      }
    }
  };
}

// COMMANDE VOCALE AVEC INTERPRÉTATION FR & ENREGISTREMENT AUDIO
async function voiceUI() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  app.insertAdjacentHTML('beforeend', `
    <div class="modal-overlay" id="vbox">
      <div class="modal-content">
        <h2 class="hd">Parlez naturellement</h2>
        <p class="muted">Ex : "Deux Flag bien fraîches et un poulet bicyclette"</p>
        <button id="rec" class="mic">🎙️</button>
        <div class="muted" id="rl">${SR ? 'Appuyez pour parler' : 'Saisissez votre commande ci-dessous'}</div>
        <input id="vt" placeholder="Votre commande vocale" style="margin:12px 0">
        <div class="row">
          <button class="sec" id="vclose">Fermer</button>
          <button class="ok" id="ana">Analyser</button>
        </div>
        <div id="vres" style="margin-top:10px;text-align:left"></div>
      </div>
    </div>
  `);

  $('#vclose').onclick = () => $('#vbox').remove();

  let mr, chunks = [], t0 = 0, conf = 0;
  $('#rec').onclick = async () => {
    if (!SR) return;
    const b = $('#rec');
    if (mr?.state === 'recording') {
      mr.stop();
      b.classList.remove('live');
      return;
    }
    try {
      const st = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = [];
      mr = new MediaRecorder(st);
      mr.ondataavailable = e => chunks.push(e.data);
      mr.onstop = () => st.getTracks().forEach(t => t.stop());
      mr.start();
      t0 = Date.now();

      const sr = new SR();
      sr.lang = 'fr-FR';
      sr.onresult = e => {
        $('#vt').value = e.results[0][0].transcript;
        conf = e.results[0][0].confidence;
        mr.state === 'recording' && mr.stop();
        b.classList.remove('live');
        $('#ana').click();
      };
      sr.start();
      b.classList.add('live');
      $('#rl').textContent = 'Écoute en cours...';
    } catch {
      toast('Accès micro refusé', 'error');
    }
  };

  $('#ana').onclick = async () => {
    try {
      const r = await api('POST', '/voice/interpret', {
        establishment_id: S.ctx.establishment.id,
        text: $('#vt').value
      });
      $('#vres').innerHTML = r.items.length ? `
        <div style="background:#f8fafc;padding:10px;border-radius:10px;border:1px solid var(--bd)">
          <b>Articles détectés :</b>
          ${r.items.map(i => `<div>${i.quantity} × ${esc(i.name)} <span class="muted">${esc(i.note)}</span></div>`).join('')}
        </div>
        <button class="big ok" id="okv" style="margin-top:8px">Ajouter au panier</button>
      ` : '<p class="muted">Aucun article reconnu, veuillez reformuler.</p>';

      $('#okv')?.addEventListener('click', async () => {
        r.items.forEach(i => { S.cart[i.product_id] = (S.cart[i.product_id] || 0) + i.quantity; });
        LS.set('cart', S.cart);
        if (chunks.length) {
          const blob = new Blob(chunks, { type: 'audio/webm' });
          const b64 = btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
          try {
            S.voice = await api('POST', '/voice/messages', {
              establishment_id: S.ctx.establishment.id,
              audio_base64: b64,
              duration: (Date.now() - t0) / 1000,
              transcription: $('#vt').value,
              confidence: conf
            });
          } catch {}
        }
        $('#vbox').remove();
        cart();
      });
    } catch {
      toast('Interprétation indisponible', 'error');
    }
  };
}

// ROUTEUR
async function route() {
  clearInterval(S.poll);
  app.onclick = app.onchange = null;
  const h = location.hash.slice(2) || '';
  ({ '': home, menu, order: track, history: histView, profile, staff, manager, admin }[h] || home)();
}

async function start() {
  try {
    S.me = await api('GET', '/me');
  } catch (e) {
    if (!online()) {
      S.me = LS.get('me', { display_name: '', memberships: [] });
    } else {
      return welcome();
    }
  }
  LS.set('me', S.me);
  const pq = LS.get('qr', null);
  if (pq) {
    LS.set('qr', null);
    try {
      await scan(pq);
      location.hash = '#/menu';
    } catch {}
  }
  await loadMenu();
  route();
}

window.addEventListener('hashchange', route);
window.addEventListener('online', route);
window.addEventListener('offline', route);

(async () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  const q = new URLSearchParams(location.search).get('q');
  if (!localStorage.getItem('device_id') || !(await K.hasKey())) {
    if (q) LS.set('qr', q);
    return welcome();
  }
  try {
    await login();
  } catch (e) {
    if (online() && (e.code === 'DEVICE_REVOKED' || e.code === 'UNKNOWN_DEVICE')) {
      await K.wipe();
      localStorage.removeItem('device_id');
      return welcome('Cet appareil n’est plus autorisé.');
    }
  }
  const pq = q || LS.get('qr', null);
  if (pq) {
    LS.set('qr', null);
    try {
      await scan(pq);
      history.replaceState(null, '', '/#/menu');
    } catch {
      toast('QR invalide ou expiré', 'error');
    }
  }
  await start();
  if (S.ctx && pq) location.hash = '#/menu';
})();
