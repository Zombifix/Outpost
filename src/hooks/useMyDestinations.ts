import { useCallback, useEffect, useRef, useState } from 'react'
import type { Destination } from '../types'
import { getDestinationImagesForDestinations, type DestinationImageResult } from '../services/imageSearch'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import {
  destinationToRow,
  rowToDestination,
  DESTINATION_SELECT_COLUMNS,
  type DbDestinationRow,
} from '../lib/destinationMapper'
import { withRecalculatedScore } from '../utils'
import { needsZoneGeometryRepair, repairZoneDestinationGeometry } from '../lib/zoneGeometry'
import { FAKE_FRIENDS_MODE, getFakeMyDestinations } from './_fakeFriends'

const STORAGE_KEY = 'outpost-destinations-v2'
const LEGACY_STORAGE_KEY = 'triptier-destinations-v2'
const FAKE_SEED_VERSION_KEY = 'outpost-fake-seed-version'
const FAKE_SEED_VERSION = '3'
const AUTO_IMAGE_FALLBACK = 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=900&q=85'
export const AUTO_IMAGE_VERSION = 7
const DEFAULT_COUP_DE_COEUR_NAMES = new Set(['Kyoto'])
const SUPABASE_PUSH_DEBOUNCE_MS = 400
const MAX_REMOTE_DESTINATIONS = 200

function needsCatalogImage(destination: Destination) {
  return !destination.destinationKey
    || !destination.image
    || destination.imageProvider === 'fallback'
    || destination.imageSearchVersion !== AUTO_IMAGE_VERSION
}

function applyCatalogImage(destination: Destination, imageResult: DestinationImageResult): Destination {
  const imageSearchVersion = imageResult.imageProvider === 'fallback' ? undefined : AUTO_IMAGE_VERSION
  return {
    ...destination,
    destinationKey: imageResult.destinationKey,
    image: imageResult.image,
    imageProvider: imageResult.imageProvider,
    imageAuthor: imageResult.imageAuthor,
    imageSourceUrl: imageResult.imageSourceUrl,
    imageQuery: imageResult.imageQuery,
    imageSearchVersion,
  }
}

function catalogImageChanged(destination: Destination, imageResult: DestinationImageResult) {
  const imageSearchVersion = imageResult.imageProvider === 'fallback' ? undefined : AUTO_IMAGE_VERSION
  return destination.destinationKey !== imageResult.destinationKey
    || destination.image !== imageResult.image
    || destination.imageProvider !== imageResult.imageProvider
    || destination.imageAuthor !== imageResult.imageAuthor
    || destination.imageSourceUrl !== imageResult.imageSourceUrl
    || destination.imageQuery !== imageResult.imageQuery
    || destination.imageSearchVersion !== imageSearchVersion
}

type DestinationNormalizer = (value: unknown) => Destination[] | null

function applySeedMigrations(destinations: Destination[]) {
  return destinations.map(destination => (
    DEFAULT_COUP_DE_COEUR_NAMES.has(destination.name) && destination.coupDeCoeur === undefined
      ? { ...destination, coupDeCoeur: true }
      : destination
  ))
}

function normalizeScores(destinations: Destination[]) {
  return destinations.map(withRecalculatedScore)
}

function loadFromLocalStorage(normalize: DestinationNormalizer): Destination[] | null {
  try {
    if (FAKE_FRIENDS_MODE) {
      const fakeSeedVersion = localStorage.getItem(FAKE_SEED_VERSION_KEY)
      if (fakeSeedVersion !== FAKE_SEED_VERSION) {
        localStorage.removeItem(STORAGE_KEY)
        localStorage.removeItem(LEGACY_STORAGE_KEY)
        localStorage.setItem(FAKE_SEED_VERSION_KEY, FAKE_SEED_VERSION)
        return null
      }
    }
    const saved = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY)
    if (!saved) return null
    const normalized = normalize(JSON.parse(saved))
    if (!normalized) return null
    return normalizeScores(applySeedMigrations(normalized))
  } catch {
    return null
  }
}

function getLocalSeedDestinations(normalize: DestinationNormalizer): Destination[] {
  const seeded = normalize(getFakeMyDestinations())
  return seeded ? normalizeScores(applySeedMigrations(seeded)) : []
}

function clearLocalCache() {
  try {
    localStorage.removeItem(STORAGE_KEY)
    localStorage.removeItem(LEGACY_STORAGE_KEY)
    if (FAKE_FRIENDS_MODE) localStorage.removeItem(FAKE_SEED_VERSION_KEY)
  } catch {
    /* ignore */
  }
}

