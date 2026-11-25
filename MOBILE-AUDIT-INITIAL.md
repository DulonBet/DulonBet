# Audit technique initial — applications mobiles DulonBet

Date : 25 novembre 2026  
Branche examinée : `dulonbet-mobile-apps`  
Projet Supabase examiné en lecture seule : `abagofwqjostilsilafk`

## Périmètre et sécurité

Cette étape est un audit en lecture seule. Aucun fichier du site n'a été modifié, aucune fonction Edge n'a été déployée, aucune politique RLS ni donnée n'a été modifiée. La branche `main` n'a pas été touchée. Aucun secret ni valeur de clé n'est reproduit dans ce rapport.

## Constat technique

- Le dépôt contient un site web principalement statique, avec un gros `index.html`, un manifeste PWA et un Service Worker.
- Le manifeste configure le mode autonome et l'orientation portrait.
- Aucun projet Capacitor, Expo/React Native ou manifeste npm n'a été identifié à la racine lors de l'inspection initiale.
- Les fonctions Edge actives couvrent les dépôts, retraits, FeexPay, les notifications et les vérifications de compte.
- Les tables de transactions et les tables d'administration ont RLS activé.

## Points à corriger ou à valider avant une application mobile

### 1. Incohérence du registre de notifications — anomalie fonctionnelle confirmée

La fonction Edge de notification accepte le type `deposit_payment_confirmed_xbet_uncredited` (paiement Mobile Money confirmé mais crédit 1XBET non confirmé). En revanche, la fonction SQL `claim_dulonbet_notification_event` ne liste pas ce type parmi les événements autorisés et renvoie `conflict` pour un type non autorisé.

Conséquence probable : la notification administrateur spécifique à ce cas ne peut pas être réservée dans le registre et l'envoi échoue. À corriger avec une migration SQL contrôlée et un test, sans intervenir directement sur la production pendant cette phase.

### 2. Fonction SECURITY DEFINER exposée — alerte à examiner

L'advisor Supabase signale `public.rls_auto_enable()` comme exécutable par `anon` et `authenticated`, avec privilèges SECURITY DEFINER. Les privilèges SQL confirment ces droits. Son type event-trigger peut limiter l'appel direct, mais l'exposition de EXECUTE doit être examinée et réduite au strict nécessaire.

### 3. Validation administrateur de paiement de retrait

La fonction `dulonbet_admin_mark_withdrawal_paid(bigint)` est SECURITY DEFINER et exécutable par le rôle `authenticated`. Son contrôle d'autorisation s'appuie sur une adresse e-mail codée en dur dans le corps SQL, plutôt que sur une vérification cohérente de l'appartenance à `admin_users`. À revoir avant de bâtir l'application Admin et à tester avec un compte non administrateur.

### 4. Tables RLS sans politiques

L'advisor signale quatre tables avec RLS activé mais sans politique : `dulonbet_admin_notifications`, `dulonbet_payment_attempts`, `dulonbet_payment_events` et `dulonbet_payout_rate_limits`. Cela bloque normalement les accès via les rôles API ordinaires ; cela peut être intentionnel si l'accès passe uniquement par les fonctions serveur. Ne pas ajouter de politiques publiques par réflexe.

### 5. Fonctions Edge appelables sans vérification JWT native

Plusieurs fonctions ont `verify_jwt=false`. Certaines contrôlent un secret interne dédié ou un secret webhook dans leur code. Cela ne constitue pas à lui seul une preuve de vulnérabilité, mais chaque fonction doit être vérifiée individuellement. Les secrets internes ne doivent jamais être embarqués dans une application mobile.

### 6. Protection des mots de passe Supabase Auth

L'advisor indique que la protection contre les mots de passe compromis est désactivée. À activer après validation des impacts sur les connexions et la politique de mot de passe.

## Architecture mobile — décision provisoire

- Garder le site actuel et son hébergement indépendants des builds mobiles.
- Continuer à évaluer Capacitor pour l'application Client, après vérification des scripts, bibliothèques, flux d'authentification et appels backend du site.
- Concevoir l'application Admin séparément, avec authentification et autorisation serveur vérifiées.
- Ne jamais placer de clé service-role, secret FeexPay, secret 1XBET ou secret interne dans les binaires Android/iOS.
- Ne pas créer de paiement réel pendant les tests ; utiliser un environnement de test ou des scénarios simulés.
- Vérifier l'éligibilité des services et des pays visés selon les règles Google Play et Apple avant toute publication.

## Étape suivante

Poursuivre l'audit du code client et de toutes les fonctions Edge, confirmer les chemins d'authentification et les contrôles d'accès, puis préparer des correctifs isolés et testables. Aucun correctif Supabase ni déploiement de production n'est autorisé par ce rapport.
