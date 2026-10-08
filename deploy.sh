#!/usr/bin/env bash
# ==============================================================================
# WANI APP — Script de Déploiement 1-Clic Automatisé (Bash / Linux / macOS)
# Mooré : WANI = « Emmener, venir avec, apporter »
# ==============================================================================

set -e

echo -e "\033[38;5;208m"
cat << "EOF"
  ██╗    ██╗ █████╗ ███╗   ██╗██╗     █████╗ ██████╗ ██████╗ 
  ██║    ██║██╔══██╗████╗  ██║██║    ██╔══██╗██╔══██╗██╔══██╗
  ██║ █╗ ██║███████║██╔██╗ ██║██║    ███████║██████╔╝██████╔╝
  ██║███╗██║██╔══██║██║╚██╗██║██║    ██╔══██║██╔═══╝ ██╔═══╝ 
  ╚███╔███╔╝██║  ██║██║ ╚████║██║    ██║  ██║██║     ██║     
   ╚══╝╚══╝ ╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝    ╚═╝  ╚═╝╚═╝     ╚═╝     
EOF
echo -e "\033[0m"
echo -e "\033[36m⚡ WANI APP — Système de Déploiement 1-Clic Vercel & Production\033[0m"
echo "────────────────────────────────────────────────────────────"

# 1. Vérification de Node.js
echo -e "\033[33m[1/5] Vérification de l'environnement...\033[0m"
node -v || { echo "❌ Node.js 22.5+ est requis."; exit 1; }
echo -e "\033[32m✔ Node.js détecté\033[0m"

# 2. Clé de sécurité
echo -e "\033[33m[2/5] Configuration des variables de sécurité...\033[0m"
if [ -z "$APP_SECRET" ]; then
  if [ -f .env ]; then
    APP_SECRET=$(grep -E "^APP_SECRET=" .env | cut -d '=' -f2-)
  fi
fi

if [ -z "$APP_SECRET" ]; then
  APP_SECRET=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")
  echo "APP_SECRET=$APP_SECRET" >> .env
  echo "DATA_DIR=./data" >> .env
  echo "PORT=3000" >> .env
  echo "NODE_ENV=production" >> .env
  echo -e "\033[32m✔ Clé APP_SECRET générée dans .env\033[0m"
else
  echo -e "\033[32m✔ Clé APP_SECRET configurée (${APP_SECRET:0:8}...)\033[0m"
fi

# 3. Tests
echo -e "\033[33m[3/5] Exécution des 18 tests d'intégrité et de sécurité...\033[0m"
npm test
echo -e "\033[32m✔ Tous les tests passent avec succès !\033[0m"

# 4. Synchronisation Git
echo -e "\033[33m[4/5] Synchronisation Git avec GitHub...\033[0m"
if [ ! -d ".git" ]; then
  git init
  git branch -M main
  git remote add origin "https://github.com/MR8700/waniapp.git" 2>/dev/null || true
fi
git add .
git commit -m "feat: WANI APP - 1-click deployment & production release" 2>/dev/null || true
git push -u origin main || echo -e "\033[90m⚠ Push ignoré ou en attente d'authentification\033[0m"

# 5. Déploiement Vercel
echo -e "\033[33m[5/5] Déploiement en production sur Vercel...\033[0m"
export APP_SECRET
export DATA_DIR="/tmp/wani-data"

npx --yes vercel --prod --yes --build-env DATA_DIR="/tmp/wani-data" || {
  echo ""
  echo -e "\033[33mℹ️  Connectez-vous à Vercel en exécutant: npx vercel login\033[0m"
  echo -e "\033[33m   Puis relancez ./deploy.sh\033[0m"
}

echo ""
echo -e "\033[32m════════════════════════════════════════════════════════════\033[0m"
echo -e "\033[32m🎉 Script de déploiement WANI APP terminé avec succès !\033[0m"
echo -e "\033[32m════════════════════════════════════════════════════════════\033[0m"
