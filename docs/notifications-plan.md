# DulonBet — Préparation des notifications (proposition non activée)

## Statut
- Branche de préparation isolée : `preview/notifications-prep-2026-11-19`
- Aucun déploiement Supabase ou Vercel effectué.
- Aucun secret, réglage DNS, flux de paiement ou droit administrateur modifié.
- Ce document est une proposition d'architecture, pas une activation.

## Objectif
Préparer des notifications administrateur indépendantes du parcours de paiement : un échec d'envoi de notification ne doit jamais annuler, valider ou relancer un dépôt/retrait.

## Événements à notifier
| Événement | Canal e-mail | Canal WhatsApp |
| --- | --- | --- |
| Dépôt demandé | Information « en attente », jamais présenté comme payé | Groupe Dépôts, après choix d'une méthode officielle compatible |
| Paiement FeexPay confirmé | Envoyer seulement après confirmation serveur authentifiée | Groupe Dépôts |
| Crédit 1XBET confirmé | Envoyer seulement après réponse positive confirmée de l'API 1XBET | Groupe Dépôts |
| Retrait reçu | Signaler « à vérifier » | Groupe Retraits |
| Retrait validé côté 1XBET | Signaler « validé côté 1XBET, paiement Mobile Money non confirmé » | Groupe Retraits |
| Paiement Mobile Money réellement terminé | Signaler payé uniquement après confirmation administrative fiable | Groupe Retraits |
| Erreur ou état inconnu | Alerte explicite « vérification nécessaire » | Groupe concerné, si canal autorisé |

## Architecture proposée
1. Un module d'envoi dédié, séparé des fonctions qui créent les paiements ou valident les retraits.
2. E-mail via Resend, avec clé API conservée exclusivement dans les secrets Supabase (jamais dans le navigateur, le dépôt Git ou les journaux).
3. Déclenchement serveur-à-serveur authentifié avec secret interne dédié, distinct des secrets FeexPay et 1XBET.
4. Liste fermée de types d'événements, validation stricte des données et messages minimaux (pas de code de retrait ni de secrets dans les notifications).
5. Protection contre les doublons au moyen d'une clé d'événement stable et d'un registre persistant avant l'activation.
6. Les erreurs de notification sont journalisées et réessayables sans rejouer l'opération financière.
7. WhatsApp reste désactivé jusqu'à confirmation d'un fournisseur/API officiel prenant en charge le cas d'usage des groupes. Les liens d'invitation seuls ne permettent pas l'envoi automatique.

## Conditions préalables
- Vérifier que `dulonbet.com` est entièrement validé dans Resend (DKIM, enregistrements CNAME et configuration SPF selon les valeurs affichées par Resend).
- Préserver les enregistrements DNS et le routage e-mail existants chez LWS; ne pas remplacer les MX existants sans vérification.
- Confirmer l'adresse destinataire administrateur.
- Choisir et valider une méthode WhatsApp autorisée pour les deux groupes.
- Tester en mode non productif avec des événements fictifs, puis faire examiner le diff avant toute activation.

## Garde-fous non négociables
- Une notification n'est jamais une preuve de paiement.
- Aucun crédit 1XBET sur la seule base d'un message e-mail ou WhatsApp.
- Aucune demande de retrait n'est marquée « payée » sans preuve de paiement réel.
- Pas de test de dépôt réel ni d'appel financier de test sans autorisation explicite.
- Pas de modification de `index.html`, des fonctions existantes, de la base de données ou des secrets dans cette étape.
- Toute activation en production nécessite l'accord explicite du propriétaire.
