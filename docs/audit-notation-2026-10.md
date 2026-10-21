# Audit du système de notation des destinations

*Outpost, 21 octobre 2026. Audit du code en l'état sur `main` (commit cf4e08a), sans données d'usage.*

L'objectif affiché d'Outpost : permettre de retranscrire un ressenti de voyage de façon plus personnelle et nuancée qu'une note sur 10, sans IA. Cet audit vérifie si le parcours de notation et la formule qui le traduit en tier atteignent cet objectif.

Fichiers examinés : `src/components/AddDestinationWizard.tsx` (questions, étapes, écran de résultat), `src/utils.ts` (formule `getDestinationScore`, profil voyageur), `src/lib/experienceTags.ts`, `src/components/DestinationSheet.tsx` (restitution), `supabase/migrations/021_community_ratings.sql` (note du peuple), `scripts/recalculate-destination-scores.mjs`.

---

## 1. Diagnostic en bref

**Ce qui fonctionne**

- Les questions sont écrites en langage parlé, avec des réponses sous forme de phrases plutôt que d'étoiles. C'est le bon parti pris et c'est ce qui différencie Outpost.
- La question finale (« Au final, tu le recommanderais ? ») et la question de ressenti (« Sur place, tu te sentais comment ? ») sont les deux seules à capter du vécu. Elles ressortent depuis peu en pastilles dans la fiche, et ce sont les éléments les plus personnels de toute la restitution.
- Le verdict arrive après les critères, ce qui limite l'effet de halo.
- Le mode édition conserve les réponses, et le tier S/A/B/C/D avec ses libellés (Pépite, Génial, Sympa, Bof, À éviter) est lisible et partageable.
- Le coup de cœur à quota (2, puis +1 tous les 6) est un vrai mécanisme de rareté, bien pensé.

**Ce qui ne fonctionne pas**

1. **Les tags n'ont aucun effet sur le score, alors que le code et l'interface laissent croire le contraire.** Le sélecteur « Ambiance du voyage » écrit dans `tripTypes` (des identifiants comme `surprise`, `craignos`). La formule lit `standoutTags` et cherche des libellés texte (« belle surprise », « craignos »). Le wizard actuel ne remplit jamais `standoutTags`. Tout le bloc bonus/malus (Craignos −0,45, Belle surprise +0,15, plafond 4,49, plancher 2,4, famille « tourisme négatif ») est du code mort pour toute destination créée depuis la refonte des tags (commit 4a6f747). Seules les destinations de démonstration de `App.tsx` et d'éventuelles données anciennes l'activent encore.
2. **L'échelle de réponses n'a pas de milieu.** Les six axes proposent 5 / 4 / 2 / 1. « Correct » vaut 2, c'est-à-dire en dessous du neutre (3) que la formule attribue à une question sautée. Dire « correct » partout et « oui, sans hésiter » à la recommandation donne un C (« Bof »).
3. **Une seule réponse basse plafonne le résultat à B**, quelles que soient les autres réponses, le ressenti et la recommandation. Un village où « le soir, c'est mort » mais où tout le reste est parfait ne dépassera jamais « Sympa ».
4. **Au sommet, le ressenti et la recommandation ne comptent plus.** Avec des 5 partout, le score brut dépasse 5 avant écrêtage, si bien que « craignos, je n'étais pas serein(e) » ou « non, je ne le recommanderais pas » donnent quand même S.
5. **Sauter une question rapporte plus que répondre honnêtement.** Tout à 4 avec « bouffe correcte » : A. Avec « bouffe sautée » : S. Avec « bouffe décevante » : B. La limite de 2 passes est un pansement sur cette incitation.
6. **La restitution renomme les réponses.** On demande « Le décor, il valait le détour ? », la fiche affiche « Nature & Paysages 2,0 ». On demande « tu avais de quoi faire ? », la fiche affiche « Culture & Histoire ». L'utilisateur n'a jamais tapé un chiffre, il voit pourtant des décimales qui traduisent mal sa phrase.
7. **Les seuils de tier ne sont pas les mêmes côté personnel et côté communauté.** TypeScript : S ≥ 4,5, A ≥ 4,0, B ≥ 3,2, C ≥ 2,4. SQL (`get_community_ratings`) : S ≥ 4,3, A ≥ 3,7, B ≥ 3,0, C ≥ 2,2, avec un commentaire qui affirme le contraire. Une même moyenne peut être A pour soi et S pour « le peuple ».

