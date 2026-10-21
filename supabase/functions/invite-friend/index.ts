// Supabase Edge Function : envoie un magic-link d'invitation d'ami par email.
//
// Déploiement :
//   supabase functions deploy invite-friend
//
// Secrets requis (à configurer côté Supabase) :
//   SUPABASE_URL                — URL du projet (présent par défaut)
//   SUPABASE_SERVICE_ROLE_KEY   — clé service-role (présent par défaut sur Supabase)
//
// Body JSON: { email: string, inviteToken: string }
// Header:   Authorization: Bearer <user_jwt>  (l'utilisateur connecté qui invite)
//
// Réponse: { ok: true } ou { error: string }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Allowed browser origins: the live site and local dev servers. Kept in code
// rather than in the ALLOWED_ORIGINS secret, which still held the dead
// Railway domain (a released domain can be claimed by someone else).
const ALLOWED_ORIGINS = [
  'https://mvggcf5azrvtt7bzmhazitzg.57.129.154.4.sslip.io',
  'http://localhost:5173',
  'http://localhost:4173',
  'http://localhost:4747',
]

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

interface InviteBody {
  email?: string
  inviteToken?: string
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('Origin')
  const corsHeaders = buildCorsHeaders(origin)
  const allowed = getAllowedOrigins()

  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  // Hors prefligth, on rejette explicitement les origines non whitelistées
  if (origin && !allowed.includes(origin)) {
    return jsonWith(corsHeaders, { error: 'forbidden_origin' }, 403)
  }

  if (req.method !== 'POST') {
    return jsonWith(corsHeaders, { error: 'method_not_allowed' }, 405)
  }

  let body: InviteBody
  try {
    body = await req.json()
  } catch {
    return jsonWith(corsHeaders, { error: 'invalid_json' }, 400)
  }

  const email = (body.email ?? '').trim().toLowerCase()
  const inviteToken = (body.inviteToken ?? '').trim()
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonWith(corsHeaders, { error: 'invalid_email' }, 400)
  }
  if (!inviteToken) return jsonWith(corsHeaders, { error: 'missing_token' }, 400)

  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) return jsonWith(corsHeaders, { error: 'unauthorized' }, 401)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!

  // Valide le user qui invite
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: userData, error: userErr } = await userClient.auth.getUser()
  if (userErr || !userData.user) return jsonWith(corsHeaders, { error: 'unauthorized' }, 401)

  // Envoie un magic-link à l'invité avec redirection contenant le token
  const admin = createClient(supabaseUrl, serviceKey)
  const redirectTo = origin ? `${origin}/?invite=${encodeURIComponent(inviteToken)}` : undefined

  const { error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo,
    data: { inviter_user_id: userData.user.id, invite_token: inviteToken },
  })

  if (inviteErr) {
    // Si l'user existe déjà, on tombe sur un magic-link OTP standard
    const { error: otpErr } = await admin.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo },
    })
    if (otpErr) return jsonWith(corsHeaders, { error: otpErr.message }, 400)
  }

  return jsonWith(corsHeaders, { ok: true })
})

function jsonWith(corsHeaders: Record<string, string>, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
