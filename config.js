/**
 * WANI Vendeur — Configuration API & Sous-domaines
 */

const host = window.location.hostname;
const isDev = host === 'localhost' || host === '127.0.0.1';

let defaultApi = '';
if (host.startsWith('vendeur.')) {
  defaultApi = window.location.protocol + '//' + host.replace(/^vendeur\./, '');
} else if (!isDev && !host.endsWith('.vercel.app') && host !== 'waniapps.vercel.app') {
  defaultApi = 'https://waniapps.vercel.app';
}

export const API_BASE = window.WANI_API || defaultApi;
