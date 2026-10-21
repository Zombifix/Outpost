-- Migration 023 : refaire la recherche d'image de chaque destination.
-- resolve-destination-image prend désormais en priorité la bannière Wikivoyage
-- (Wikidata P948) et rejette les photos Unsplash/Pexels qui ne nomment pas le
-- lieu. Les lignes déjà « active » ne sont jamais recalculées : on les marque
-- « failed » sans date de validation, ce qui relance la résolution au prochain
-- appel (l'ancienne image reste affichée en attendant). Les images choisies à
-- la main (is_manual_override) ne bougent pas.

update destination_images
set status = 'failed',
    last_validated_at = null
where is_manual_override = false
  and status in ('active', 'failed');
