import type { ReturnIntent, Tier } from '../types'
import { TIER_ORDER } from '../data'
import { t } from '../i18n'
import { VERDICT_VALUES, type TierBreakdown } from '../utils'

/**
 * Questions de la notation v2, partagées entre le wizard (saisie) et la fiche
 * destination (restitution des réponses). Cf. docs/notation-v2.md.
 */

export function stripLeadingEmojiLabel(label: string) {
  const parts = label.split(' ')
  const first = parts[0]
  const hasEmojiLead = /\p{Extended_Pictographic}/u.test(first)
  return {
    hasEmojiLead,
    leadingToken: hasEmojiLead ? first : '',
    text: hasEmojiLead ? label.slice(first.length).trim() : label,
  }
}

// Notation v2 (cf. docs/notation-v2.md). Ordre : le plaisir d'abord, le
// pratique ensuite, le verdict et le retour à la fin pour limiter l'effet de halo.
// Les valeurs suivent l'encodage décrit dans src/utils.ts.
export type AxisKey = 'culture' | 'nature' | 'food' | 'night' | 'vibeBoost' | 'ease' | 'value'
export type QuestionKey = AxisKey | 'retourBonus' | 'returnIntent'

export interface QuestionAnswer {
  label: string
  value: number | ReturnIntent
}

export interface QuestionDef {
  key: QuestionKey
  question: string
  answers: QuestionAnswer[]
  /** Les axes acceptent « Pas concerné » ; le verdict et le retour sont obligatoires. */
  skippable: boolean
}

