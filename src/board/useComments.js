// useComments — the comment panel's data layer, alongside useThreadlineSync's
// for the tree. Two lists, fetched from two places on purpose:
//
//   storyThreads — the open story's threads, read straight from its markdown
//                  file. These drive the editor highlights, so they have to
//                  match what's on disk exactly (anchors included).
//   repoThreads  — every thread in the workspace, served from the SQLite index
//                  (see the plugin's thread-index.js). Rows carry a `preview`
//                  instead of full comment bodies, which is all the
//                  cross-story lists render.
//
// The "For You" tab asks the index to do the mention filtering, because that's
// the one filter that has to look inside comment bodies. Status and story
// scope are applied in the panel — they're plain field comparisons on data
// already in hand, so they don't need a round trip per dropdown change.

import { useCallback, useEffect, useMemo, useState } from 'react'

const API = '/api/threadline'

export function useComments({ root, storyId, userEmail, apiBase = API }) {
  const [storyThreads, setStoryThreads] = useState([])
  const [repoThreads, setRepoThreads] = useState([])
  const [users, setUsers] = useState([])
  const [error, setError] = useState(null)
  // Only the mention filter is server-side, so it's the only one that has to
  // trigger a refetch.
  const [mentionsOnly, setMentionsOnly] = useState(false)

  const api = useCallback(
    async (method, path, body) => {
      const opts = { method, headers: { 'Content-Type': 'application/json' } }
      if (root) opts.headers['x-threadline-root'] = encodeURIComponent(root)
      if (body !== undefined) opts.body = JSON.stringify(body)
      const res = await fetch(`${apiBase}${path}`, opts)
      const payload = await res.json().catch(() => ({}))
      // The API distinguishes "you can't do that" (403 on the author-only
      // delete) from a server fault, and the panel shows the message — so
      // carry it rather than collapsing every failure into one string.
      if (!res.ok) throw new Error(payload.error || `Request failed: ${res.status}`)
      return payload
    },
    [apiBase, root],
  )

  const fetchStoryThreads = useCallback(async () => {
    if (!root || !storyId) {
      setStoryThreads([])
      return
    }
    try {
      const { data } = await api('GET', `/comments?story_id=${encodeURIComponent(storyId)}`)
      setStoryThreads(data || [])
    } catch {
      setStoryThreads([])
    }
  }, [api, root, storyId])

  const fetchRepoThreads = useCallback(async () => {
    if (!root) {
      setRepoThreads([])
      return
    }
    try {
      const query = mentionsOnly && userEmail ? `?mentions=${encodeURIComponent(userEmail)}` : ''
      const { data } = await api('GET', `/comments${query}`)
      setRepoThreads(data || [])
    } catch {
      setRepoThreads([])
    }
  }, [api, root, mentionsOnly, userEmail])

  const refresh = useCallback(async () => {
    await Promise.all([fetchStoryThreads(), fetchRepoThreads()])
  }, [fetchStoryThreads, fetchRepoThreads])

  useEffect(() => {
    fetchStoryThreads()
  }, [fetchStoryThreads])

  useEffect(() => {
    fetchRepoThreads()
  }, [fetchRepoThreads])

  // The mention typeahead's candidate list: every user this install has seen.
  useEffect(() => {
    if (!root) return
    let cancelled = false
    api('GET', '/users')
      .then(({ data }) => {
        if (!cancelled) setUsers(data || [])
      })
      .catch(() => {
        if (!cancelled) setUsers([])
      })
    return () => {
      cancelled = true
    }
  }, [api, root])

  const actions = useMemo(() => {
    // Every mutation refreshes both lists: a new thread changes the story's
    // highlights AND the repo-wide counts.
    const run = async (fn) => {
      setError(null)
      try {
        const result = await fn()
        await Promise.all([fetchStoryThreads(), fetchRepoThreads()])
        return result
      } catch (err) {
        setError(String(err.message || err))
        return null
      }
    }

    return {
      // `anchor` is null for a story-level comment (the panel's "+ New"),
      // or a text-quote selector when the user commented on a selection.
      createThread({ storyId: target, caseName, anchor, body }) {
        return run(async () => {
          const { data } = await api('POST', '/comments', {
            story_id: target,
            case_name: caseName || '',
            anchor: anchor || null,
            author: userEmail,
            body,
          })
          return data
        })
      },

      addReply({ storyId: target, threadId, body }) {
        return run(async () => {
          const { data } = await api('POST', `/comments/${encodeURIComponent(threadId)}/replies`, {
            story_id: target,
            author: userEmail,
            body,
          })
          return data
        })
      },

      setStatus({ storyId: target, threadId, status }) {
        return run(async () => {
          const { data } = await api('PUT', `/comments/${encodeURIComponent(threadId)}`, {
            story_id: target,
            status,
            author: userEmail,
          })
          return data
        })
      },

      // Refused with a 403 unless the requester opened the thread — the panel
      // only offers this on the user's own threads, but the rule is the API's.
      deleteThread({ storyId: target, threadId }) {
        return run(() =>
          api(
            'DELETE',
            `/comments/${encodeURIComponent(threadId)}?story_id=${encodeURIComponent(target)}&requester=${encodeURIComponent(userEmail)}`,
          ),
        )
      },

      clearError() {
        setError(null)
      },
    }
  }, [api, fetchStoryThreads, fetchRepoThreads, userEmail])

  return { storyThreads, repoThreads, users, error, actions, refresh, setMentionsOnly }
}