Les chiffres ci-dessous viennent d'une simulation de la formule exacte (sans tags, puisqu'ils sont inopérants).

| Réponses | Score | Tier |
|---|---|---|
| Tout « correct » (2), déplacements difficiles, bonne vibe, « reco pour un séjour précis » | 2,20 | D « À éviter » |
| Tout « correct » (2), déplacements faciles, bonne vibe, « oui sans hésiter » | 2,73 | C « Bof » |
| Tout « très bon » (4), bonne vibe, « oui sans hésiter » | 4,56 | S « Pépite » |
| Tout « très bon » (4), bonne vibe, « non, pas recommandé » | 3,96 | B |
| Tout 5 sauf soirées = 1, ressenti 5, reco oui | 3,20 | B |
| Tout 5, soirées sautées, ressenti 5, reco oui | 5,00 | S |
| Tout 5, ressenti « craignos » (2), reco oui | 5,00 | S |
| Tout 5, ressenti 5, reco « non » | 5,00 | S |

Sur les 1 024 combinaisons où l'utilisateur ne répond que 4 ou 5 aux six axes, 75 % finissent en S et 22 % en A. Pour une personne globalement contente de ses voyages, presque tout devient « Pépite », et le tier n'ordonne plus rien. À l'inverse, une personne qui choisit « correct » quand c'était correct voit son carnet s'entasser en C et D.

---

## 2. Pertinence des questions

**Le questionnaire décrit une ville-destination type city break.** Bouffe, soirées, visites, décor, budget, déplacements : c'est la grille d'un week-end urbain. Elle convient mal à un trek, une île, une station de ski, un séjour famille, un voyage pro, un pays entier saisi en « zone », ou un endroit où l'on a vécu. Dans ces cas, deux ou trois questions sont hors sujet et il n'y a que deux passes.

**Deux questions mesurent de l'offre, pas du ressenti.** « Tu avais de quoi faire ? » et « ça vivait comment le soir ? » mesurent la quantité d'activités et de vie nocturne du lieu. Un voyageur qui cherchait le calme répondra « plutôt calme » (2) en étant ravi. La question lui fait noter une caractéristique du lieu comme si c'était un défaut.

**Le ressenti (`vibeBoost`) mélange quatre choses** : accueil, confort, sécurité ressentie, ambiance. Quelqu'un peut s'être senti en sécurité mais mal accueilli. Et sa réponse la plus basse (« craignos ») n'a presque aucun effet sur le score (−0,18 au plus), alors que le tag « Craignos », lui, était prévu pour −0,45 avant de devenir inopérant. Le signal le plus grave du questionnaire est le moins pris en compte.

**Ce qui manque**

- Un moment. Rien ne permet de dire « le truc que je retiens ». Aucun champ texte, même court, n'existe. C'est pourtant le seul contenu qui serait vraiment personnel, et celui que des amis liraient.
- L'envie d'y retourner (future), distincte de « je recommanderais » (aux autres) et de « Revisité » (passé). « J'y retournerais demain / un jour peut-être / une fois suffit » est le signal personnel le plus discriminant pour départager deux A.
- L'écart entre attente et réalité. « Belle surprise » et « Surcoté » existent en tags mais sont noyés dans 17 chips et ne pèsent rien.
- Le dépaysement, le « ça m'a marqué » (la `memorability` historique a été retirée du calcul).

**Ce qui est redondant**

