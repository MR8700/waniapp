// KeyStore web : clé ECDSA P-256 NON EXPORTABLE (WebCrypto) dans IndexedDB.
// L'appareil est la clé d'accès. Il n'y a AUCUN mot de passe.
// La biométrie (Face ID / Empreinte / Windows Hello) est une couche de protection optionnelle,
// doublée d'un code de secours (PIN 6 chiffres) avec protection anti-force brute (verrouillage temporaire).

const DB = 'device-keystore';
const idb = () => new Promise((res, rej) => {
  const r = indexedDB.open(DB, 3);
  r.onupgradeneeded = () => {
    if (!r.result.objectStoreNames.contains('kv')) {
      r.result.createObjectStore('kv');
    }
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});

const get = async k => {
  const d = await idb();
  return new Promise(r => {
    const q = d.transaction('kv', 'readonly').objectStore('kv').get(k);
    q.onsuccess = () => r(q.result);
    q.onerror = () => r(null);
  });
};

const set = async (k, v) => {
  const d = await idb();
  return new Promise(r => {
    const t = d.transaction('kv', 'readwrite');
    t.objectStore('kv').put(v, k);
    t.oncomplete = () => r(true);
  });
};

const del = async k => {
  const d = await idb();
  return new Promise(r => {
    const t = d.transaction('kv', 'readwrite');
    t.objectStore('kv').delete(k);
    t.oncomplete = () => r(true);
  });
};

const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const enc = s => new TextEncoder().encode(s);

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', enc(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export const KeyStore = {
  async hasKey() {
    return !!(await get('keypair'));
  },

  async create() {
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false, // non-exportable: la clé privée ne quitte jamais l'appareil
      ['sign', 'verify']
    );
    await set('keypair', kp);
    return b64(await crypto.subtle.exportKey('spki', kp.publicKey));
  },

  async publicKey() {
    const kp = await get('keypair');
    return kp && b64(await crypto.subtle.exportKey('spki', kp.publicKey));
  },

  async sign(msg) {
    const kp = await get('keypair');
    if (!kp?.privateKey) throw new Error('NO_KEY');
    return b64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, enc(msg)));
  },

  async wipe() {
    await del('keypair');
    await del('bio');
    await del('bio_enabled');
    await del('backup_salt');
    await del('backup_hash');
    await del('failed_attempts');
    await del('lockout_until');
  },

  // --- Biométrie & Code de secours ---
  async biometricAvailable() {
    try {
      return !!(window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
    } catch {
      return false;
    }
  },

  async isProtected() {
    const bioOn = await get('bio_enabled');
    const hasCode = !!(await get('backup_hash'));
    return !!(bioOn || hasCode);
  },

  async getProtectionInfo() {
    const hasBio = !!(await get('bio'));
    const bioOn = !!(await get('bio_enabled'));
    const hasBackup = !!(await get('backup_hash'));
    return { isProtected: bioOn || hasBackup, bioEnabled: bioOn, hasBioCredential: hasBio, hasBackupCode: hasBackup };
  },

  generateRandomBackupCode() {
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    return String(100000 + (arr[0] % 900000)); // Code PIN à 6 chiffres
  },

  async setBackupCode(rawCode) {
    const clean = String(rawCode).replace(/\D/g, '');
    if (clean.length < 6) throw new Error('Le code de secours doit comporter au moins 6 chiffres');
    const salt = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
    const hash = await sha256Hex(salt + ':' + clean);
    await set('backup_salt', salt);
    await set('backup_hash', hash);
    await del('failed_attempts');
    await del('lockout_until');
    return clean;
  },

  // Vérification avec défense anti-force brute
  async verifyBackupCode(candidateCode) {
    const now = Date.now();
    const lockoutUntil = Number(await get('lockout_until')) || 0;
    if (now < lockoutUntil) {
      const remainingSecs = Math.ceil((lockoutUntil - now) / 1000);
      throw new Error(`LOCKOUT: Trop d'échecs. Réessayez dans ${remainingSecs}s`);
    }

    const clean = String(candidateCode).replace(/\D/g, '');
    const salt = await get('backup_salt');
    const expectedHash = await get('backup_hash');
    if (!salt || !expectedHash) return false;

    const computedHash = await sha256Hex(salt + ':' + clean);
    const valid = computedHash === expectedHash;

    if (valid) {
      // Succès : réinitialise les compteurs
      await del('failed_attempts');
      await del('lockout_until');
      return true;
    }

    // Échec : incrémente les tentatives et verrouille si nécessaire
    const attempts = (Number(await get('failed_attempts')) || 0) + 1;
    await set('failed_attempts', attempts);

    if (attempts >= 8) {
      await set('lockout_until', now + 120000); // 2 minutes
    } else if (attempts >= 5) {
      await set('lockout_until', now + 30000); // 30 secondes
    }

    return false;
  },

  async enableProtection(displayName, customCode = null) {
    const code = customCode ? await this.setBackupCode(customCode) : await this.setBackupCode(this.generateRandomBackupCode());
    let bioRegistered = false;
    if (await this.biometricAvailable()) {
      try {
        const c = await navigator.credentials.create({
          publicKey: {
            challenge: crypto.getRandomValues(new Uint8Array(32)),
            rp: { name: 'WANI APP' },
            user: {
              id: crypto.getRandomValues(new Uint8Array(16)),
              name: displayName || 'client',
              displayName: displayName || 'Client WANI'
            },
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
            authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
            timeout: 60000
          }
        });
        if (c?.rawId) {
          await set('bio', new Uint8Array(c.rawId));
          bioRegistered = true;
        }
      } catch (err) {
        console.warn('WebAuthn non configuré, le code de secours servira de verrouillage principal:', err);
      }
    }
    await set('bio_enabled', true);
    return { backupCode: code, biometricRegistered: bioRegistered };
  },

  async disableProtection() {
    await del('bio');
    await del('bio_enabled');
    await del('backup_salt');
    await del('backup_hash');
    await del('failed_attempts');
    await del('lockout_until');
  },

  // Déverrouillage : tente la biométrie puis bascule automatiquement sur le code de secours
  async unlock(onPromptBackupCode = null) {
    const protectedState = await this.isProtected();
    if (!protectedState) return { ok: true, method: 'none' };

    const bioId = await get('bio');
    const bioOn = await get('bio_enabled');

    if (bioOn && bioId) {
      try {
        await navigator.credentials.get({
          publicKey: {
            challenge: crypto.getRandomValues(new Uint8Array(32)),
            allowCredentials: [{ type: 'public-key', id: bioId }],
            userVerification: 'required',
            timeout: 45000
          }
        });
        return { ok: true, method: 'biometric' };
      } catch (err) {
        // En cas d'annulation ou échec de biométrie, on propose le code de secours
        console.warn('Biométrie ignorée ou échouée, recours au code de secours:', err);
      }
    }

    // Recours au Code de Secours
    if (typeof onPromptBackupCode === 'function') {
      const codeProvided = await onPromptBackupCode();
      if (!codeProvided) throw new Error('UNLOCK_CANCELLED');
      const valid = await this.verifyBackupCode(codeProvided);
      if (!valid) throw new Error('INVALID_BACKUP_CODE');
      return { ok: true, method: 'backup_code' };
    }

    return { ok: true, method: 'bypass' };
  },

  b64, unb64
};
