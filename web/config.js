/**
 * WANI Client — Configuration API & Sous-domaines
 * Détection automatique de l'URL du Backend selon l'environnement
 */

const host = window.location.hostname;
const isDev = host === 'localhost' || host === '127.0.0.1';

let defaultApi = 'https://waniapps.vercel.app';
if (isDev && window.location.port !== '3000') {
  defaultApi = 'http://localhost:3000';
} else if (host === 'waniapps.vercel.app' || host.endsWith('.localhost')) {
  defaultApi = '';
}

export const API_BASE = window.WANI_API || defaultApi;
