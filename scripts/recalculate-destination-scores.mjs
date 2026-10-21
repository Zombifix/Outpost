import fs from 'node:fs/promises'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

function parseArgs(argv) {
  const options = {
    apply: false,
    id: null,
    userId: null,
    name: null,
    limit: null,
    snapshotDir: path.resolve(process.cwd(), 'tmp', 'score-recalc-snapshots'),
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--apply') options.apply = true
    else if (arg === '--id') options.id = argv[++index] ?? null
    else if (arg === '--user-id') options.userId = argv[++index] ?? null
    else if (arg === '--name') options.name = argv[++index] ?? null
    else if (arg === '--limit') options.limit = Number(argv[++index] ?? NaN)
    else if (arg === '--snapshot-dir') options.snapshotDir = path.resolve(process.cwd(), argv[++index] ?? '')
    else if (arg === '--help') options.help = true
    else throw new Error(`Unknown argument: ${arg}`)
  }

  if (options.limit != null && (!Number.isInteger(options.limit) || options.limit <= 0)) {
    throw new Error('--limit must be a positive integer')
  }
  if ((options.userId && !options.name) || (!options.userId && options.name)) {
    throw new Error('Use --user-id and --name together when targeting by destination name')
  }
  return options
}

function printHelp() {
  console.log(`
Usage:
  npm run recalculate:scores -- [--apply] [--id <uuid> | --user-id <uuid> --name "<destination>"] [--limit <n>] [--snapshot-dir <dir>]

Examples:
  npm run recalculate:scores -- --id 00000000-0000-0000-0000-000000000000
  npm run recalculate:scores -- --user-id 00000000-0000-0000-0000-000000000000 --name "Kyoto"
  npm run recalculate:scores -- --apply --limit 25
  npm run recalculate:scores -- --apply

Behavior:
  - dry-run by default
  - uses the v2 drawer model (docs/notation-v2.md)
  - skips rows without a verdict
  - writes a local snapshot before any applied update
`)
}

function toNumberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

// Port de computeTierBreakdown / getDestinationScore (src/utils.ts), notation v2.
// À garder synchronisé avec la version TypeScript. Cf. docs/notation-v2.md.
const TIER_LADDER = ['D', 'C', 'B', 'A', 'S']
const TIER_CENTER = { S: 4.75, A: 4.25, B: 3.6, C: 2.8, D: 1.7 }
const WOW_AXES = ['culture', 'nature', 'food', 'night', 'vibe_boost']
const FLOP_ONLY_AXES = ['ease', 'value']

function shiftTier(tier, delta) {
  const index = TIER_LADDER.indexOf(tier)
  return TIER_LADDER[Math.max(0, Math.min(TIER_LADDER.length - 1, index + delta))]
}

function computeTier(row) {
  const verdict = toNumberOrNull(row.retour_bonus)
  if (verdict === null) return null
  const start = verdict >= 0.3 ? 'A' : verdict >= 0.1 ? 'B' : verdict >= 0 ? 'C' : 'D'
  let points = row.coup_de_coeur ? 1 : 0
  for (const axis of WOW_AXES) {
    const value = toNumberOrNull(row[axis])
    if (value === null) continue
    if (value >= 5) points += 1
    else if (value <= 1) points -= 1
  }
  for (const axis of FLOP_ONLY_AXES) {
    const value = toNumberOrNull(row[axis])
    if (value !== null && value <= 1) points -= 1
  }
  const hasKey = Boolean(row.coup_de_coeur) || row.return_intent === 'tomorrow'
  let tier = start
  if (points >= 2) tier = shiftTier(tier, 1)
  else if (points <= -2) tier = shiftTier(tier, -1)
  if (tier === 'S' && !hasKey) tier = 'A'
  if (toNumberOrNull(row.vibe_boost) === 1 && (tier === 'S' || tier === 'A')) tier = 'B'
  const adjust = Math.max(-1, Math.min(1, Math.round(toNumberOrNull(row.tier_adjust) ?? 0)))
  if (adjust !== 0) tier = shiftTier(tier, adjust)
  const score = TIER_CENTER[tier] + Math.max(-5, Math.min(5, points)) * 0.03 + (hasKey ? 0.005 : 0)
  return { tier, score }
}