- Cinq tags sur 17 reposent une question déjà posée : « Pas cher » et « Trop cher » (question budget), « Transports galère » (question déplacements), « Craignos » (question ressenti), « Nightlife » (question soirées). « Facile à vivre » recoupe déplacements et ressenti.
- Le champ `intent` est calculé depuis les tags, ignoré par la formule (`void intent`), et le cas `nature` ne peut jamais se produire (aucun tag n'a cet identifiant).
- L'étape « Derniers détails » demande année, durée avec unité, budget perso, compagnie, plus trois ou quatre bascules. Ces données alimentent le profil voyageur et deux lignes de métadonnées, pas l'évaluation.

---

## 3. Biais et problèmes structurels

**Biais d'échelle.** L'absence de 3 force à choisir entre « vraiment bien » et « pas terrible ». La réponse « correct » est numériquement une mauvaise réponse. Le mot « Correct » apparaît dans trois questions avec des valeurs différentes : 2 pour la bouffe et le décor, 4 pour le budget (« Correct, les prix semblaient honnêtes »). L'utilisateur ne peut pas deviner qu'un même mot vaut tantôt un malus, tantôt un bonus.

**Biais de compensation inversé.** La formule amplifie l'écart à 3 par 1,1 puis plafonne à 5. Elle est additive au milieu et écrêtée aux extrêmes, donc le ressenti et le verdict comptent dans la zone B/A et disparaissent en S et en D. C'est l'inverse de ce que le message de commit « prioritize final feeling over criteria average » annonçait.

**Biais de plafonnement par le point faible.** Le `weakSpotCap` traite tout 1 comme rédhibitoire. Sur six axes dont deux mesurent de l'offre, c'est un biais systématique contre les destinations calmes, rurales, ou sans scène gastronomique.

**Biais de passe.** Sauter améliore le score. La limite de deux passes rend l'arbitrage visible (« Il te reste 1 passe sur 2 ») et transforme une question d'applicabilité en gestion de budget.

**Biais de restitution.** Les libellés de la fiche (« Culture & Histoire », « Nature & Paysages ») ne sont pas ceux des questions. La comparaison entre amis compare donc des nombres qui ne décrivent pas la même chose selon la lecture que chacun a faite de la question.

**Score absolu, échelle personnelle.** Deux utilisateurs qui ressentent la même chose mais n'ont pas le même rapport aux mots (« très bon » vs « correct ») obtiennent des tiers différents. Rien ne recalibre un utilisateur par rapport à lui-même. La « note du peuple » agrège ensuite ces scores comme s'ils étaient comparables.

**Formule mouvante, verdict silencieusement réécrit.** Le script de recalcul réécrit `score` et `tier` en base. Un utilisateur peut découvrir que sa « Pépite » est devenue « Génial » sans avoir rien changé. La formule n'est pas versionnée sur la ligne.

---

## 4. Effort demandé et valeur obtenue

**Effort par destination (ajout, sans passe)** : recherche, 8 questions avec intro et 4 réponses d'une dizaine de mots chacune (environ 550 mots à lire), une grille de 17 chips avec maximum 5, un écran de 4 champs et 3 à 4 bascules, un écran de résultat, une confirmation. Entre 15 et 20 interactions et 2 à 4 minutes pour quelqu'un qui lit. Pour une personne qui saisit son historique de 20 voyages au départ, une heure.

**Valeur restituée** : un tier, un score à une décimale, six barres relabellisées, deux pastilles (ressenti, reco), des chips neutres. Pas une phrase personnelle. Le texte sous le tier est générique (« Un endroit que tu n'oublieras pas »), identique pour toutes les Pépites.

**Collecté mais inutilisé ou invisible** : `intent`, `standout`, `memorability`, les tags pour le score, le budget perso (sauf une ligne « ~90 EUR/jour »). Le rapport effort/valeur est défavorable : environ 60 % des interactions n'améliorent ni le verdict ni ce que la fiche raconte.

---

## 5. Expérience utilisateur

Ce qui fait questionnaire : la série linéaire de 8 écrans identiques (icône, titre, intro, 4 cartes, lien de passe, compteur « 3 / 8 », rappel des passes), les réponses longues qu'il faut lire en entier pour choisir, l'écran « Derniers détails » qui ressemble à un formulaire administratif, et le `window.confirm` natif à la fermeture (le protocole de test F3 bannit pourtant ces popups ailleurs).

Ce qui fait jeu : le badge de tier qui apparaît avec son éclat, le quota de coups de cœur, le classement S à D.

Le moment de plaisir attendu, c'est la révélation du tier. Il arrive après le formulaire de détails, qui casse le rythme. Et il révèle un résultat que l'utilisateur ne peut pas discuter : si le tier le surprend, il n'a que « Refaire la notation ».

Pistes sans complexifier :

- Répondre au verdict d'abord, en une question, puis « qu'est-ce qui a fait ça ? » avec les axes en chips à cocher (et une intensité seulement sur ceux cochés). Trois écrans au lieu de dix.
- Des réponses de 3 à 5 mots (« Incroyable », « Très bon », « Correct », « Décevant ») avec le détail en sous-titre discret.
- Déplacer année, durée, budget et compagnie après l'enregistrement, en « compléter plus tard » depuis la fiche.
- Révéler le tier tout de suite après le verdict et les axes, puis proposer de le placer par rapport à deux voisins (« Au-dessus ou en dessous de Porto ? »). C'est le geste de tier list que l'app promet et ne donne jamais.

---

## 6. Qualité du résultat

Deux destinations notées A avec les mêmes réponses ne se distinguent en rien, sauf par leurs tags. Deux Pépites non plus : avec 41 valeurs de score distinctes possibles et une compression au sommet, l'ordre intra-tier (tri par score décimal) est en grande partie du bruit. Un utilisateur positif aura dix S ordonnés par des différences de 0,1 qu'il n'a jamais exprimées.

L'évaluation ne raconte rien parce qu'elle n'en a pas les matériaux : pas de phrase, pas de moment, pas d'intention de retour, pas d'écart attente/réalité. Les réponses choisies, qui sont des phrases, sont converties en nombres puis réaffichées comme nombres. On perd exactement ce qui faisait la nuance.

Ce qu'une fiche pourrait dire sans IA, par simple assemblage déterministe des réponses : « Lisbonne, 2024, en couple. Tu t'es régalé, le décor valait le détour, un peu cher. Tu y enverrais n'importe qui, et tu y retournerais demain. » Chaque segment vient d'une réponse ; le gabarit est une concaténation. Ça tient dans 50 lignes de code et change la perception du résultat.

---

## 7. Benchmark

| Produit | Mécanisme | Ce qu'on en reprend |
|---|---|---|
| **Letterboxd** (films) | Note ½ étoile à 5 **et** un cœur « like » indépendant, revisionnage, date, texte libre, 4 favoris sur le profil | Découpler « c'était bien » de « je l'ai aimé ». Le cœur existe déjà (coup de cœur) ; il manque le texte libre et la mise en avant des favoris. |
| **Beli** (restaurants) | Après la visite, trois cases (J'ai adoré / C'était bien / Pas aimé), puis 2 ou 3 comparaisons par paires avec des lieux déjà notés ; le score 0 à 10 est dérivé du classement personnel | La seule approche sans dérive d'échelle : l'utilisateur se compare à lui-même. Transposable tel quel à la tier list d'Outpost pour l'ordre intra-tier. |
| **Netflix** | Abandon des 5 étoiles pour pouce bas / haut / double haut, après constat que les étoiles mesuraient la « qualité » et non le plaisir | Poser des questions de plaisir et de comportement (« tu y retournerais ? ») plutôt que de qualité d'offre (« il y avait de quoi faire ? »). |
| **Steam** | Recommander oui/non + texte + contexte (heures de jeu) ; les avis sont lus pour le texte, le binaire sert à agréger | Le verdict binaire comme pivot ; le reste comme explication. La « note du peuple » marcherait mieux sur un taux de recommandation que sur une moyenne de scores formulés. |
| **Airbnb** | Note globale + 6 sous-notes (propreté, exactitude, communication, emplacement, arrivée, qualité-prix) | Contre-exemple : la moyenne de sous-critères produit une inflation (moyenne ≈ 4,7) et n'ordonne plus rien. C'est le défaut actuel d'Outpost au sommet. |
| **Google Maps** | Étoiles, puis chips contextuelles « Qu'avez-vous aimé ? » adaptées au type de lieu | Chips **conditionnelles** au type de destination (ville, nature, île, pays) au lieu d'une grille fixe de 17. |
| **Backloggd / Grouvee** (jeux) | Un statut (terminé, abandonné, maîtrisé, à refaire) porte plus de signal que la note | « Une fois suffit / j'y retournerais / j'y vis » comme statut de relation à la destination. |
| **Strava** | « Comment c'était ? » effort perçu en un curseur, optionnel, après l'activité | Une question de ressenti unique, immédiate, optionnelle. |
| **Foursquare** | Note calculée depuis des signaux (likes, sauvegardes, retours) plutôt que demandée | Le compteur de visites et le coup de cœur sont des signaux de ce type ; les utiliser dans l'ordre plutôt que de demander plus. |
| **Spotify Wrapped** | Narration générée depuis des faits chiffrés | Déjà l'esprit du profil voyageur ; à descendre au niveau de chaque fiche (la phrase d'assemblage). |
| **TierMaker** | Placement manuel par glisser-déposer | L'app s'appelle tier list et ne laisse jamais placer. Le placement, même limité à « au-dessus / en dessous de X », est le geste ludique manquant. |
| **Kahneman, règle du pic et de la fin** | Le souvenir d'une expérience est dominé par son pic et sa fin, pas par la moyenne | Demander le meilleur moment (et éventuellement le pire) plutôt que six moyennes. C'est ce qui rend une évaluation mémorable et personnelle. |

---

## 8. Angles morts

- **Saisie de l'historique.** Le cas d'usage principal au premier jour est de rentrer 10 à 30 voyages passés. Huit questions à chaque fois, sur des souvenirs de 2012, produit des réponses « correct » par défaut, donc des C.
- **Même destination, plusieurs voyages.** Une seule note par destination, un compteur de visites. Barcelone à 20 ans entre amis et à 35 ans en famille n'ont pas le même tier ; le second écrase le premier.
- **Zones.** Noter « Japon » ou « Italie » avec une question sur les soirées et une sur les déplacements n'a pas de sens ; pourtant la zone est notée comme une ville et entre dans la note du peuple sous la même clé qu'une ville homonyme.
- **Voyages pro, « a vécu là-bas ».** Le budget sur place n'a pas de sens quand l'employeur paie ; vivre deux ans quelque part ne se résume pas en « tu t'es régalé ? ».
- **Dérive dans le temps.** Les premières notes d'un utilisateur sont prises sans référence ; six mois plus tard, son échelle a bougé et rien ne lui permet de réaligner, sauf refaire une à une.
- **Comparaison entre amis.** Les écarts par critère comparent des lectures de la question, pas des expériences. Deux amis au même voyage peuvent différer de 2 points sur « décor » parce que l'un a lu « nature » et l'autre « charme des rues ».
- **Note du peuple.** Seuils différents, scores issus d'une formule plafonnée, zones et villes fusionnées : l'agrégat est fragile dès que le volume monte, et le commentaire SQL qui affirme la cohérence des seuils est faux.
- **Langue.** Les libellés anglais sont plus courts et parfois plus tranchés que les français (« Dead or a pain » vs « Mort ou pénible ») ; la même expérience ne produira pas la même réponse selon la langue.
- **Recalcul.** Toute évolution de formule réécrit des verdicts sans que l'utilisateur le sache. Il faut une version de formule par ligne, ou figer le tier choisi jusqu'à une nouvelle notation.

---

## 9. Recommandations priorisées

### P0, à corriger (incohérences et bugs)

1. **Trancher le sort des tags.** Soit ils pèsent sur le score et le wizard écrit `standoutTags` (ou la formule lit `tripTypes`), soit ils sont descriptifs et on supprime `computeTagBonus`, les plafonds/planchers liés, et le tri par `getTagScoreImpact` dans la fiche. Recommandation : descriptifs seulement. Ça supprime le double comptage avec les questions et 80 lignes de formule.
2. **Donner un milieu à l'échelle.** Réponses 5 / 4 / 3 / 1 (ou 5 / 4 / 3 / 2) sur tous les axes, « correct » = 3, et un seul sens du mot « correct » dans tout le questionnaire. Supprimer le multiplicateur 1,1.
3. **Faire du verdict le pivot.** Le verdict fixe une bande (oui sans hésiter → A ou S ; type précis → B ou A ; pas en priorité → C ou B ; non → D ou C), les axes et le ressenti placent dans la bande. Le ressenti « craignos » doit pouvoir sortir du S, le verdict « non » aussi. Un seul 1 sur un axe d'offre (soirées, activités) ne doit plus plafonner.
4. **Un seul jeu de seuils** entre `scoreToTier` et les fonctions SQL, et un commentaire exact.
5. **Afficher dans la fiche la phrase choisie**, pas un nombre relabellisé. Garder les nombres pour le tri et la comparaison, avec les libellés des questions.
6. **Versionner la formule** (`score_version` sur la ligne) et ne jamais recalculer un tier sans l'annoncer.

### P1, à simplifier (friction)

7. **Passes gratuites et neutres.** « Pas concerné » ne coûte rien et ne vaut ni bonus ni malus. Mieux : une question d'applicabilité avant les axes (« Ce voyage, c'était surtout… ») qui ne pose que les axes pertinents, ou le verdict d'abord puis « qu'est-ce qui a pesé ? » en chips.
8. **Réponses courtes.** Trois à cinq mots en titre, le détail en sous-titre. Supprimer les intros quand le titre suffit.
9. **Tags épurés.** Retirer les cinq tags redondants avec les questions. Garder ceux qui ajoutent une information : Belle surprise, Surcoté, Ville à flâner, Patrimoine marquant, Grands paysages, Plage, Ambiance locale, Pièges à touristes. Les rendre conditionnels au type de lieu si possible.
10. **Repousser les détails.** Année, durée, budget, compagnie : après l'enregistrement, en « compléter » depuis la fiche. Garder dans le wizard seulement les bascules (coup de cœur, vécu, revisité, road trip).
11. **Supprimer** `intent`, `standout`, `memorability` du modèle, ou arrêter de les calculer.

