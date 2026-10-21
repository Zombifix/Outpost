# Notation v2 : modèle des tiroirs

*Spécification de travail, 21 octobre 2026. Remplace la moyenne pondérée de `getDestinationScore`. Rien n'est encore implémenté.*

Le principe : la personne choisit elle-même son tiroir avec le verdict. Les autres réponses ne servent qu'à vérifier si elle est en haut ou en bas de ce tiroir, et peuvent la faire bouger d'un cran au plus.

## Les règles

1. **Le verdict fixe le tiroir de départ.**

   | Verdict | Tiroir de départ |
   |---|---|
   | Fonce | A, Génial |
   | Ça vaut le coup | B, Sympa |
   | Bof, il y a mieux | C, Mitigé |
   | Franchement, évite | D, Pas pour moi |

2. **Les autres réponses donnent des points.**
   - La meilleure réponse vaut +1 sur les axes qui peuvent émerveiller : journées, cadre, repas, soirées, accueil.
   - La pire réponse vaut −1 sur tous les axes, budget et déplacements compris.
   - Les réponses du milieu et « Pas concerné » valent 0.
   - Le coup de cœur vaut +1.

   Le budget et les déplacements peuvent gâcher un voyage, mais ils le rendent rarement magique. C'est pour ça que leur meilleure réponse ne rapporte rien.

3. **Le bilan fait bouger d'un cran au plus.** À +2 ou plus, on monte d'un cran. À −2 ou moins, on descend d'un cran. Entre les deux, on reste dans le tiroir de départ.

4. **S demande une clé.** On ne passe de A à S qu'avec le coup de cœur ou la réponse « Demain, sans hésiter » à la question du retour. Sans clé, on reste en A, même avec un très bon bilan. Comme le nombre de coups de cœur est limité, S reste rare.

5. **Ne pas se sentir en sécurité plafonne à B.** Cette réponse compte déjà comme un −1, et en plus aucune destination ne peut dépasser B avec elle.

6. **La personne garde le dernier mot.** Sous le tier, deux flèches permettent de monter ou de descendre d'un cran. Ce choix est enregistré et passe avant la formule, y compris si la formule change plus tard.

7. **L'ordre à l'intérieur d'un tiroir** suit le bilan, puis la présence d'une clé, puis la date d'ajout.

## Cas de contrôle

| Réponses | Départ | Bilan | Résultat |
|---|---|---|---|
| Fonce, tout au milieu | A | 0 | A |
| Fonce, repas un régal, cadre superbe, pas de clé | A | +2 | A, S verrouillé |
| Fonce, repas un régal, coup de cœur | A | +2 | S |
| Fonce, soirées pénibles, repas un régal, cadre superbe | A | +1 | A |
| Fonce, trop cher, déplacements une vraie galère | A | −2 | B |
| Fonce, tout au top, coup de cœur, pas en sécurité | A | +4 | B, plafond sécurité |
| Ça vaut le coup, repas un régal, cadre superbe | B | +2 | A |
| Ça vaut le coup, trop cher, une vraie galère | B | −2 | C |
| Bof, tout au top | C | +5 | B, un cran au plus |
| Bof, journées ennuyeuses, cadre pas joli | C | −2 | D |
| Franchement évite, repas un régal, cadre superbe | D | +2 | C |
| Deux axes en « Pas concerné », le reste au milieu | selon verdict | 0 | aucun effet |

Le seul cas qui peut surprendre est « Fonce, mais trop cher et galère » qui descend en B. La phrase d'explication du résultat et la correction manuelle couvrent ce cas.

## Les questions

L'ordre va du plus plaisant au plus pratique, et le verdict vient à la fin pour limiter l'effet de halo.