export const QUESTIONS: QuestionDef[] = [
  {
    key: 'culture',
    question: t('🗺️ How were your days there?', '🗺️ Ce que tu as fait sur place, c\'était comment ?'),
    skippable: true,
    answers: [
      { label: t('✨ Some standout moments', '✨ Des moments forts'), value: 5 },
      { label: t('🙂 Pleasant', '🙂 Agréable'), value: 4 },
      { label: t('🐢 Dragged a bit at times', '🐢 Un peu long par moments'), value: 3 },
      { label: t('🥱 Boring', '🥱 Ennuyeux'), value: 1 },
    ],
  },
  {
    key: 'nature',
    question: t('📸 And the setting?', '📸 Et le cadre, tu l\'as trouvé comment ?'),
    skippable: true,
    answers: [
      { label: t('😍 Gorgeous', '😍 Superbe'), value: 5 },
      { label: t('📷 Some lovely spots', '📷 De beaux coins'), value: 4 },
      { label: t('😐 It was fine', '😐 Sans plus'), value: 3 },
      { label: t('🙈 Not much to look at', '🙈 Pas joli'), value: 1 },
    ],
  },
  {
    key: 'food',
    question: t('🍽️ How was the food?', '🍽️ Côté repas, c\'était comment ?'),
    skippable: true,
    answers: [
      { label: t('🤤 A real treat', '🤤 Un régal'), value: 5 },
      { label: t('😋 Good, a few solid spots', '😋 Bon, quelques belles adresses'), value: 4 },
      { label: t('😐 Decent, nothing more', '😐 Correct, sans plus'), value: 3 },
      { label: t('😕 Disappointing', '😕 Décevant'), value: 1 },
    ],
  },
  {
    key: 'night',
    question: t('🌙 What were the evenings like?', '🌙 Et les soirées, ça donnait quoi ?'),
    skippable: true,
    answers: [
      { label: t('🔥 Loved the evenings', '🔥 De super soirées'), value: 5 },
      { label: t('🍷 Good', '🍷 Sympas'), value: 4 },
      { label: t('😐 Nothing special', '😐 Rien de spécial'), value: 3 },
      { label: t('😩 Pretty rough', '😩 Pénibles'), value: 1 },
    ],
  },
  {
    key: 'vibeBoost',
    question: t('🫶 And the people, the vibe?', '🫶 Et l\'accueil, l\'ambiance ?'),
    skippable: true,
    answers: [
      { label: t('🥰 Lovely people', '🥰 Des gens adorables'), value: 5 },
      { label: t('🙂 Nothing stood out', '🙂 Rien à signaler'), value: 3 },
      { label: t('🥶 People were a bit cold', '🥶 Des gens plutôt froids'), value: 2 },
      { label: t('⚠️ I didn\'t feel safe', '⚠️ Je ne me sentais pas en sécurité'), value: 1 },
    ],
  },
  {
    key: 'ease',
    question: t('🧩 Getting around: easy or a hassle?', '🧩 Pour te déplacer, simple ou galère ?'),
    skippable: true,
    answers: [
      { label: t('👌 Easy', '👌 Simple'), value: 5 },
      { label: t('🗺️ Took some adjusting', '🗺️ Il fallait s\'adapter'), value: 3 },
      { label: t('🚧 A total hassle', '🚧 Une vraie galère'), value: 1 },
    ],
  },
  {
    key: 'value',
    question: t('💸 How was it on the wallet?', '💸 Et le budget sur place ?'),
    skippable: true,
    answers: [
      { label: t('👑 A great deal', '👑 Une bonne affaire'), value: 5 },
      { label: t('⚖️ About what I expected', '⚖️ Dans les prix attendus'), value: 4 },
      { label: t('💸 A bit pricey', '💸 Un peu cher'), value: 3 },
      { label: t('🚨 Too expensive, it spoiled things', '🚨 Trop cher, ça a gâché des moments'), value: 1 },
    ],
  },
  {
    key: 'retourBonus',
    question: t('🔁 A friend\'s on the fence about going. What do you tell them?', '🔁 Un ami hésite à y aller. Tu lui dis quoi ?'),
    skippable: false,
    answers: [
      { label: t('💌 Go for it', '💌 Fonce'), value: VERDICT_VALUES.go },
      { label: t('👍 Worth it', '👍 Ça vaut le coup'), value: VERDICT_VALUES.worth },
      { label: t('🤷 Meh, there\'s better', '🤷 Bof, il y a mieux'), value: VERDICT_VALUES.meh },
      { label: t('🙅 Honestly, skip it', '🙅 Franchement, évite'), value: VERDICT_VALUES.skip },
    ],
  },
  {
    key: 'returnIntent',
    question: t('✈️ Would you go back?', '✈️ Et toi, tu y retournerais ?'),
    skippable: false,
    answers: [
      { label: t('🛫 Tomorrow, no question', '🛫 Demain, sans hésiter'), value: 'tomorrow' },
      { label: t('🙂 Someday, sure', '🙂 Un jour, oui'), value: 'someday' },
      { label: t('✅ Once was enough', '✅ Une fois, ça suffit'), value: 'once' },
    ],
  },
]

export const AXIS_KEYS: AxisKey[] = ['culture', 'nature', 'food', 'night', 'vibeBoost', 'ease', 'value']

export const AXIS_SHORT_LABELS: Record<AxisKey, string> = {
  culture: t('Days', 'Journées'),
  nature: t('Setting', 'Cadre'),
  food: t('Food', 'Repas'),
  night: t('Evenings', 'Soirées'),
  vibeBoost: t('People', 'Accueil'),
  ease: t('Getting around', 'Déplacements'),
  value: t('Budget', 'Budget'),
}

export const AXIS_ICONS: Record<AxisKey, string> = {
  culture: 'temple',
  nature: 'mountain',
  food: 'utensils',
  night: 'martini',
  vibeBoost: 'users',
  ease: 'compass',
  value: 'coins',
}

// « Les repas » plutôt que « repas » dans la phrase d'explication.
const AXIS_SENTENCE_LABELS: Record<AxisKey, string> = {
  culture: t('your days', 'tes journées'),
  nature: t('the setting', 'le cadre'),
  food: t('the food', 'les repas'),
  night: t('the evenings', 'les soirées'),
  vibeBoost: t('the people', 'l\'accueil'),
  ease: t('getting around', 'les déplacements'),
  value: t('the budget', 'le budget'),
}

