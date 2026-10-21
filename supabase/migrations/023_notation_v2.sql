-- Migration 023 : notation v2 (modèle des tiroirs, cf. docs/notation-v2.md).
--
-- 1. Trois nouvelles colonnes, toutes facultatives :
--    - return_intent : « Et toi, tu y retournerais ? » (tomorrow / someday / once)
--    - memory_note   : « Ce que tu retiens », 80 caractères côté client
--    - tier_adjust   : correction manuelle d'un cran (-1, 0, 1)
-- 2. get_public_destinations expose ces colonnes : les vues amis recalculent
--    le tier côté client et ont besoin de tier_adjust pour afficher le même.
-- 3. La note du peuple reprend les seuils de scoreToTier (src/utils.ts) :
--    S >= 4.5, A >= 4.0, B >= 3.2, C >= 2.4, sinon D.
--
-- Cette migration doit être appliquée AVANT le déploiement du front v2, qui
-- sélectionne ces colonnes.

alter table destinations
  add column if not exists return_intent text
    check (return_intent is null or return_intent in ('tomorrow', 'someday', 'once')),
  add column if not exists memory_note text
    check (memory_note is null or char_length(memory_note) <= 120),
  add column if not exists tier_adjust smallint
    check (tier_adjust is null or tier_adjust between -1 and 1);

-- Le type de retour change : drop puis create (cf. migration 022).
drop function if exists get_public_destinations(uuid);

create function get_public_destinations(target_user_id uuid)
returns table (
  destination_key text,
  name text,
  country text,
  lat double precision,
  lng double precision,
  tier text,
  kind text,
  intent text,
  food numeric,
  night numeric,
  culture numeric,
  nature numeric,
  value numeric,
  ease numeric,
  score numeric,
  stops jsonb,
  extent double precision[],
  geojson jsonb,
  osm_id bigint,
  osm_type text,
  country_code text,
  image text,
  image_provider text,
  summary text,
  trip_name text,
  visit_count int,
  trip_year int,
  trip_days int,
  companions text,
  personal_budget numeric,
  trip_types text[],
  standout text,
  standout_tags text[],
  coup_de_coeur boolean,
  lived_there boolean,
  vibe_boost smallint,
  retour_bonus real,
  return_intent text,
  memory_note text,
  tier_adjust smallint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    d.destination_key,
    d.name,
    d.country,
    d.lat,
    d.lng,
    d.tier,
    d.kind,
    d.intent,
    d.food,
    d.night,
    d.culture,
    d.nature,
    d.value,
    d.ease,
    d.score,
    d.stops,
    d.extent,
    d.geojson,
    d.osm_id,
    d.osm_type,
    d.country_code,
    d.image,
    d.image_provider,
    d.summary,
    d.trip_name,
    d.visit_count,
    d.trip_year,
    d.trip_days,
    d.companions,
    d.personal_budget,
    d.trip_types,
    d.standout,
    d.standout_tags,
    d.coup_de_coeur,
    d.lived_there,
    d.vibe_boost,
    d.retour_bonus,
    d.return_intent,
    d.memory_note,
    d.tier_adjust
  from destinations d
  join get_map_access_context(target_user_id) ctx on ctx.allowed
  where d.user_id = target_user_id
  limit 200;
$$;

grant execute on function get_public_destinations(uuid) to anon, authenticated;

create or replace function get_community_ratings(keys text[])
returns table (
  key text,
  avg_score numeric,
  tier text,
  rating_count integer,
  top_tags text[]
)
language sql
stable
security definer
set search_path = public
as $$
  with eligible as (
    select e.key, e.user_id, e.score, e.standout_tags
    from community_eligible_destinations() e
    where e.key = any(keys)
  ),
  -- 1 vote par utilisateur par destination (les revisites/doublons font une moyenne)
  per_user as (
    select key, user_id, avg(score) as score
    from eligible
    group by key, user_id
  ),
  agg as (
    select key, round(avg(score)::numeric, 1) as avg_score, count(*)::int as n
    from per_user
    group by key
    having count(*) >= 3
  ),
  tag_freq as (
    select e.key, tag, count(distinct e.user_id) as users
    from eligible e
    cross join lateral unnest(e.standout_tags) as tag
    group by e.key, tag
  ),
  -- un tag ne remonte que s'il est cité par >= 25 % des votants (minimum 2)
  top_tags as (
    select tf.key, (array_agg(tf.tag order by tf.users desc, tf.tag))[1:3] as tags
    from tag_freq tf
    join agg on agg.key = tf.key
    where tf.users >= greatest(2, ceil(agg.n * 0.25))
    group by tf.key
  )
  select
    agg.key,
    agg.avg_score,
    case
      when agg.avg_score >= 4.5 then 'S'
      when agg.avg_score >= 4.0 then 'A'
      when agg.avg_score >= 3.2 then 'B'
      when agg.avg_score >= 2.4 then 'C'
      else 'D'
    end as tier,
    agg.n as rating_count,
    coalesce(tt.tags, '{}'::text[]) as top_tags
  from agg
  left join top_tags tt on tt.key = agg.key
$$;

grant execute on function get_community_ratings(text[]) to authenticated;

create or replace function get_community_leaderboard(
  search text default null,
  max_rows int default 100,
  offset_rows int default 0
)
returns table (
  key text,
  display_name text,
  display_country text,
  country_code text,
  avg_score numeric,
  tier text,
  rating_count integer,
  top_tags text[]
)
language sql
stable
security definer
set search_path = public
as $$
  with eligible as (
    select * from community_eligible_destinations()
  ),
  per_user as (
    select key, user_id, avg(score) as score
    from eligible
    group by key, user_id
  ),
  agg as (
    select key, round(avg(score)::numeric, 1) as avg_score, count(*)::int as n
    from per_user
    group by key
    having count(*) >= 3
  ),
  display as (
    select
      e.key,
      mode() within group (order by e.name) as display_name,
      mode() within group (order by e.country) as display_country,
      mode() within group (order by e.country_code) as country_code
    from eligible e
    join agg on agg.key = e.key
    group by e.key
  ),
  tag_freq as (
    select e.key, tag, count(distinct e.user_id) as users
    from eligible e
    join agg on agg.key = e.key
    cross join lateral unnest(e.standout_tags) as tag
    group by e.key, tag
  ),
  top_tags as (
    select tf.key, (array_agg(tf.tag order by tf.users desc, tf.tag))[1:3] as tags
    from tag_freq tf
    join agg on agg.key = tf.key
    where tf.users >= greatest(2, ceil(agg.n * 0.25))
    group by tf.key
  )
  select
    agg.key,
    display.display_name,
    display.display_country,
    display.country_code,
    agg.avg_score,
    case
      when agg.avg_score >= 4.5 then 'S'
      when agg.avg_score >= 4.0 then 'A'
      when agg.avg_score >= 3.2 then 'B'
      when agg.avg_score >= 2.4 then 'C'
      else 'D'
    end as tier,
    agg.n as rating_count,
    coalesce(tt.tags, '{}'::text[]) as top_tags
  from agg
  join display on display.key = agg.key
  left join top_tags tt on tt.key = agg.key
  where search is null
     or trim(search) = ''
     or split_part(agg.key, '|', 1) like
        '%' || lower(regexp_replace(immutable_unaccent(trim(search)), '\s+', ' ', 'g')) || '%'
  order by agg.avg_score desc, agg.n desc, agg.key
  limit least(greatest(coalesce(max_rows, 100), 1), 200)
  offset greatest(coalesce(offset_rows, 0), 0)
$$;

grant execute on function get_community_leaderboard(text, int, int) to authenticated;