| # | Thème | Question | Réponses, du meilleur au pire | Points |
|---|---|---|---|---|
| 1 | 🗺️ Journées | Ce que tu as fait sur place, c'était comment ? | Des moments forts · Agréable · Un peu long par moments · Ennuyeux | +1 / 0 / 0 / −1 |
| 2 | 📸 Cadre | Et le cadre, tu l'as trouvé comment ? | Superbe · De beaux coins · Sans plus · Pas joli | +1 / 0 / 0 / −1 |
| 3 | 🍽️ Repas | Côté repas, c'était comment ? | Un régal · Bon, quelques belles adresses · Correct, sans plus · Décevant | +1 / 0 / 0 / −1 |
| 4 | 🌙 Soirées | Et les soirées, ça donnait quoi ? | De super soirées · Sympas · Rien de spécial · Pénibles | +1 / 0 / 0 / −1 |
| 5 | 🫶 Accueil | Et l'accueil, l'ambiance ? | Des gens adorables · Rien à signaler · Des gens plutôt froids · Je ne me sentais pas en sécurité | +1 / 0 / 0 / −1 et plafond B |
| 6 | 🧩 Déplacements | Pour te déplacer, simple ou galère ? | Simple · Il fallait s'adapter · Une vraie galère | 0 / 0 / −1 |
| 7 | 💸 Budget | Et le budget sur place ? | Une bonne affaire · Dans les prix attendus · Un peu cher · Trop cher, ça a gâché des moments | 0 / 0 / 0 / −1 |
| 8 | 🔁 Verdict | Un ami hésite à y aller. Tu lui dis quoi ? | Fonce · Ça vaut le coup · Bof, il y a mieux · Franchement, évite | fixe le tiroir |
| 9 | ✈️ Retour | Et toi, tu y retournerais ? | Demain, sans hésiter · Un jour, oui · Une fois, ça suffit | clé pour S / 0 / 0 |

Chaque question des axes 1 à 7 propose aussi « Pas concerné », sans limite et sans effet sur la note.

Les déplacements passent à trois réponses. « Très simple » et « Simple » ne décrivaient pas deux situations différentes, et la meilleure réponse ne rapporte de toute façon rien.

« Une fois, ça suffit » ne fait pas baisser la note. On peut avoir adoré un endroit qu'on ne referait pas, comme un trek ou un voyage de noces.

## Le dernier écran

Les tags, la phrase et les marqueurs tiennent sur un seul écran, juste avant la révélation du tier. Année, durée, budget perso et compagnie se complètent plus tard depuis la fiche.

- **Tags**, au plus 3 (voir plus bas).
- **Ce que tu retiens**, champ libre facultatif de 80 caractères, avec un exemple en placeholder : « Le marché du dimanche matin ».
- **Marqueurs** : ❤️ Coup de cœur · 🏠 J'y ai vécu · 🔥 Plusieurs visites · 🚗 Road trip (pour les zones seulement).

« A vécu là-bas » devient « J'y ai vécu », parce que l'app tutoie et parle à la première personne partout ailleurs. « Revisité » devient « Plusieurs visites », qui se lit mieux et évite tout accord.

## Les tags

Les tags décrivent, ils ne notent pas : aucun n'a d'effet sur le tier. Le maximum passe de 5 à 3 pour qu'on choisisse vraiment.

| Famille | Tags |
|---|---|
| Ce que tu as ressenti | 😮 Belle surprise · 📉 Surcoté · 🌏 Dépaysant · 🧘 Ressourçant · 😮‍💨 Épuisant |
| Le genre de lieu | 🚶 Ville à flâner · 🏛️ Patrimoine · ⛰️ Grands espaces · 🏖️ Plage |
| À savoir | 👥 Trop de monde · 🌧️ Pas de chance avec la météo · 🎯 Pas pour tout le monde |

Belle surprise et Surcoté s'excluent : choisir l'un désactive l'autre.

Tags retirés de la liste actuelle, et pourquoi :

| Tag actuel | Raison |
|---|---|
| Food trip, Nightlife | Déjà couverts par les questions repas et soirées |
| Pas cher, Trop cher | Déjà couverts par la question budget |
| Transports galère | Déjà couvert par la question déplacements |
| Craignos | Remplacé par « Je ne me sentais pas en sécurité » dans l'accueil, qui a un vrai effet |
| Ambiance locale, Facile à vivre | Déjà couverts par l'accueil et les déplacements |
| Beau partout | Déjà couvert par la question cadre |
| Trop touristique, Pièges à touristes | Fusionnés dans « Trop de monde » |