// Accord du verbe en français : « les repas l'ont », « le cadre l'a ».
const AXIS_PLURAL: Record<AxisKey, boolean> = {
  culture: true,
  nature: false,
  food: true,
  night: true,
  vibeBoost: false,
  ease: true,
  value: false,
}

/** Libellé de la réponse choisie, sans l'emoji de tête. */
/** Emoji et libellé de la réponse choisie, pour l'afficher en carte. */
export function getAnswerParts(key: QuestionKey, value: unknown): { emoji: string; text: string } | null {
  const question = QUESTIONS.find(q => q.key === key)
  const answer = question?.answers.find(a => a.value === value)
  if (!answer) return null
  const parsed = stripLeadingEmojiLabel(answer.label)
  return { emoji: parsed.leadingToken, text: parsed.text }
}

export function getAnswerLabel(key: QuestionKey, value: unknown): string | null {
  const question = QUESTIONS.find(q => q.key === key)
  const answer = question?.answers.find(a => a.value === value)
  return answer ? stripLeadingEmojiLabel(answer.label).text : null
}

function joinWithAnd(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} ${t('and', 'et')} ${items[items.length - 1]}`
}

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text
}

/** Phrase d'explication du tier, construite uniquement à partir des réponses. */
export function buildTierExplanation(breakdown: TierBreakdown): string {
  const verdictLine: Record<Tier, string> = {
    S: '',
    A: t('You\'d tell a friend to go for it', 'Tu dirais à un ami de foncer'),
    B: t('You find it worth it', 'Tu trouves que ça vaut le coup'),
    C: t('You think there\'s better', 'Tu trouves qu\'il y a mieux'),
    D: t('You\'d tell people to skip it', 'Tu le déconseilles'),
  }
  const sentences: string[] = [`${verdictLine[breakdown.startTier]}.`]
  const wowLabels = breakdown.wows.map(axis => AXIS_SENTENCE_LABELS[axis as AxisKey])
  if (breakdown.favorite) wowLabels.push(t('your favorite', 'ton coup de cœur'))
  const wowPlural = wowLabels.length > 1 || breakdown.wows.some(axis => AXIS_PLURAL[axis as AxisKey])
  const flopLabels = breakdown.flops.map(axis => AXIS_SENTENCE_LABELS[axis as AxisKey])
  const flopPlural = flopLabels.length > 1 || breakdown.flops.some(axis => AXIS_PLURAL[axis as AxisKey])
  const startIndex = TIER_ORDER.indexOf(breakdown.startTier)
  const computedIndex = TIER_ORDER.indexOf(breakdown.computedTier)

  if (breakdown.safetyCap && (breakdown.startTier === 'A' || (breakdown.startTier === 'B' && breakdown.points >= 2))) {
    sentences.push(t('You didn\'t feel safe there, so it can\'t go above Nice.', 'Tu ne t\'y sentais pas en sécurité : ça plafonne à Sympa.'))
  } else if (computedIndex < startIndex) {
    sentences.push(wowLabels.length
      ? t(`${capitalize(joinWithAnd(wowLabels))} pushed it up.`, `${capitalize(joinWithAnd(wowLabels))} ${wowPlural ? "l'ont" : "l'a"} fait monter.`)
      : t('Your favorite pushed it up.', 'Ton coup de cœur l\'a fait monter.'))
  } else if (computedIndex > startIndex && flopLabels.length) {
    sentences.push(t(`${capitalize(joinWithAnd(flopLabels))} brought it down.`, `${capitalize(joinWithAnd(flopLabels))} ${flopPlural ? "l'ont" : "l'a"} fait baisser.`))
  } else if (breakdown.startTier === 'A' && breakdown.points >= 2 && !breakdown.hasKey) {
    sentences.push(t('A favorite would make it a Gem.', 'Un coup de cœur en ferait une Pépite.'))
  }
  if (breakdown.adjust !== 0) {
    sentences.push(t('You adjusted it yourself.', 'Tu l\'as ajusté toi-même.'))
  }
  return sentences.join(' ')
}

