import { useState } from 'react'
import { Avatar } from '../Avatar'
import { useFriends } from '../../hooks/useFriends'
import type { Friendship } from '../../types'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import { t } from '../../i18n'

interface FriendsManagePanelProps {
  /** Position sous le bouton Amis (en px depuis le haut et la droite) ; sans ancre, feuille centrée. */
  anchor?: { top: number; right: number } | null
  onClose: () => void
  onOpenAddFriend: () => void
  onViewFriendCarnet: (friend: Friendship) => void
  onCompareFriend: (friend: Friendship) => void
}

/**
 * Mini-pop-up de gestion des amis : une vue unique scrollable qui groupe
 * Demandes reçues → Envoyées → Mes amis. Pas d'onglets — tout est visible
 * d'un coup d'œil. Actions icon-only à droite de chaque ligne.
 */
export default function FriendsManagePanel({ anchor, onClose, onOpenAddFriend, onViewFriendCarnet, onCompareFriend }: FriendsManagePanelProps) {
  const { accepted, incoming, outgoing, loading, acceptRequest, removeFriendship, error } = useFriends()
  const isEmpty = accepted.length === 0 && incoming.length === 0 && outgoing.length === 0
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null)

  const trapRef = useFocusTrap<HTMLDivElement>(true)

  return (
    <div
      ref={trapRef}
      className={anchor ? 'manage-overlay manage-overlay--anchored' : 'manage-overlay'}
      role="dialog"
      aria-modal="true"
      aria-label={t('Manage friends', 'Gestion des amis')}
      onClick={onClose}
      onKeyDown={e => { if (e.key === 'Escape') onClose() }}
    >
      <aside
        className={anchor ? 'manage-panel manage-panel--popover' : 'manage-panel'}
        style={anchor ? { top: anchor.top, right: anchor.right } : undefined}
        onClick={e => e.stopPropagation()}
      >
        <header className="manage-head">
          <div className="manage-title">
            <h2>{t('Friends', 'Amis')}</h2>
            <span className="manage-count">{accepted.length}</span>
          </div>
          <button
            type="button"
            className="manage-add"
            onClick={onOpenAddFriend}
            aria-label={t('Add a friend', 'Ajouter un ami')}
          >
            <PlusIcon />
            <span>{t('Add', 'Ajouter')}</span>
          </button>
          <button
            type="button"
            className="manage-close"
            onClick={onClose}
            aria-label={t('Close', 'Fermer')}
          >
            <CloseIcon />
          </button>
        </header>

        {error && <p className="friends-feedback-err" style={{ margin: 0 }}>{error}</p>}
        {loading && <p className="friends-muted">{t('Loading…', 'Chargement…')}</p>}

        <div className="manage-body">
          {isEmpty && !loading && (
            <EmptyState label={t('No one yet. Add someone by username, email, or link.', 'Personne pour l\'instant. Ajoute quelqu\'un par pseudo, email ou lien.')} />
          )}

          {incoming.length > 0 && (
            <RowGroup label={`${t('Received', 'Reçues')} · ${incoming.length}`}>
              {incoming.map(f => (
                <ManageRow
                  key={f.otherUser}
                  friendship={f}
                  actions={
                    <>
                      <IconButton tone="accept" title={t('Accept', 'Accepter')} onClick={() => acceptRequest(f.otherUser)}>
                        <CheckIcon />
                      </IconButton>
                      <IconButton tone="reject" title={t('Decline', 'Refuser')} onClick={() => removeFriendship(f.otherUser)}>
                        <CloseIcon />
                      </IconButton>
                    </>
                  }
                />
              ))}
            </RowGroup>
          )}

          {outgoing.length > 0 && (
            <RowGroup label={`${t('Sent', 'Envoyées')} · ${outgoing.length}`}>
              {outgoing.map(f => (
                <ManageRow
                  key={f.otherUser}
                  friendship={f}
                  statusLabel={t('Pending', 'En attente')}
                  actions={
                    <IconButton tone="neutral" title={t('Cancel', 'Annuler')} onClick={() => removeFriendship(f.otherUser)}>
                      <CloseIcon />
                    </IconButton>
                  }
                />
              ))}
            </RowGroup>
          )}

          {accepted.length > 0 && (
            <RowGroup label={`${t('My friends', 'Mes amis')} · ${accepted.length}`}>
              {accepted.map(f => {
                const isConfirming = confirmingRemove === f.otherUser
                return (
                  <ManageRow
                    key={f.otherUser}
                    friendship={f}
                    onOpen={isConfirming ? undefined : () => onViewFriendCarnet(f)}
                    hint={t('View their map', 'Voir sa carte')}
                    statusLabel={isConfirming ? `${t('Remove', 'Retirer')} ${f.displayName}?` : undefined}
                    actions={isConfirming ? (
                      <>
                        <IconButton tone="reject" title={t('Confirm removal', 'Confirmer le retrait')} onClick={() => {
                          setConfirmingRemove(null)
                          void removeFriendship(f.otherUser)
                        }}>
                          <CheckIcon />
                        </IconButton>
                        <IconButton tone="neutral" title={t('Cancel', 'Annuler')} onClick={() => setConfirmingRemove(null)}>
                          <CloseIcon />
                        </IconButton>
                      </>
                    ) : (
                      <>
                        <CompareButton onClick={() => onCompareFriend(f)} />
                        <IconButton
                          tone="neutral"
                          title={t('Remove', 'Retirer')}
                          onClick={() => setConfirmingRemove(f.otherUser)}
                        >
                          <CloseIcon />
                        </IconButton>
                      </>
                    )}
                  />
                )
              })}
            </RowGroup>
          )}
        </div>
      </aside>
    </div>
  )
}