function writeLocalCache(destinations: Destination[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(destinations))
  } catch {
    /* quota / disabled storage */
  }
}

function destinationsEqual(a: Destination, b: Destination): boolean {
  // Comparaison structurelle suffisante : si une seule propriété change on push.
  // Stringify est OK pour < 200 destinations.
  return JSON.stringify(a) === JSON.stringify(b)
}

function destinationsEqualList(a: Destination[], b: Destination[]): boolean {
  if (a.length !== b.length) return false
  return a.every((destination, index) => destinationsEqual(destination, b[index]))
}

function indexByName(list: Destination[]): Map<string, Destination> {
  const map = new Map<string, Destination>()
  for (const dest of list) map.set(dest.name, dest)
  return map
}

/**
 * Hook unifié pour le carnet de destinations courant.
 *
 * - **Non connecté** : localStorage (legacy) → cache local, démos OK, perte
 *   acceptée si le navigateur est nettoyé.
 * - **Connecté** : Supabase = source de vérité (RLS par user_id). À la 1ère
 *   connexion, si le carnet distant est vide et que le cache local contient
 *   des modifs, on les migre silencieusement.
 *
 * Chaque mutation de l'état React déclenche un push debouncé vers Supabase
 * (upsert pour les ajouts/maj, delete pour les retraits). Tout est optimiste :
 * l'UI reflète immédiatement le changement, le push se fait en arrière-plan.
 *
 * `error` permet à l'app d'afficher un toast discret si une sync échoue.
 */