function roundScore(score) {
  return Math.round(score * 10) / 10
}

function makeCsv(rows) {
  const headers = ['id', 'user_id', 'name', 'previous_score', 'previous_tier', 'memorability', 'updated_at']
  const escape = (value) => {
    if (value == null) return ''
    const text = String(value)
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
  }
  return [
    headers.join(','),
    ...rows.map(row => headers.map(header => escape(row[header])).join(',')),
  ].join('\n')
}

async function writeSnapshot(snapshotDir, rows) {
  const stamp = new Date().toISOString().replaceAll(':', '-')
  await fs.mkdir(snapshotDir, { recursive: true })
  const jsonPath = path.join(snapshotDir, `destination-score-snapshot-${stamp}.json`)
  const csvPath = path.join(snapshotDir, `destination-score-snapshot-${stamp}.csv`)
  const snapshotRows = rows.map(row => ({
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    previous_score: row.score,
    previous_tier: row.tier,
    memorability: row.memorability,
    updated_at: row.updated_at,
  }))
  await fs.writeFile(jsonPath, `${JSON.stringify(snapshotRows, null, 2)}\n`, 'utf8')
  await fs.writeFile(csvPath, `${makeCsv(snapshotRows)}\n`, 'utf8')
  return { jsonPath, csvPath }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }

  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY for dry-run)')
  }

  const client = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } })
  let query = client
    .from('destinations')
    .select('id, user_id, name, food, night, culture, nature, value, ease, vibe_boost, retour_bonus, return_intent, tier_adjust, coup_de_coeur, score, tier, updated_at')

  if (options.id) query = query.eq('id', options.id)
  if (options.userId) query = query.eq('user_id', options.userId)
  if (options.name) query = query.eq('name', options.name)
  if (options.limit != null) query = query.limit(options.limit)

  const { data, error } = await query
  if (error) throw error

  const rows = data ?? []
  if (rows.length === 0) {
    console.log('No matching destinations found.')
    return
  }

  // Sans verdict (notation antérieure à la v2 ou remise à zéro), on ne touche pas à la ligne.
  const changes = rows.filter(row => computeTier(row) !== null).map(row => {
    const computed = computeTier(row)
    const nextScore = roundScore(computed.score)
    const nextTier = computed.tier
    return {
      ...row,
      nextScore,
      nextTier,
      changed: row.score !== nextScore || row.tier !== nextTier,
    }
  })

  const impacted = changes.filter(row => row.changed)

  console.log(`Scanned ${rows.length} destination(s).`)
  console.log(`Would update ${impacted.length} destination(s).`)
  for (const row of impacted.slice(0, 20)) {
    console.log(`- ${row.id} | ${row.name} | ${row.score ?? 'null'} ${row.tier ?? '-'} -> ${row.nextScore} ${row.nextTier}`)
  }
  if (impacted.length > 20) {
    console.log(`... ${impacted.length - 20} more`)
  }

  if (!options.apply) {
    console.log('Dry-run only. Re-run with --apply to persist score/tier updates.')
    return
  }

  if (process.env.SUPABASE_SERVICE_ROLE_KEY == null) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for --apply')
  }

  if (impacted.length === 0) {
    console.log('No updates to apply.')
    return
  }

  const snapshot = await writeSnapshot(options.snapshotDir, impacted)
  console.log(`Snapshot written to ${snapshot.jsonPath}`)
  console.log(`Snapshot CSV written to ${snapshot.csvPath}`)

  for (const row of impacted) {
    const { error: updateError } = await client
      .from('destinations')
      .update({ score: row.nextScore, tier: row.nextTier })
      .eq('id', row.id)
    if (updateError) throw updateError
  }

  console.log(`Applied ${impacted.length} update(s).`)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
