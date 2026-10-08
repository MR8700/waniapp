<#
.SYNOPSIS
    WANI APP — Script de Déploiement 1-Clic Automatisé (Windows PowerShell)
.DESCRIPTION
    Valide les prérequis, exécute les 18 tests automatisés, configure les variables d'environnement,
    synchronise avec GitHub et déploie en production sur Vercel.
#>

param(
    [switch]$SkipTest,
    [switch]$SkipPush,
    [string]$Secret = ""
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  ██╗    ██╗ █████╗ ███╗   ██╗██╗     █████╗ ██████╗ ██████╗ " -ForegroundColor DarkYellow
Write-Host "  ██║    ██║██╔══██╗████╗  ██║██║    ██╔══██╗██╔══██╗██╔══██╗" -ForegroundColor DarkYellow
Write-Host "  ██║ █╗ ██║███████║██╔██╗ ██║██║    ███████║██████╔╝██████╔╝" -ForegroundColor DarkYellow
Write-Host "  ██║███╗██║██╔══██║██║╚██╗██║██║    ██╔══██║██╔═══╝ ██╔═══╝ " -ForegroundColor DarkYellow
Write-Host "  ╚███╔███╔╝██║  ██║██║ ╚████║██║    ██║  ██║██║     ██║     " -ForegroundColor DarkYellow
Write-Host "   ╚══╝╚══╝ ╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝    ╚═╝  ╚═╝╚═╝     ╚═╝     " -ForegroundColor DarkYellow
Write-Host ""
Write-Host "⚡ WANI APP — Système de Déploiement 1-Clic" -ForegroundColor Cyan
Write-Host "Mooré : WANI = « Emmener, venir avec, apporter »" -ForegroundColor DarkGray
Write-Host "────────────────────────────────────────────────────────────" -ForegroundColor Gray

# 1. Vérification de Node.js (Node >= 22.5)
Write-Host "[1/5] Vérification de l'environnement..." -ForegroundColor Yellow
$nodeVersion = node -v
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Node.js n'est pas installé ou inaccessible dans le PATH." -ForegroundColor Red
    exit 1
}
Write-Host "✔ Node.js détecté : $nodeVersion" -ForegroundColor Green

# 2. Génération / Lecture de la clé secrète
Write-Host "[2/5] Configuration des variables de sécurité..." -ForegroundColor Yellow
$envPath = Join-Path $PSScriptRoot ".env"
if (-not $Secret) {
    if (Test-Path $envPath) {
        $existing = Get-Content $envPath | Select-String -Pattern "^APP_SECRET=(.+)$"
        if ($existing) {
            $Secret = $existing.Matches[0].Groups[1].Value.Trim()
        }
    }
}
if (-not $Secret) {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $Secret = [System.BitConverter]::ToString($bytes).Replace("-", "").ToLower()
    Add-Content -Path $envPath -Value "APP_SECRET=$Secret`nDATA_DIR=./data`nPORT=3000`nNODE_ENV=production"
    Write-Host "✔ Clé APP_SECRET générée et sauvegardée dans .env" -ForegroundColor Green
} else {
    Write-Host "✔ Clé APP_SECRET active : $($Secret.Substring(0, 8))..." -ForegroundColor Green
}

# 3. Tests d'intégrité
if (-not $SkipTest) {
    Write-Host "[3/5] Exécution des 18 tests d'intégrité et de sécurité..." -ForegroundColor Yellow
    npm test
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ Échec des tests. Déploiement stoppé par mesure de sécurité." -ForegroundColor Red
        exit 1
    }
    Write-Host "✔ Tous les tests passent avec succès !" -ForegroundColor Green
} else {
    Write-Host "⚠ Tests ignorés (-SkipTest)" -ForegroundColor DarkGray
}

# 4. Synchronisation Git & GitHub
if (-not $SkipPush) {
    Write-Host "[4/5] Synchronisation Git avec GitHub..." -ForegroundColor Yellow
    if (-not (Test-Path (Join-Path $PSScriptRoot ".git"))) {
        git init
        git branch -M main
        git remote add origin "https://github.com/MR8700/waniapp.git" 2>$null
    }
    git add .
    git commit -m "feat: WANI APP - 1-click deployment & production release" 2>$null
    git push -u origin main
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✔ Code synchronisé sur GitHub (main) !" -ForegroundColor Green
    } else {
        Write-Host "⚠ Note: Push git en attente d'authentification ou distant déjà à jour." -ForegroundColor DarkGray
    }
} else {
    Write-Host "⚠ Push git ignoré (-SkipPush)" -ForegroundColor DarkGray
}

# 5. Déploiement Vercel
Write-Host "[5/5] Déploiement en production sur Vercel..." -ForegroundColor Yellow
$env:APP_SECRET = $Secret
$env:DATA_DIR = "/tmp/wani-data"

npx --yes vercel --prod --yes --build-env DATA_DIR="/tmp/wani-data"

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "════════════════════════════════════════════════════════════" -ForegroundColor Green
    Write-Host "🎉 WANI APP DÉPLOYÉE AVEC SUCCÈS SUR VERCEL !" -ForegroundColor Green
    Write-Host "════════════════════════════════════════════════════════════" -ForegroundColor Green
    Write-Host "Votre service de commande en temps réel est actif." -ForegroundColor Cyan
} else {
    Write-Host ""
    Write-Host "ℹ️  Si vous n'êtes pas encore connecté à Vercel en CLI, exécutez :" -ForegroundColor Cyan
    Write-Host "    npx vercel login" -ForegroundColor White
    Write-Host "Puis relancez ce script : .\deploy.ps1" -ForegroundColor White
    Write-Host "Ou cliquez directement sur le bouton 'Deploy with Vercel' dans le README.md !" -ForegroundColor Yellow
}
