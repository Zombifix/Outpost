import { useEffect, useState } from 'react'
import { getGooglePictureUrl, type useMyProfile } from '../../hooks/useMyProfile'
import { useAuth } from '../../lib/auth'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import { t } from '../../i18n'

type ProfileHook = ReturnType<typeof useMyProfile>

interface ProfileSetupModalProps {
  /** Les actions du hook useMyProfile détenu par le parent (AppInner). On les
   *  passe en props pour que le upsert mute le MÊME state que celui qui
   *  contrôle l'affichage du modal — sinon le modal reste ouvert après création. */
  upsert: ProfileHook['upsert']
  checkHandleAvailable: ProfileHook['checkHandleAvailable']
}

/**
 * Forcé au premier login : impossible de fermer tant que le handle + nom ne sont
 * pas remplis et sauvés. Sans `public_profile`, l'utilisateur est invisible aux
 * recherches d'amis et les RPC `my_friendships` ne retournent rien.
 *
 * Rendu uniquement par App.tsx quand `useMyProfile().needsSetup === true`.
 */
export default function ProfileSetupModal({ upsert, checkHandleAvailable }: ProfileSetupModalProps) {
  const { user, signOut } = useAuth()
  const [handle, setHandle] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [handleStatus, setHandleStatus] = useState<'idle' | 'checking' | 'taken' | 'free' | 'invalid'>('idle')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Pré-remplir avec l'email
  useEffect(() => {
    if (!user?.email) return
    const local = user.email.split('@')[0]
    setDisplayName(prev => prev || prettifyName(local))
    setHandle(prev => prev || sanitizeHandle(local))
  }, [user])

  // Vérification live de la dispo du handle (debounced)
  useEffect(() => {
    const cleaned = sanitizeHandle(handle)
    if (cleaned.length < 2) {
      setHandleStatus(cleaned.length === 0 ? 'idle' : 'invalid')
      return
    }
    setHandleStatus('checking')
    const t = window.setTimeout(async () => {
      const free = await checkHandleAvailable(cleaned)
      setHandleStatus(free ? 'free' : 'taken')
    }, 350)
    return () => window.clearTimeout(t)
  }, [handle, checkHandleAvailable])

  const getAvatarUrl = (handle: string): string => {
    const url = getGooglePictureUrl(user)
    if (url) return url
    return `https://api.dicebear.com/9.x/thumbs/svg?seed=${encodeURIComponent(handle)}`
  }

  const submit = async () => {
    setError(null)
    const cleanedHandle = sanitizeHandle(handle)
    const cleanedName = displayName.trim()
    if (cleanedHandle.length < 2) { setError(t('Username too short (min 2)', 'Handle trop court (min 2)')); return }
    if (!cleanedName) { setError(t('Name required', 'Nom requis')); return }
    if (handleStatus === 'taken') { setError(t('Username already taken', 'Handle déjà pris')); return }
    setBusy(true)
    const res = await upsert({ handle: cleanedHandle, displayName: cleanedName, avatarUrl: getAvatarUrl(cleanedHandle) })
    setBusy(false)
    if (!res.ok) setError(res.error ?? t('Error', 'Erreur'))
  }

  const trapRef = useFocusTrap<HTMLDivElement>(true)

  return (
    <div ref={trapRef} className="account-overlay friends-modal-overlay" role="dialog" aria-modal="true" aria-label={t('Create your profile', 'Créer ton profil')}>
      <aside className="account-panel friends-add-panel" style={{ maxWidth: 460 }} onClick={event => event.stopPropagation()}>
        <h2 style={{ marginTop: 'var(--space-1)' }}>{t('Welcome to Outpost', 'Bienvenue sur Outpost')}</h2>
        <p className="account-hint">
          {t("Choose a username and a display name. That's what your friends will see to find you.", "Choisis un pseudo et un nom affiché. C'est ce que tes amis verront pour te trouver.")}
        </p>

        <label>
          {t('Username', 'Pseudo')}
          <div className="profile-setup-handle-wrap">
            <span className="profile-setup-handle-prefix">@</span>
            <input
              value={handle}
              onChange={e => setHandle(e.target.value)}
              placeholder="theo-p"
              maxLength={32}
              autoFocus
            />
          </div>
        </label>
        <HandleHint status={handleStatus} value={sanitizeHandle(handle)} />

        <label>
          {t('Display name', 'Nom affiché')}
          <input
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            placeholder="Théo"
            maxLength={60}
          />
        </label>

        {error && <p className="friends-feedback-err">{error}</p>}

        <button
          className="add-submit"
          onClick={submit}
          disabled={busy || handleStatus === 'taken' || handleStatus === 'invalid' || handleStatus === 'checking'}
          style={{ marginTop: 'var(--space-3)' }}
        >
          {busy ? t('Creating…', 'Création…') : t('Create my profile', 'Créer mon profil')}
        </button>

        <button
          onClick={signOut}
          style={{
            marginTop: 'var(--space-2)', background: 'transparent', border: 'none',
            color: 'var(--text-subtle)', fontSize: 'var(--text-xs)', cursor: 'pointer', textDecoration: 'underline',
          }}
        >
          {t('Sign out', 'Me déconnecter')}
        </button>
      </aside>
    </div>
  )
}

function HandleHint({ status, value }: { status: string; value: string }) {
  if (status === 'idle') return <p className="friends-muted">{t('Min 2 characters, letters / numbers / dashes.', 'Minimum 2 caractères, lettres / chiffres / tirets.')}</p>
  if (status === 'invalid') return <p className="friends-feedback-err">{t('Username too short.', 'Handle trop court.')}</p>
  if (status === 'checking') return <p className="friends-muted">{t('Checking…', 'Vérification…')}</p>
  if (status === 'taken') return <p className="friends-feedback-err">@{value} {t('is already taken.', 'est déjà pris.')}</p>
  if (status === 'free') return <p className="friends-feedback-ok">@{value} {t('is available ✓', 'est disponible ✓')}</p>
  return null
}

function sanitizeHandle(raw: string): string {
  return raw.trim().toLowerCase().replace(/^@/, '').replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
}

function prettifyName(raw: string): string {
  return raw.replace(/[._-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}