« Pas de chance avec la météo » est volontairement plus long que « Météo pourrie » : la météo ne dit rien du lieu, et la formule rappelle que c'était de la malchance.

Les anciens tags restent affichés sur les destinations déjà enregistrées. Ils ne sont simplement plus proposés à la saisie.

## Les tiers

| Tier | Libellé | Changement |
|---|---|---|
| S | Pépite | inchangé |
| A | Génial | inchangé |
| B | Sympa | inchangé |
| C | Mitigé | remplace « Bof », qui est maintenant une réponse au verdict |
| D | Pas pour moi | remplace « À éviter » : c'est un avis personnel, pas un conseil aux autres |

## Ce qui disparaît de la formule actuelle

Le multiplicateur 1,1, le facteur de confiance, le plafond du point faible, le plafond « double galère », les bonus et malus de tags, les planchers spéciaux, la limite de deux passes, le champ `intent` et l'ancienne `memorability`.

## Version anglaise

Même ton que le français : familier, chaleureux, phrases courtes. Les crans sont les mêmes, et aucun libellé n'est utilisé deux fois, pour que chaque réponse reste reconnaissable d'un écran à l'autre.

| # | Thème | Question | Réponses, du meilleur au pire |
|---|---|---|---|
| 1 | 🗺️ Days | How were your days there? | Some standout moments · Pleasant · Dragged a bit at times · Boring |
| 2 | 📸 Setting | And the setting? | Gorgeous · Some lovely spots · It was fine · Not much to look at |
| 3 | 🍽️ Food | How was the food? | A real treat · Good, a few solid spots · Decent, nothing more · Disappointing |
| 4 | 🌙 Evenings | What were the evenings like? | Loved the evenings · Good · Nothing special · Pretty rough |
| 5 | 🫶 People | And the people, the vibe? | Lovely people · Nothing stood out · People were a bit cold · I didn't feel safe |
| 6 | 🧩 Getting around | Getting around: easy or a hassle? | Easy · Took some adjusting · A total hassle |
| 7 | 💸 Budget | How was it on the wallet? | A great deal · About what I expected · A bit pricey · Too expensive, it spoiled things |
| 8 | 🔁 Verdict | A friend's on the fence about going. What do you tell them? | Go for it · Worth it · Meh, there's better · Honestly, skip it |
| 9 | ✈️ Going back | Would you go back? | Tomorrow, no question · Someday, sure · Once was enough |

Bouton de passe : « Doesn't apply ». Correction manuelle sous le tier : « Not quite right? ».

**Dernier écran**

- Champ libre : « What stuck with you », placeholder « The Sunday morning market ».
- Marqueurs : ❤️ Favorite · 🏠 I lived there · 🔥 Been more than once · 🚗 Road trip.

**Tags**

| Famille | Tags |
|---|---|
| How it felt | 😮 Pleasant surprise · 📉 Overrated · 🌏 A change of scene · 🧘 Recharging · 😮‍💨 Exhausting |
| Kind of place | 🚶 Made for wandering · 🏛️ Lots of history · ⛰️ Wide open spaces · 🏖️ Beach |
| Good to know | 👥 Too crowded · 🌧️ Bad luck with the weather · 🎯 Not for everyone |

**Tiers** : Gem · Great · Nice · Mixed · Not for me.

Choix de traduction à connaître :

- « Bof, il y a mieux » devient « Meh, there's better ». « Meh » a exactement la même valeur que « Bof » à l'oral.
- « Pas joli » devient « Not much to look at ». La traduction littérale, « Not pretty », sonne plus dur en anglais qu'en français.
- « Rien à signaler » devient « Nothing stood out ». « No complaints » se lirait comme un compliment.
- « Dépaysant » n'a pas d'équivalent direct. « A change of scene » garde l'idée sans en faire trop.
- « Real » et « great » ne reviennent qu'une fois chacun dans les réponses. Répétés partout, ils donnaient un ton de texte généré.
- La réponse « Good » des soirées évite « Nice », réservé au tier B.

