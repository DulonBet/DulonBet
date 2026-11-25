# Plan de préparation des applications mobiles DulonBet

Branche de travail : `dulonbet-mobile-apps`
Branche de référence : `main`

## Objectif et règle de protection

Préparer deux applications distinctes — DulonBet Client et DulonBet Admin — pour Android et iOS, sans modifier ni déployer le site web en production. Aucun changement de base Supabase, aucune migration, aucun changement de fonction Edge et aucun secret ne sont inclus dans cette étape.

## Constat vérifié dans le dépôt

- Le dépôt contient un site principalement statique : `index.html` (environ 946 Ko), `centre-aide.html`, des icônes, `manifest.webmanifest` et `sw.js`.
- Le manifeste configure déjà une expérience PWA en affichage autonome, portrait.
- Le Service Worker met en cache les ressources principales et sert une page de secours hors connexion.
- Le dossier Supabase contient des fonctions serveur de retrait et des ressources partagées. Les fonctions de paiement/dépôt doivent faire l'objet d'un audit ciblé avant tout raccordement mobile.
- Aucun `package.json`, projet Expo/React Native ou configuration Capacitor n'a été identifié à la racine dans l'arborescence consultée.

## Choix technique proposé

**Capacitor** est le meilleur premier candidat à évaluer pour empaqueter l'interface web existante dans des applications Android/iOS, car le site est déjà une application web/PWA. Cela permet de préserver au maximum l'interface Client au début.

Pour l'application Admin, créer une interface mobile distincte, avec authentification et autorisations administrateur dédiées. Elle pourra partager les services backend existants, mais ne doit jamais embarquer de clé Supabase service-role ni de secret FeexPay/1XBET.

Ce choix reste une proposition d'architecture : avant de générer les projets natifs, il faut confirmer les dépendances JavaScript réellement utilisées par `index.html`, les routes d'administration, les règles d'authentification et les exigences des boutiques.

## Architecture cible

- Site web existant : reste sur son hébergement et son domaine actuels.
- Application Client : Android/iOS, première étape envisagée avec Capacitor et l'interface web existante.
- Application Admin : Android/iOS, interface dédiée et accès réservé aux administrateurs autorisés.
- Backend : Supabase et fonctions Edge existantes, après audit de sécurité et tests.
- Les applications ne doivent pas appeler directement les fournisseurs de paiement avec des secrets. Les opérations passent par des fonctions serveur protégées et vérifiées.

## Conditions avant tout raccordement ou publication

1. Auditer les fonctions Edge, leurs contrôles d'authentification, les politiques RLS et les permissions administrateur.
2. Vérifier les flux dépôt/retrait en environnement de test sans envoyer de paiement réel.
3. Mettre en place des environnements et variables séparés ; ne jamais copier les secrets de production dans l'application mobile.
4. Vérifier l'éligibilité réglementaire et les règles Google Play / Apple App Store applicables aux services de paris et paiements dans les pays visés.
5. Tester sur appareils Android et iPhone, puis faire une revue de sécurité et de confidentialité.

## Limite de cette étape

Ce document est un plan de préparation uniquement. Il ne crée pas encore d'application compilable, ne modifie pas le site, ne change pas Supabase et ne déclenche aucun déploiement.
