#!/usr/bin/env node
/**
 * WANI APP — 1-Click Universal Deployment Script
 * Mooré : WANI = « Emmener, venir avec, apporter »
 * Zéro dépendance npm. Fonctionne sous Windows, Linux et macOS.
 */

import { execSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

console.log('\x1b[38;2;194;65;12m');
console.log('  ██╗    ██╗ █████╗ ███╗   ██╗██╗     █████╗ ██████╗ ██████╗ ');
console.log('  ██║    ██║██╔══██╗████╗  ██║██║    ██╔══██╗██╔══██╗██╔══██╗');
console.log('  ██║ █╗ ██║███████║██╔██╗ ██║██║    ███████║██████╔╝██████╔╝');
console.log('  ██║███╗██║██╔══██║██║╚██╗██║██║    ██╔══██║██╔═══╝ ██╔═══╝ ');
console.log('  ╚███╔███╔╝██║  ██║██║ ╚████║██║    ██║  ██║██║     ██║     ');
console.log('   ╚══╝╚══╝ ╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝    ╚═╝  ╚═╝╚═╝     ╚═╝     ');
console.log('\x1b[0m');
console.log('\x1b[36m⚡ WANI APP — Déploiement Automatisé 1-Clic Vercel & Production\x1b[0m');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// 1. Validation de Node.js
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error('\x1b[31m❌ Erreur: Node.js 22.5+ requis (version actuelle: ' + process.version + ')\x1b[0m');
  process.exit(1);
}
console.log('✔ Environnement Node.js valide (' + process.version + ')');

// 2. Gestion de la clé APP_SECRET
let secret = process.env.APP_SECRET;
const envFile = join(ROOT, '.env');
if (!secret && existsSync(envFile)) {
  const match = readFileSync(envFile, 'utf8').match(/APP_SECRET=([^\r\n]+)/);
  if (match) secret = match[1].trim();
}
if (!secret) {
  secret = randomBytes(32).toString('hex');
  console.log('✔ Nouvelle clé secrète générée pour la production : ' + secret.slice(0, 8) + '...');
  try {
    writeFileSync(envFile, `APP_SECRET=${secret}\nDATA_DIR=./data\nPORT=3000\nNODE_ENV=production\n`, { flag: 'a' });
  } catch {}
} else {
  console.log('✔ Clé APP_SECRET configurée (' + secret.slice(0, 8) + '...)');
}

// 3. Exécution des tests d'intégrité
console.log('\n🔍 Exécution des tests de sécurité et d\'intégration...');
const testResult = spawnSync('npm', ['test'], { stdio: 'inherit', shell: true });
if (testResult.status !== 0) {
  console.error('\x1b[31m❌ Les tests ont échoué. Déploiement interrompu par sécurité.\x1b[0m');
  process.exit(1);
}
console.log('\x1b[32m✔ Tous les tests passent avec succès !\x1b[0m');

// 4. Déploiement Vercel
console.log('\n🚀 Déploiement en cours sur Vercel...');
try {
  const vercelArgs = ['--yes', '--prod', '--build-env', `DATA_DIR=/tmp/wani-data`];
  const vercelDeploy = spawnSync('npx', ['--yes', 'vercel', ...vercelArgs], {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, APP_SECRET: secret, DATA_DIR: '/tmp/wani-data' }
  });

  if (vercelDeploy.status === 0) {
    console.log('\n\x1b[32m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🎉 WANI APP EST DÉPLOYÉE AVEC SUCCÈS SUR VERCEL !');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
    console.log('ℹ️  Votre application est en ligne en temps réel.');
    console.log('ℹ️  Les QR codes et l\'authentification par clé matérielle sont actifs.');
  } else {
    console.warn('\n\x1b[33m⚠️  Le déploiement CLI direct nécessite une connexion Vercel (npx vercel login).');
    console.log('Astuce : Vous pouvez aussi déployer en 1 clic via GitHub ou avec le bouton Vercel dans le README.\x1b[0m');
  }
} catch (err) {
  console.error('Erreur déploiement:', err.message);
}