function EmptyState({ label }: { label: string }) {
  return <p className="manage-empty">{label}</p>
}

function RowGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="manage-group">
      <h4>{label}</h4>
      <ul>{children}</ul>
    </div>
  )
}

interface ManageRowProps {
  friendship: Friendship
  onOpen?: () => void
  statusLabel?: string
  hint?: string
  actions: React.ReactNode
}

function ManageRow({ friendship: f, onOpen, statusLabel, hint, actions }: ManageRowProps) {
  return (
    <li className="manage-row">
      <button
        type="button"
        className="manage-row-identity"
        onClick={onOpen}
        disabled={!onOpen}
        title={onOpen ? (hint ?? t(`View ${f.displayName}'s journal`, `Voir le carnet de ${f.displayName}`)) : undefined}
      >
        <Avatar avatarUrl={f.avatarUrl} initials={f.displayName} bg={f.avatarBg} fg={f.avatarFg} className="manage-avatar" />
        <span className="manage-row-meta">
          <strong>{f.displayName}</strong>
          <small>@{f.handle}{statusLabel ? ` · ${statusLabel}` : ''}</small>
        </span>
      </button>
      <span className="manage-row-actions">{actions}</span>
    </li>
  )
}

function CompareButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="manage-compare-btn"
      aria-label={t('Compare our maps', 'Comparer nos cartes')}
      title={t('Compare our maps', 'Comparer nos cartes')}
      onClick={onClick}
    >
      <CompareIcon />
      <span>{t('Compare', 'Comparer')}</span>
    </button>
  )
}

function IconButton({
  tone, title, onClick, children,
}: {
  tone: 'accept' | 'reject' | 'neutral'
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      className={`manage-icon-btn manage-icon-btn--${tone}`}
      aria-label={title}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function PlusIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

function CompareIcon() {
  // Deux colonnes superposées symbolisant "comparer"
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="7" height="14" rx="1.8" />
      <rect x="14" y="5" width="7" height="14" rx="1.8" />
      <path d="M6.5 9.5h.01" />
      <path d="M17.5 14.5h.01" />
      <path d="M10 12h4" />
    </svg>
  )
}