## Données existantes

Décision du 21 octobre 2026 : pas de conversion. Au déploiement de la v2, on efface les notes de toutes les destinations et on garde les destinations sur la carte. Chacun renote ensuite avec le nouveau parcours.

**Ce qui est effacé** : les réponses (`food`, `night`, `culture`, `nature`, `value`, `ease`, `memorability`, `vibe_boost`, `retour_bonus`), le score, le tier, `standout` et `standout_tags`, et les tags de `trip_types`.

**Ce qui est gardé** : le lieu et sa géométrie, l'image, les étapes de road trip, le marqueur road trip dans `trip_types`, le coup de cœur, « J'y ai vécu », le nombre de visites, l'année, la durée, le budget perso et la compagnie.

**Points d'attention**

- **Le fil d'activité.** Le trigger `trg_activity_destination` crée un événement `tier_changed` à chaque changement de tier. Sans précaution, la remise à zéro publierait un événement par destination dans le fil de tous les amis. Il faut désactiver le trigger le temps de l'opération.
- **Les valeurs par défaut.** Le schéma initial met `default 3` sur `food`, `night`, `culture`, `nature` et `value`. Il faut écrire `null` explicitement, sinon une ligne recréée reprendrait un 3 qui n'a jamais été répondu.
- **La note du peuple** se vide d'elle-même, puisqu'elle ne compte que les lignes qui ont un score.
- **Le front v2** doit traiter une destination sans tier comme « à noter », et la mettre en avant pour inviter à la renoter.

**Procédure au déploiement**

1. Sauvegarder la table `destinations`, avec un export depuis le tableau de bord Supabase ou un `pg_dump` de la table.
2. Appliquer la migration `023_notation_v2.sql`. Elle doit passer avant le front, qui lit les nouvelles colonnes `return_intent`, `memory_note` et `tier_adjust`.
3. Déployer le front v2.
4. Exécuter le script ci-dessous dans une seule transaction.
5. Vérifier que le nombre de lignes est inchangé et qu'aucune ligne n'a encore de tier.

```sql
begin;

alter table destinations disable trigger trg_activity_destination;

update destinations
set food = null, night = null, culture = null, nature = null, value = null,
    ease = null, memorability = null, vibe_boost = null, retour_bonus = null,
    return_intent = null, memory_note = null, tier_adjust = null,
    score = null, tier = null,
    standout = null, standout_tags = null,
    trip_types = case
      -- l'ancien libellé « 🚗 Road trip » existe encore sur certaines lignes
      when exists (select 1 from unnest(trip_types) as tag where tag ilike '%road%') then array['roadtrip']
      else null
    end;

alter table destinations enable trigger trg_activity_destination;

-- Contrôle : doit renvoyer 0
select count(*) from destinations where tier is not null or score is not null;

commit;
```

Ce script n'est volontairement pas rangé dans `supabase/migrations`, pour qu'il ne puisse pas partir avec une migration ordinaire avant le front v2.

## État de la prod (21 octobre 2026)

- Seule la partie 1 de la migration 023 (les trois colonnes) est appliquée, sous le nom `notation_v2_columns`.
- Les migrations 021 (note du peuple) et 022 (restriction des colonnes de `get_public_destinations`) n'ont jamais été appliquées. La note du peuple n'existe donc pas en base, et la fonction des amis renvoie encore toutes les colonnes, nouvelles comprises.
- Pour aligner la base sur le dépôt : appliquer 021, puis 022, puis la 023 complète. Les parties 2 et 3 de la 023 ne passent qu'après 021 et 022.
- Sauvegarde d'avant la remise à zéro : `backups.destinations_20261021_pre_notation_v2`.