export function useMyDestinations(normalize: DestinationNormalizer) {
  const { user } = useAuth()
  const userId = user?.id ?? null

  // État initial : optimiste depuis localStorage (évite un flash vide pendant le
  // fetch Supabase). Sera remplacé par les données distantes au mount si connecté.
  // Si rien en cache → carnet vide. Pas de seed démo : un nouvel utilisateur
  // doit voir un carnet vraiment vide, pas le carnet de démonstration.
  const [destinations, setDestinationsState] = useState<Destination[]>(() => {
    const cached = loadFromLocalStorage(normalize)
    if (cached) return cached
    if (FAKE_FRIENDS_MODE && !supabase) return getLocalSeedDestinations(normalize)
    return []
  })
  const [hydrated, setHydrated] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Snapshot précédent indexé par name : permet de diff pour ne pousser que
  // ce qui a changé (évite de réécrire 200 lignes à chaque toggle).
  const prevByNameRef = useRef<Map<string, Destination>>(indexByName(destinations))
  // Timers de debounce par name (upsert) + set de noms à supprimer pendant la fenêtre.
  const pendingUpsertTimers = useRef<Map<string, number>>(new Map())
  const pendingDeleteTimers = useRef<Map<string, number>>(new Map())
  // Empêche le push initial juste après hydratation depuis Supabase (les données
  // viennent déjà du serveur, inutile de les renvoyer).
  const suppressNextSyncRef = useRef(false)

  // ---- Push helpers --------------------------------------------------------

  const pushUpsert = useCallback((destination: Destination) => {
    if (!supabase || !userId) return
    const client = supabase
    const normalized = withRecalculatedScore(destination)
    const row = destinationToRow(normalized, userId)
    void client
      .from('destinations')
      .upsert(row, { onConflict: 'user_id,name' })
      .then(({ error: err }) => {
        if (err) {
          console.error('[useMyDestinations] upsert failed', destination.name, err)
          setError(err.message)
        }
      })
  }, [userId])

  const pushDelete = useCallback((name: string) => {
    if (!supabase || !userId) return
    const client = supabase
    void client
      .from('destinations')
      .delete()
      .eq('user_id', userId)
      .eq('name', name)
      .then(({ error: err }) => {
        if (err) {
          console.error('[useMyDestinations] delete failed', name, err)
          setError(err.message)
        }
      })
  }, [userId])

  const scheduleUpsert = useCallback((destination: Destination) => {
    const name = destination.name
    // Si un delete était pending pour le même nom, on l'annule (add-after-delete).
    const deleteTimer = pendingDeleteTimers.current.get(name)
    if (deleteTimer !== undefined) {
      window.clearTimeout(deleteTimer)
      pendingDeleteTimers.current.delete(name)
    }
    const existing = pendingUpsertTimers.current.get(name)
    if (existing !== undefined) window.clearTimeout(existing)
    const timer = window.setTimeout(() => {
      pendingUpsertTimers.current.delete(name)
      pushUpsert(destination)
    }, SUPABASE_PUSH_DEBOUNCE_MS)
    pendingUpsertTimers.current.set(name, timer)
  }, [pushUpsert])

  const scheduleDelete = useCallback((name: string) => {
    const upsertTimer = pendingUpsertTimers.current.get(name)
    if (upsertTimer !== undefined) {
      window.clearTimeout(upsertTimer)
      pendingUpsertTimers.current.delete(name)
    }
    const existing = pendingDeleteTimers.current.get(name)
    if (existing !== undefined) window.clearTimeout(existing)
    const timer = window.setTimeout(() => {
      pendingDeleteTimers.current.delete(name)
      pushDelete(name)
    }, SUPABASE_PUSH_DEBOUNCE_MS)
    pendingDeleteTimers.current.set(name, timer)
  }, [pushDelete])

  // ---- Hydratation (Supabase fetch + migration locale) ---------------------

  useEffect(() => {
    let cancelled = false

    // Pas d'utilisateur : on garde le cache local. Si on vient juste de signOut,
    // auth.tsx a déjà vidé le cache et l'app sera réinitialisée au prochain login.
    if (!userId || !supabase) {
      const cached = loadFromLocalStorage(normalize) ?? (FAKE_FRIENDS_MODE ? getLocalSeedDestinations(normalize) : [])
      suppressNextSyncRef.current = true
      setDestinationsState(cached)
      prevByNameRef.current = indexByName(cached)
      setHydrated(true)
      return
    }

    setHydrated(false)
    const client = supabase
    void (async () => {
      const { data, error: err } = await client
        .from('destinations')
        .select(DESTINATION_SELECT_COLUMNS)
        .eq('user_id', userId)
        .limit(MAX_REMOTE_DESTINATIONS)

      if (cancelled) return

      if (err) {
        console.error('[useMyDestinations] fetch failed', err)
        setError(err.message)
        setHydrated(true)
        return
      }

      const remoteListRaw = (data as DbDestinationRow[]).map(rowToDestination)
      const remoteList = normalizeScores(remoteListRaw)
      const localList = loadFromLocalStorage(normalize)
      const localHasUserData = !!localList && localList.length > 0

      if (remoteList.length === 0 && localHasUserData) {
        // Migration douce : on uploade le cache local puis on le purge.
        const client2 = supabase!
        const rows = localList!.map(d => destinationToRow(d, userId))
        const { error: upErr } = await client2.from('destinations').upsert(rows, { onConflict: 'user_id,name' })
        if (cancelled) return
        if (upErr) {
          console.error('[useMyDestinations] initial migration failed', upErr)
          setError(upErr.message)
          // On garde le local quand même en mémoire pour ne pas perdre l'affichage.
          suppressNextSyncRef.current = true
          setDestinationsState(localList!)
          prevByNameRef.current = indexByName(localList!)
        } else {
          suppressNextSyncRef.current = true
          setDestinationsState(localList!)
          prevByNameRef.current = indexByName(localList!)
          clearLocalCache()
        }
      } else {
        // Supabase fait foi. On efface le cache local pour qu'il ne pollue
        // jamais une autre session/un autre compte sur ce navigateur.
        const next = remoteList.length ? remoteList : []
        suppressNextSyncRef.current = destinationsEqualList(remoteListRaw, next)
        setDestinationsState(next)
        prevByNameRef.current = indexByName(remoteListRaw)
        clearLocalCache()
      }
      setHydrated(true)
    })()

    return () => { cancelled = true }
  }, [userId, normalize])

  // ---- Diff & push à chaque changement d'état -----------------------------

  useEffect(() => {
    if (suppressNextSyncRef.current) {
      suppressNextSyncRef.current = false
      prevByNameRef.current = indexByName(destinations)
      return
    }

    // Mode anonyme : on persiste en localStorage uniquement.
    if (!userId || !supabase) {
      writeLocalCache(destinations)
      prevByNameRef.current = indexByName(destinations)
      return
    }

    // Mode connecté : diff vs précédent → schedule upserts/deletes.
    const prev = prevByNameRef.current
    const nextIndex = indexByName(destinations)

    for (const [name, dest] of nextIndex) {
      const previous = prev.get(name)
      if (!previous || !destinationsEqual(previous, dest)) {
        scheduleUpsert(dest)
      }
    }
    for (const name of prev.keys()) {
      if (!nextIndex.has(name)) scheduleDelete(name)
    }

    prevByNameRef.current = nextIndex
  }, [destinations, userId, scheduleUpsert, scheduleDelete])

  // ---- Refresh d'images "faibles" en arrière-plan (existant conservé) -----

  useEffect(() => {
    const refreshTargets = destinations.filter(needsCatalogImage)
    if (!refreshTargets.length) return

    let cancelled = false
    void (async () => {
      const results = await getDestinationImagesForDestinations(refreshTargets, AUTO_IMAGE_FALLBACK)
      if (cancelled) return
      const upgrades = results.filter((result): result is NonNullable<typeof result> => result !== null)
      if (!upgrades.length) return
      setDestinationsState(previous => {
        let changed = false
        const next = previous.map(destination => {
          const upgrade = upgrades.find(item => item.name === destination.name)
          if (!upgrade || !catalogImageChanged(destination, upgrade.imageResult)) return destination
          changed = true
          return applyCatalogImage(destination, upgrade.imageResult)
        })
        return changed ? next : previous
      })
    })().catch(() => { /* garder les images stockées */ })

    return () => { cancelled = true }
  }, [destinations])

  // ---- Migration géométrie : zones legacy mal placées --------------------
  // Certaines zones sauvegardées avant le fix « centroïde du plus grand polygone »
  // ont un `lat/lng` aberrant (ex. France → Mauritanie) ou pas de `geojson`.
  // On les détecte et on recalcule via Nominatim, en respectant la policy
  // 1 req/sec. Une fois récupérée la nouvelle géométrie, on met à jour l'état :
  // le diff push existant propagera la correction vers Supabase automatiquement.
  const attemptedRepairRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!hydrated) return
    const candidates = destinations.filter(d => !attemptedRepairRef.current.has(d.name) && needsZoneGeometryRepair(d))
    if (!candidates.length) return

    let cancelled = false
    void (async () => {
      for (const dest of candidates) {
        if (cancelled) return
        attemptedRepairRef.current.add(dest.name)
        try {
          const repaired = await repairZoneDestinationGeometry(dest)
          if (cancelled || !repaired) continue
          setDestinationsState(previous => previous.map(item => (
            item.name === dest.name ? repaired : item
          )))
        } catch (err) {
          console.warn('[useMyDestinations] geo repair failed for', dest.name, err)
        }
        // Nominatim usage policy: max 1 req/sec — we use 1200ms to be safe.
        await new Promise(r => setTimeout(r, 1200))
      }
    })()

    return () => { cancelled = true }
  }, [destinations, hydrated])

  // ---- Cleanup au unmount : flush des timers en attente -------------------

  useEffect(() => {
    return () => {
      pendingUpsertTimers.current.forEach(t => window.clearTimeout(t))
      pendingDeleteTimers.current.forEach(t => window.clearTimeout(t))
      pendingUpsertTimers.current.clear()
      pendingDeleteTimers.current.clear()
    }
  }, [])

  // ---- Reset complet du carnet -------------------------------------------
  // Vide toutes les destinations de l'utilisateur (Supabase + cache local +
  // état React). Le profil, le pseudo et les amis ne sont pas touchés.
  // Utilisé par le bouton "Vider mon carnet" dans le panel Mon compte.
  const resetAll = useCallback(async (): Promise<{ error?: string }> => {
    // Annule les sync en cours pour éviter qu'un upsert pending ré-insère
    // une destination juste après le DELETE.
    pendingUpsertTimers.current.forEach(t => window.clearTimeout(t))
    pendingDeleteTimers.current.forEach(t => window.clearTimeout(t))
    pendingUpsertTimers.current.clear()
    pendingDeleteTimers.current.clear()

    // Évite que l'effet de diff re-pousse [] vers Supabase (DELETE déjà fait).
    suppressNextSyncRef.current = true
    setDestinationsState([])
    prevByNameRef.current = new Map()
    clearLocalCache()

    if (userId && supabase) {
      const { error: err } = await supabase
        .from('destinations')
        .delete()
        .eq('user_id', userId)
      if (err) {
        console.error('[useMyDestinations] resetAll failed', err)
        setError(err.message)
        return { error: err.message }
      }
    }
    setError(null)
    return {}
  }, [userId])

  return [destinations, setDestinationsState, { hydrated, error, resetAll }] as const
}
