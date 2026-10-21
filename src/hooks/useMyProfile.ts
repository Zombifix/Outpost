import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import type { MapVisibility, PublicProfile } from '../types'
import { FAKE_FRIENDS_MODE, FAKE_PROFILE } from './_fakeFriends'

interface ProfileRow {
  user_id: string
  handle: string
  display_name: string
  avatar_bg: string
  avatar_fg: string
  avatar_url: string | null
  bio: string | null
  map_visibility: MapVisibility | null
}

function rowToProfile(row: ProfileRow): PublicProfile {
  return {
    userId: row.user_id,
    handle: row.handle,
    displayName: row.display_name,
    avatarBg: row.avatar_bg,
    avatarFg: row.avatar_fg,
    avatarUrl: row.avatar_url ?? undefined,
    bio: row.bio ?? undefined,
    mapVisibility: row.map_visibility ?? 'friends',
  }
}

type AuthUser = NonNullable<ReturnType<typeof useAuth>['user']>

/**
 * Photo Google de l'utilisateur, y compris quand Google a ete lie apres une
 * inscription par e-mail (app_metadata.provider reste alors 'email').
 */
export function getGooglePictureUrl(user: AuthUser | null | undefined): string | undefined {
  if (!user) return undefined
  const pick = (data: Record<string, unknown> | null | undefined) =>
    (data?.avatar_url ?? data?.picture) as string | undefined
  const googleIdentity = user.identities?.find(identity => identity.provider === 'google')
  const fromIdentity = pick(googleIdentity?.identity_data)
  if (fromIdentity) return fromIdentity
  return user.app_metadata?.provider === 'google' ? pick(user.user_metadata) : undefined
}

/**
 * Profil public de l'utilisateur courant.
 * - `profile` est `null` si non charge OU si la ligne n'existe pas encore (premier login).
 * - `needsSetup` permet a App.tsx d'afficher le ProfileSetupModal de force.
 * - `upsert` insere ou met a jour le profil et retourne ok/error.
 * - `checkHandleAvailable` interroge la table pour valider l'unicite avant submit.
 */
