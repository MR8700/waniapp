/**
 * WANI Vendeur — Configuration API & Sous-domaines
 */

const host = window.location.hostname;
const isDev = host === 'localhost' || host === '127.0.0.1';

let defaultApi = 'https://waniapps.vercel.app';
if (isDev && window.location.port !== '3000') {
  defaultApi = 'http://localhost:3000';
} else if (host === 'waniapps.vercel.app' || host.endsWith('.localhost')) {
  defaultApi = '';
} else if (host.startsWith('vendeur.')) {
  defaultApi = window.location.protocol + '//' + host.replace(/^vendeur\./, '');
}

export const API_BASE = window.WANI_API || defaultApi;