### P2, à ajouter (valeur)

12. **Une phrase.** « Ce que tu retiens » en 80 caractères, optionnel, affiché en tête de fiche et dans la comparaison entre amis. Zéro effet sur le score.
13. **L'envie de retour.** « J'y retournerais demain / un jour / une fois suffit », en pastille et en signal de tri intra-tier.
14. **Le placement.** Après la révélation du tier, une ou deux comparaisons « au-dessus ou en dessous de X ? » avec des voisins du même tier. L'ordre intra-tier devient celui de l'utilisateur, pas celui d'une décimale.
15. **La phrase d'assemblage.** Un résumé déterministe par gabarit sur l'écran de résultat et en fiche, construit depuis les réponses (voir section 6).
16. **Masquer la décimale** dans l'interface courante. Tier + deux faits + la phrase. Le score reste interne.
17. **Mesurer.** Taux d'abandon par écran, passes par question, temps par question, distribution des tiers par utilisateur. Si plus de 50 % des destinations d'un utilisateur sont S, l'échelle est cassée pour lui.

---

## 10. Ce que ça changerait

Avec P0 et P1, le parcours passe d'une dizaine d'écrans à quatre (recherche, verdict, « ce qui a pesé », résultat), le tier redevient cohérent avec ce que l'utilisateur a dit, et les tags cessent de mentir. Avec P2, chaque fiche raconte quelque chose que personne d'autre n'aurait écrit, ce qui était l'objectif de départ.

Le risque principal est la migration : changer l'échelle et la formule déplace tous les tiers existants. Il faut l'accompagner d'une version de formule, d'un message clair, et d'un chemin « reconfirmer mes tiers » en un geste par destination (glisser dans la bonne ligne), ce qui est aussi l'occasion d'introduire le placement manuel.

---

## Annexe : reproduire la simulation

La formule a été rejouée hors application avec les mêmes constantes que `getDestinationScore` (confiance, multiplicateur 1,1, `weakSpotCap`, ressenti × 0,18, recommandation ±0,3, écrêtage 1–5, plafond « double galère » 3,19, bonus coup de cœur 0,22). Les tags ont été laissés vides, conformément à ce que produit le wizard actuel. Sur les 65 536 combinaisons de réponses possibles sans passe, la répartition est S 1,5 %, A 6,6 %, B 35,2 %, C 38,8 %, D 17,9 %, pour 41 valeurs de score distinctes après arrondi.
