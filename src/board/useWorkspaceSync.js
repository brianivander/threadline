// Workspace sync state for the sidebar footer: whether this folder can be
// synced at all, when it last was, and the one action that does it.
//
// Two sources on purpose. The "last sync" label is ours, kept in localStorage
// per workspace — it's the human-friendly part and nothing but us records it.
// Everything else (ahead/behind/dirty) is read back out of git on every
// refresh, so a push that silently failed can't leave the footer claiming
// success: the label may say "just now" while `ahead` still shows work
// waiting, and the footer shows both.

import { useCallback, useEffect, useState } from 'react'

const isElectron = typeof window !== 'undefined' && !!window.threadlineDesktop?.isElectron

const LAST_SYNC_PREFIX = 'threadline_last_sync:'

// Every one of these is fixed outside Threadline — the app detects and
// explains, GitHub Desktop does the setup. Keep them imperative: the user is
// reading this to find out what to go and do.
const REASONS = {
  'no-workspace': 'Open a folder to sync',
  'no-git': 'Git is not installed on this computer',
  'not-a-repo': 'This folder is not set up for sync — set it up in GitHub Desktop',
  'no-identity': 'Set your git name and email in GitHub Desktop',
  'no-remote': 'This folder has no remote — add one in GitHub Desktop',
  'no-upstream': 'This branch is not tracking a remote — publish it in GitHub Desktop',
  diverged: 'Your copy and the team’s have both changed — resolve it in GitHub Desktop',
  'dirty-conflict': 'Your local edits clash with incoming changes — resolve in GitHub Desktop',
  'auth-failed': 'Git could not sign you in — check your account in GitHub Desktop',
  timeout: 'Sync timed out — check your connection and try again',
  'push-failed': 'Could not send your changes up',
}

export function syncMessage(reason) {
  return REASONS[reason] || 'Sync failed'
}

export function formatLastSync(iso) {
  if (!iso) return 'Never synced'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 'Never synced'
  const mins = Math.floor((Date.now() - then) / 60000)
  if (mins < 1) return 'Last sync just now'
  if (mins < 60) return `Last sync ${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `Last sync ${hours}h ago`
  return `Last sync ${Math.floor(hours / 24)}d ago`
}

function readLastSync(root) {
  try {
    return localStorage.getItem(LAST_SYNC_PREFIX + root) || null
  } catch {
    return null
  }
}

export function useWorkspaceSync({ root }) {
  const [status, setStatus] = useState(null)
  const [lastSync, setLastSync] = useState(() => (root ? readLastSync(root) : null))
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState(null)
  // git's own words for the failure. The short reason above is what the footer
  // shows; this is what makes the difference between diagnosing a failure and
  // guessing at it, so it rides along to the tooltip.
  const [detail, setDetail] = useState(null)

  const refresh = useCallback(async () => {
    if (!isElectron || !root) {
      setStatus(root ? null : { state: 'no-workspace' })
      return
    }
    setStatus(await window.threadlineDesktop.getGitStatus(root))
  }, [root])

  // Switching workspaces swaps both halves of the footer at once — a stale
  // "Last sync 2m ago" from the previous folder would be a lie about this one.
  useEffect(() => {
    setLastSync(root ? readLastSync(root) : null)
    setError(null)
    setDetail(null)
    refresh()
  }, [root, refresh])

  const sync = useCallback(async () => {
    if (!isElectron || !root || syncing) return
    setSyncing(true)
    setError(null)
    setDetail(null)
    try {
      const result = await window.threadlineDesktop.syncWorkspace(root)
      if (result?.status) setStatus(result.status)
      else await refresh()

      if (result?.ok) {
        // Stamped only on a clean run, so the label can never be newer than
        // the last sync that actually completed.
        const now = new Date().toISOString()
        setLastSync(now)
        try {
          localStorage.setItem(LAST_SYNC_PREFIX + root, now)
        } catch {
          /* noop */
        }
      } else {
        setError(result?.reason || 'push-failed')
        setDetail(result?.detail || null)
        // Loud failure in the devtools console too — the footer can only ever
        // show one short line, but the console shows git's full output.
        console.error('[threadline sync]', result?.reason, result?.detail || '')
      }
    } finally {
      setSyncing(false)
    }
  }, [root, syncing, refresh])

  return { status, lastSync, syncing, error, detail, sync, refresh }
}
