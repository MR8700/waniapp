# WANI Vendeur — Gestion & Commandes en Temps Réel

Tableau de bord mobile-first et tablette pour les gérants, serveurs et barmans.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/MR8700/wani-vendeur&project-name=wani-vendeur)

---

## 🌟 Fonctionnalités Vendeur

- **Zéro Mot de Passe** : Votre terminal vous connecte automatiquement.
- **Gestion des Établissements** : Créez et configurez votre lieu de vente en 1 clic.
- **Points de Livraison & QR Codes** :
  - Créez vos tables, salons VIP, comptoirs ou livraisons.
  - Générez et imprimez les QR codes uniques de chaque table.
- **Gestion Complète des Menus** :
  - Ajoutez vos produits avec prix en FCFA, descriptions et photos.
  - Bascule en un clic « Disponible / En rupture » pour éviter les ruptures inattendues.
- **Poste Commandes en Temps Réel** :
  - Carillon sonore Web Audio bip-tonalité à chaque nouvelle commande.
  - Mise à jour instantanée du statut :
    - `✓ Accepter (Reçue)` ➔ Notifie immédiatement le client que sa commande est bien **Reçue par le vendeur**.
    - `🍳 En préparation` ➔ Notifie que la commande est en cours.
    - `🚀 Servir à table` ➔ Notifie que la commande arrive.
    - `💳 Encaisser` ➔ Espèces, Orange Money, Moov Money, Carte.
- **Recettes & Statistiques du Jour** :
  - Suivi du chiffre d'affaires encaissé et nombre de commandes.
- **Gestion d'Équipe** :
  - Génération de codes temporaires (24h) pour le personnel (serveurs, barmans).

---

## 🚀 Démarrage Local

```bash
cd C:\dev\wani-vendeur
npm start
# -> http://localhost:5001
```
