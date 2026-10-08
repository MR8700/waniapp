# WANI APP — Application de Commande & Service Instantané

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/MR8700/waniapp&env=APP_SECRET,DATA_DIR&project-name=waniapp&repository-name=waniapp)
[![Tests Passing](https://img.shields.io/badge/tests-18%20passing-brightgreen.svg)](https://github.com/MR8700/waniapp)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.5-informational.svg)](https://nodejs.org/)
[![Zero NPM Dependencies](https://img.shields.io/badge/dependencies-zero%20npm-blue.svg)](package.json)
[![Security](https://img.shields.io/badge/auth-WebCrypto%20ECDSA%20P--256-orange.svg)](web/keystore.js)

> **Étymologie & Philosophie**  
> En langue **mooré** (Burkina Faso), **WANI** signifie *« emmener, venir avec, apporter »* (*Wani koom* = apporte de l'eau, *Wani riri* = apporte le repas).  
> **WANI APP** matérialise cette promesse : les clients commandent instantanément depuis leur table ou en emporté, les barmans et serveurs reçoivent la commande en temps réel, et le service est fluide sans file d'attente ni friction.

---

## ⚡ Déploiement en 1 Clic

### Option A : Déploiement Web Instantané (Recommandé)
Cliquez sur le bouton ci-dessous pour déployer automatiquement WANI APP sur votre compte Vercel :

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/MR8700/waniapp&env=APP_SECRET,DATA_DIR&project-name=waniapp&repository-name=waniapp)

Lors du déploiement, renseignez les 2 variables d'environnement demandées par Vercel :

| Nom (Name) | Valeur recommandée (Value) | Description |
| :--- | :--- | :--- |
| **`APP_SECRET`** | `43a068002db39151e682de5c1c7226af14ae0c76d1a51bac97c1f72db6ad16f7` | Clé cryptographique pour la signature des sessions |
| **`DATA_DIR`** | `/tmp/wani-data` | Dossier d'écriture temporaire pour SQLite sur Vercel |

---

### Option B : Déploiement Automatisé par Script

Des scripts de déploiement en une seule commande sont inclus pour tous les systèmes d'exploitation :

#### 🪟 Windows (PowerShell)
```powershell
.\deploy.ps1
```
*Le script valide l'environnement Node.js 22.5+, exécute les 18 tests automatisés, génère la clé de sécurité, synchronise GitHub et déploie directement sur Vercel.*

#### 🐧 Linux / macOS / WSL
```bash
chmod +x deploy.sh
./deploy.sh
```

#### 📦 Commande Universelle NPM
```bash
npm run deploy
```

---

## 🌟 Points Forts du Système

### 🔐 1. L'Appareil est la Clé d'Accès (Zéro Mot de Passe)
- **Clé Cryptographique Matérielle** : Chaque appareil génère localement une paire de clés asymétriques **ECDSA P-256** (WebCrypto) avec `extractable: false`. La clé privée ne quitte **jamais** le navigateur.
- **Biométrie Optionnelle** : Verrouillage Face ID / Empreinte digitale / Windows Hello via WebAuthn `userVerification: required`.
- **Code de Secours à 6 Chiffres** : En cas de capteur mouillé ou d'indisponibilité de la biométrie, un code PIN sécurisé (salé + haché SHA-256) garantit un déverrouillage immédiat, protégé contre les attaques par force brute (verrouillage temporaire après 5 tentatives).
- **Révocation & Récupération d'Accès** : Procédure administrative de migration de compte en cas de perte de téléphone avec validation gérant.

### 🎨 2. Design Moderne 3D & Mobile-First (Sahelian Pulse)
- **Typographies de Précision** : Titres et CTA percutants en **Outfit**, lisibilité optimale du corps de texte en **Plus Jakarta Sans**.
- **Effets 3D & Micro-interactions** : Biseaux intérieurs, ombres multicouches, retour tactile physique au toucher (`translateY` + ombres portées), indicateur d'état pulsant en direct.
- **Dock Flottant & Verre Dépoli** : Panier rétractable fluide, filtres de catégories et étiquettes fraîcheur.

### 📡 3. Réception de Commande & Temps Réel
- **Server-Sent Events (SSE)** : Connexion bidirectionnelle sans latence (`/events` & `/realtime`) avec reconnexion automatique.
- **Carillon Sonore Web Audio** : Ding-dong biphonique synthétisé (zéro fichier audio externe requis) alertant le barman à l'arrivée d'une nouvelle commande.
- **Poste Staff / Comptoir** : Gestion du cycle de vie des commandes (`EN ATTENTE` ➔ `EN PRÉPARATION` ➔ `SERVI`), encaissement multicanal (Espèces, Orange Money, Moov Money, Carte bancaire).
- **Gestion des Tables & QR Codes** : Rotation instantanée des jetons QR de table, renommage des tables et désactivation par le gérant.

### 🛠️ 4. Zéro Dépendance NPM
- Construit exclusivement sur les modules natifs de Node.js 22+ : `node:sqlite`, `node:crypto`, `node:http`, `node:fs`.
- Démarrage instantané, surface d'attaque minimale, maintenance nulle.

---

## 💻 Démarrage Local Rapide

```bash
# 1. Cloner le dépôt
git clone https://github.com/MR8700/waniapp.git
cd waniapp

# 2. Lancer les tests d'intégrité (18 tests)
npm test

# 3. Lancer le serveur local
npm start
# -> http://localhost:3000
```

Au tout premier lancement :
1. La base SQLite `data/app.db` est automatiquement initialisée et alimentée (`seed`).
2. Le **code d'accès gérant** (valable 24h, à usage unique) est affiché dans votre terminal.
3. Renseignez ce code dans le champ *Code d'équipe / gérant* lors de votre premier enregistrement pour activer le profil administrateur.

---

## ⚙️ Configuration & Variables d'Environnement

| Variable | Description | Défaut Local | Défaut Vercel |
| :--- | :--- | :--- | :--- |
| `APP_SECRET` | Clé secrète de signature HMAC des sessions | Générée automatiquement dans `.secret` | Configurée dans Vercel |
| `DATA_DIR` | Répertoire de persistance SQLite et médias | `./data` | `/tmp/wani-data` |
| `PORT` | Port d'écoute du serveur HTTP | `3000` | Port assigné |
| `NODE_ENV` | Mode d'exécution | `development` | `production` |

Un fichier template [.env.example](file:///.env.example) est fourni à la racine.

---

## 🏛️ Architecture du Projet

```text
waniapp/
├── api/
│   └── index.js              # Adaptateur Serverless Vercel
├── server/
│   ├── app.js                # Routeur HTTP, API REST, SSE et contrôle d'accès
│   ├── db.js                 # Schéma relationnel SQLite (node:sqlite)
│   ├── main.js               # Serveur HTTP autonome pour exécution locale
│   ├── seed.js               # Amorçage des produits, zones, tables et invitations
│   ├── util.js               # Primitives cryptographiques (HMAC, SHA-256, tokens)
│   └── voice.js              # Interprétation de commandes vocales
├── web/
│   ├── index.html            # Application Single Page mobile-first
│   ├── app.js                # Interface utilisateur 3D, SSE, gestion d'état
│   ├── keystore.js           # Coffre-fort WebCrypto ECDSA P-256, biométrie & PIN
│   └── style.css             # Design System 3D (Palette Sahelian Pulse)
├── test/
│   ├── auth.test.js          # Tests d'authentification matérielle & sécurité
│   └── orders.test.js        # Tests de commandes, stocks, SSE et tables
├── .github/workflows/
│   └── deploy.yml            # Pipeline CI/CD GitHub Actions
├── deploy.ps1                # Déploiement 1-clic Windows PowerShell
├── deploy.sh                 # Déploiement 1-clic Linux / macOS
├── scripts/
│   └── deploy.js             # Déploiement 1-clic Node.js universel
├── vercel.json               # Configuration du routage et headers Vercel
└── package.json              # Métadonnées et scripts de démarrage
```

---

## 🧪 Tests Automatisés

WANI APP intègre une suite de tests unitaires et d'intégration couvrant l'ensemble des flux critiques :

```bash
npm test
```

Résultats : **18 tests validés (0 échec)** :
- ✔ Nouvel appareil + connexion + `/me`
- ✔ Signature invalide rejetée
- ✔ Replay : nonce réutilisé refusé
- ✔ Nonce expiré refusé
- ✔ Preuve de possession cryptographique requise
- ✔ Rotation et détection de réutilisation des jetons de rafraîchissement
- ✔ Révocation d'appareils et déconnexion forcée
- ✔ Code d'invitation à usage unique et expiration
- ✔ Récupération d'appareil approuvée par admin
- ✔ Rejet et listing des demandes de récupération
- ✔ Blocage strict du path traversal
- ✔ QR codes de table valides, expirés et établissements inactifs
- ✔ Idempotence de création de commande et détection des doublons
- ✔ Décrémentation et restitution automatique des stocks
- ✔ Audit et traçabilité des modifications de prix
- ✔ Expiration automatique des paniers et filtres de catégories
- ✔ Flux d'événements en temps réel Server-Sent Events (SSE)
- ✔ Rotation, édition et désactivation des tables par le gérant

---

## 📄 Licence

Projet sous licence MIT — Réalisé avec fierté pour simplifier la restauration et la convivialité.