export function useMyProfile() {
  const { user } = useAuth()
  const [profile, setProfile] = useState<PublicProfile | null>(null)
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async () => {
    if (!supabase && FAKE_FRIENDS_MODE) {
      setProfile(FAKE_PROFILE)
      setLoaded(true)
      return
    }
    if (!supabase || !user) {
      setProfile(null)
      setLoaded(true)
      return
    }
    setLoading(true)
    const { data } = await supabase
      .from('public_profiles')
      .select('user_id, handle, display_name, avatar_bg, avatar_fg, avatar_url, bio, map_visibility')
      .eq('user_id', user.id)
      .maybeSingle()
    setProfile(data ? rowToProfile(data as ProfileRow) : null)
    setLoading(false)
    setLoaded(true)
  }, [user])

  useEffect(() => {
    setLoaded(false)
    void refresh()
  }, [refresh])

  // Auto-sync avatar_url: récupère l'image Google même si un placeholder dicebear est déjà stocké.
  const avatarSyncedRef = useRef(false)
  useEffect(() => {
    if (!supabase || !user || !profile || avatarSyncedRef.current) return
    avatarSyncedRef.current = true

    const googleUrl = getGooglePictureUrl(user)

    if (googleUrl && googleUrl !== profile.avatarUrl) {
      void supabase.from('public_profiles').update({ avatar_url: googleUrl }).eq('user_id', user.id).then(() => refresh())
      return
    }

    if (!profile.avatarUrl) {
      const dicebear = `https://api.dicebear.com/9.x/thumbs/svg?seed=${encodeURIComponent(profile.handle)}`
      void supabase.from('public_profiles').update({ avatar_url: dicebear }).eq('user_id', user.id).then(() => refresh())
    }
  }, [profile, user, refresh])

  const upsert = useCallback(async (input: {
    handle: string
    displayName: string
    avatarBg?: string
    avatarFg?: string
    avatarUrl?: string
    bio?: string
    mapVisibility?: MapVisibility
  }): Promise<{ ok: boolean; error?: string }> => {
    if (!supabase && FAKE_FRIENDS_MODE) {
      setProfile(previous => ({
        ...(previous ?? FAKE_PROFILE),
        handle: input.handle.trim().toLowerCase() || (previous?.handle ?? FAKE_PROFILE.handle),
        displayName: input.displayName.trim() || (previous?.displayName ?? FAKE_PROFILE.displayName),
        avatarBg: input.avatarBg ?? previous?.avatarBg ?? FAKE_PROFILE.avatarBg,
        avatarFg: input.avatarFg ?? previous?.avatarFg ?? FAKE_PROFILE.avatarFg,
        avatarUrl: input.avatarUrl ?? previous?.avatarUrl,
        bio: input.bio ?? previous?.bio,
        mapVisibility: input.mapVisibility ?? previous?.mapVisibility ?? FAKE_PROFILE.mapVisibility,
      }))
      return { ok: true }
    }
    if (!supabase || !user) return { ok: false, error: 'Non connecte' }
    const handle = input.handle.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
    if (handle.length < 2 || handle.length > 32) return { ok: false, error: 'Handle entre 2 et 32 caracteres' }
    const displayName = input.displayName.trim()
    if (!displayName) return { ok: false, error: 'Nom requis' }
    const { error } = await supabase
      .from('public_profiles')
      .upsert({
        user_id: user.id,
        handle,
        display_name: displayName,
        avatar_bg: input.avatarBg ?? randomAvatarBg(handle),
        avatar_fg: input.avatarFg ?? '#ffffff',
        avatar_url: input.avatarUrl ?? null,
        bio: input.bio ?? null,
        map_visibility: input.mapVisibility ?? profile?.mapVisibility ?? 'friends',
      })
    if (error) {
      if (error.code === '23505') return { ok: false, error: 'Ce handle est deja pris' }
      return { ok: false, error: error.message }
    }
    await refresh()
    return { ok: true }
  }, [user, refresh, profile?.mapVisibility])

  const updateMapVisibility = useCallback(async (mapVisibility: MapVisibility): Promise<{ ok: boolean; error?: string }> => {
    if (!supabase && FAKE_FRIENDS_MODE) {
      setProfile(previous => ({
        ...(previous ?? FAKE_PROFILE),
        mapVisibility,
      }))
      return { ok: true }
    }
    if (!supabase || !user) return { ok: false, error: 'Non connecte' }
    const { error } = await supabase
      .from('public_profiles')
      .update({ map_visibility: mapVisibility })
      .eq('user_id', user.id)
    if (error) return { ok: false, error: error.message }
    await refresh()
    return { ok: true }
  }, [user, refresh])

  const checkHandleAvailable = useCallback(async (handle: string): Promise<boolean> => {
    if (!supabase && FAKE_FRIENDS_MODE) return handle.trim().length >= 2
    if (!supabase) return false
    const cleaned = handle.trim().toLowerCase()
    if (!cleaned) return false
    const { data, error } = await supabase
      .from('public_profiles')
      .select('user_id')
      .eq('handle', cleaned)
      .maybeSingle()
    if (error) return false
    return !data || (user !== null && (data as { user_id: string }).user_id === user.id)
  }, [user])

  return {
    profile,
    loading,
    loaded,
    needsSetup: loaded && !!user && !profile,
    refresh,
    upsert,
    updateMapVisibility,
    checkHandleAvailable,
  }
}

const AVATAR_COLORS = ['#7087fc', '#f97316', '#10b981', '#ec4899', '#a855f7', '#06b6d4', '#eab308', '#ef4444']

function randomAvatarBg(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) & 0xffffffff
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}
