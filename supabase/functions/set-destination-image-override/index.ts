// Supabase Edge Function: manual override for one official destination image.
//
// Secrets:
//   SUPABASE_URL
//   SUPABASE_ANON_KEY
//   SUPABASE_SERVICE_ROLE_KEY
//   IMAGE_ADMIN_USER_IDS      comma-separated auth user ids

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

type ImageSource = 'unsplash' | 'pexels' | 'wikivoyage' | 'wikipedia' | 'wikimedia' | 'fallback'

interface OverrideBody {
  destinationKey?: string
  imageUrl?: string
  imageSource?: ImageSource
  providerImageId?: string
  photographerName?: string
  photographerUrl?: string
  sourceUrl?: string
  alt?: string
  width?: number
  height?: number
  score?: number
}

// Allowed browser origins: the live site and local dev servers. Kept in code
// rather than in the ALLOWED_ORIGINS secret, which still held the dead
// Railway domain (a released domain can be claimed by someone else).
const ALLOWED_ORIGINS = [
  'https://mvggcf5azrvtt7bzmhazitzg.57.129.154.4.sslip.io',
  'http://localhost:5173',
  'http://localhost:4173',
  'http://localhost:4747',
]
const VALID_SOURCES = new Set<ImageSource>(['unsplash', 'pexels', 'wikivoyage', 'wikipedia', 'wikimedia', 'fallback'])

function getAllowedOrigins(): string[] {
  return ALLOWED_ORIGINS
}

function buildCorsHeaders(origin: string | null): Record<string, string> {
  const allowed = getAllowedOrigins()
  const allowOrigin = origin && allowed.includes(origin) ? origin : allowed[0]
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
}

function jsonWith(corsHeaders: Record<string, string>, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function getAdmins(): Set<string> {
  return new Set((Deno.env.get('IMAGE_ADMIN_USER_IDS') ?? '').split(',').map(id => id.trim()).filter(Boolean))
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('Origin')
  const corsHeaders = buildCorsHeaders(origin)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return jsonWith(corsHeaders, { error: 'method_not_allowed' }, 405)

  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) return jsonWith(corsHeaders, { error: 'unauthorized' }, 401)

  const admins = getAdmins()
  if (admins.size === 0) return jsonWith(corsHeaders, { error: 'admin_not_configured' }, 403)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: userData, error: userError } = await userClient.auth.getUser()
  if (userError || !userData.user || !admins.has(userData.user.id)) {
    return jsonWith(corsHeaders, { error: 'forbidden' }, 403)
  }

  let body: OverrideBody
  try {
    body = await req.json()
  } catch {
    return jsonWith(corsHeaders, { error: 'invalid_json' }, 400)
  }

  const destinationKey = body.destinationKey?.trim()
  const imageUrl = body.imageUrl?.trim()
  const imageSource = body.imageSource
  if (!destinationKey || !imageUrl || !imageSource || !VALID_SOURCES.has(imageSource)) {
    return jsonWith(corsHeaders, { error: 'invalid_override' }, 400)
  }

  const admin = createClient(supabaseUrl, serviceKey)
  const { data, error } = await admin
    .from('destination_images')
    .upsert({
      destination_key: destinationKey,
      image_url: imageUrl,
      image_source: imageSource,
      provider_image_id: body.providerImageId ?? null,
      photographer_name: body.photographerName ?? null,
      photographer_url: body.photographerUrl ?? null,
      source_url: body.sourceUrl ?? null,
      alt: body.alt ?? null,
      width: body.width ?? null,
      height: body.height ?? null,
      score: body.score ?? 100,
      status: 'active',
      is_manual_override: true,
      last_validated_at: new Date().toISOString(),
    }, { onConflict: 'destination_key' })
    .select('*')
    .single()

  if (error) return jsonWith(corsHeaders, { error: error.message }, 500)
  return jsonWith(corsHeaders, { ok: true, image: data })
})
