/**
 * WANI Client — Configuration API & Sous-domaines
 * Détection automatique de l'URL du Backend selon l'environnement
 */

const host = window.location.hostname;
const isDev = host === 'localhost' || host === '127.0.0.1';

let defaultApi = '';
if (host.startsWith('client.')) {
  defaultApi = window.location.protocol + '//' + host.replace(/^client\./, '');
} else if (!isDev && !host.endsWith('.vercel.app') && host !== 'waniapps.vercel.app') {
  defaultApi = 'https://waniapps.vercel.app';
}

export const API_BASE = window.WANI_API || defaultApi;
