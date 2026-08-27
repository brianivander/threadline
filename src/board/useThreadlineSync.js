// useThreadlineSync — the board's data layer. Holds the workspace tree one
// folder level at a time and exposes one action per mutation.
//
// The tree is LAZY. `GET /tree` returns a single level (the root, or one
// folder's children); a folder's contents are fetched when the user expands it
// and not before. A workspace with nine thousand directories used to arrive as
// one two-megabyte payload of eleven thousand nodes, every one of them mounted
// as a row — which is what made a large repository hang on open. Levels are
// cached here by parent id (the root under ''), so a folder that has already
// been opened re-renders without another request.
//
// Because there is no single tree object any more, a mutation refreshes only
// the level(s) it touched — the parent a node was created in, the two parents a
// move spans — instead of refetching the whole workspace after every keystroke.
//
// Folders open COLLAPSED. Which ones the user had open is remembered per
// workspace (ids are workspace-relative, so one global list would reopen repo
// A's paths inside repo B) and reopened on the next visit, parents before
// children so each level exists before its children are asked for.
//
// `root` is the open workspace folder (an absolute path chosen by the host
// app, e.g. via an Electron directory dialog). It travels on every request as
// an `x-threadline-root` header, URI-encoded (paths can contain characters a
// raw header value shouldn't) — @threadline/vite-plugin decodes it the same
// way. With no root set, no request is made and the tree stays empty.
//
// IDs are workspace-relative paths and may themselves contain '/' (e.g.
// 'project1/feature1/login.md'), so every id placed in a URL path segment is
// encodeURIComponent()'d — the plugin decodes the whole segment back in one
// step, recovering the internal slashes intact.
//
// Renaming a file (or editing a story title — the filename IS the title)
// changes its id, so the caller's selection would point at a path that no
// longer exists. `onFileIdChange(oldId, newId)` fires for exactly those cases.
// Renaming or moving a FOLDER re-paths everything beneath it, which invalidates
// cached levels and remembered expansions wholesale — see repath().

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const API = '/api/threadline'

// Level key for the workspace root. Real ids are non-empty paths, so '' can
// never collide with one.
const ROOT = ''

export function workspaceNameOf(root) {
  if (!root) return ''
  const parts = String(root).split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || root
}

function expandedKey(root) {
  return `threadline_expanded_nodes:${root || ''}`
}

function loadExpanded(root) {
  try {
    const arr = JSON.parse(localStorage.getItem(expandedKey(root)))
    return Array.isArray(arr) ? new Set(arr) : new Set()
  } catch {
    return new Set()
  }
}

function saveExpanded(root, ids) {
  try {
    localStorage.setItem(expandedKey(root), JSON.stringify([...ids]))
  } catch {
    /* noop */
  }
}

// The level a node lives in: 'a/b/c.md' -> 'a/b', 'c.md' -> ROOT.
function parentOf(id) {
  const s = String(id || '')
  const i = s.lastIndexOf('/')
  return i === -1 ? ROOT : s.slice(0, i)
}

// Shallowest first, so 'a' is restored before 'a/b' before 'a/b/c'.
function shallowestFirst(ids) {
  return [...ids].sort((a, b) => a.split('/').length - b.split('/').length)
}

export function useThreadlineSync({
  root,
  storyId = null,
  apiBase = API,
  onChange,
  onFileIdChange,
  // Fires when a folder rename or move re-paths everything beneath it. A file
  // id change is reported one at a time through onFileIdChange; this is the
  // wholesale case, where the caller has to move a whole subtree at once.
  onFolderRepath,
}) {
  // One entry per fetched level, keyed by parent id. A missing key means "not
  // loaded yet"; an empty array means "loaded, and empty".
  const [levels, setLevels] = useState({})
  const [expanded, setExpanded] = useState(() => new Set())
  // Levels with a request in flight, so a row can show that it is opening.
  const [loading, setLoading] = useState(() => new Set())
  // The open story's cases. They don't travel with the tree (see repo.js's
  // listChildren): only the selected story's are ever read.
  const [cases, setCases] = useState([])
  // The sidebar's filename search. A collapsed tree hides everything the user
  // hasn't opened, so this is the way to reach a file by name.
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)

  // Mirrors of the two pieces of state that callbacks need to read without
  // being recreated every time they change.
  const levelsRef = useRef({})
  const expandedRef = useRef(new Set())
  // In-flight level requests, so expanding a folder twice fetches it once.
  const inFlight = useRef(new Map())

  const api = useCallback(
    async (method, path, body) => {
      const opts = { method, headers: { 'Content-Type': 'application/json' } }
      if (root) opts.headers['x-threadline-root'] = encodeURIComponent(root)
      if (body !== undefined) opts.body = JSON.stringify(body)
      const res = await fetch(`${apiBase}${path}`, opts)
      if (!res.ok) throw new Error(`API ${method} ${path} failed: ${res.status}`)
      return res.json()
    },
    [apiBase, root],
  )

  const putLevel = useCallback((key, nodes) => {
    levelsRef.current = { ...levelsRef.current, [key]: nodes }
    setLevels(levelsRef.current)
  }, [])

  const putExpanded = useCallback(
    (next) => {
      expandedRef.current = next
      setExpanded(next)
      saveExpanded(root, next)
    },
    [root],
  )

  // Fetch one level. Concurrent calls for the same level share one request;
  // `force` refreshes a level that is already cached.
  const loadLevel = useCallback(
    (parentId, { force = false } = {}) => {
      if (!root) return Promise.resolve([])
      const key = parentId || ROOT
      const pending = inFlight.current.get(key)
      if (pending && !force) return pending

      const request = (async () => {
        setLoading((cur) => new Set(cur).add(key))
        try {
          const qs = key === ROOT ? '' : `?parent_id=${encodeURIComponent(key)}`
          const { data } = await api('GET', `/tree${qs}`)
          const nodes = data || []
          putLevel(key, nodes)
          return nodes
        } catch {
          putLevel(key, [])
          return []
        } finally {
          setLoading((cur) => {
            const next = new Set(cur)
            next.delete(key)
            return next
          })
          if (inFlight.current.get(key) === request) inFlight.current.delete(key)
        }
      })()

      inFlight.current.set(key, request)
      return request
    },
    [root, api, putLevel],
  )

  // Load a level only if it isn't cached — what expanding a folder needs.
  const ensureLevel = useCallback(
    (parentId) => {
      const key = parentId || ROOT
      const cached = levelsRef.current[key]
      return cached ? Promise.resolve(cached) : loadLevel(key)
    },
    [loadLevel],
  )

  // Refresh the given levels, skipping any that were never loaded — nothing on
  // screen depends on them, so there is nothing to be out of date.
  const reloadLevels = useCallback(
    (parentIds) => {
      const keys = [...new Set(parentIds.map((p) => p || ROOT))].filter(
        (key) => key === ROOT || key in levelsRef.current,
      )
      return Promise.all(keys.map((key) => loadLevel(key, { force: true })))
    },
    [loadLevel],
  )

  // Re-read every level currently on screen. Unlike reloadLevels, this takes no
  // ids: it is for the case where the files changed underneath us and we have
  // no idea which ones — a git pull bringing a teammate's work down. Levels
  // that were never opened are left alone; they'll be fetched fresh when they
  // are, so there is nothing stale to correct.
  const reloadAll = useCallback(() => {
    const keys = Object.keys(levelsRef.current)
    if (!keys.includes(ROOT)) keys.push(ROOT)
    return Promise.all(keys.map((key) => loadLevel(key, { force: true })))
  }, [loadLevel])

  // Forget every cached level at or under `id` — the folder is gone.
  const forget = useCallback((id) => {
    const under = (key) => key === id || key.startsWith(`${id}/`)
    const next = {}
    for (const [key, nodes] of Object.entries(levelsRef.current)) if (!under(key)) next[key] = nodes
    levelsRef.current = next
    setLevels(next)
  }, [])

  // A folder was renamed or moved, so every path beneath it changed. Drop the
  // stale levels and carry the expansions over to the new prefix, so a subtree
  // the user had open stays open where it landed.
  const repath = useCallback(
    (oldId, newId) => {
      const under = (key) => key === oldId || key.startsWith(`${oldId}/`)
      const moved = (key) => `${newId}${key.slice(oldId.length)}`

      const nextLevels = {}
      for (const [key, nodes] of Object.entries(levelsRef.current)) if (!under(key)) nextLevels[key] = nodes
      levelsRef.current = nextLevels
      setLevels(nextLevels)

      const nextExpanded = new Set()
      for (const id of expandedRef.current) nextExpanded.add(under(id) ? moved(id) : id)
      putExpanded(nextExpanded)

      onFolderRepath && onFolderRepath(oldId, newId)
    },
    [putExpanded, onFolderRepath],
  )

  // ---- opening a workspace ---------------------------------------------------

  // A new root is a different tree entirely: drop everything, load the root
  // level, then reopen whatever was open last time.
  useEffect(() => {
    levelsRef.current = {}
    inFlight.current.clear()
    setLevels({})
    setCases([])

    const remembered = loadExpanded(root)
    expandedRef.current = remembered
    setExpanded(remembered)
    if (!root) return undefined

    let cancelled = false

    const restore = async () => {
      await loadLevel(ROOT, { force: true })
      for (const id of shallowestFirst(remembered)) {
        if (cancelled) return
        // Its parent has loaded by now, so a remembered folder that is no
        // longer there is skipped rather than fetched.
        if (levelsRef.current[parentOf(id)]?.some((n) => n.id === id)) await loadLevel(id, { force: true })
      }
      if (cancelled) return
      // Drop the ones that turned out not to exist, so they aren't retried on
      // every future open.
      const alive = new Set(
        Object.values(levelsRef.current)
          .flat()
          .map((n) => n.id),
      )
      if ([...remembered].some((id) => !alive.has(id))) {
        putExpanded(new Set([...remembered].filter((id) => alive.has(id))))
      }
    }
    restore()

    return () => {
      cancelled = true
    }
  }, [root, loadLevel, putExpanded])

  // ---- expansion ------------------------------------------------------------

  const toggleNode = useCallback(
    (nodeId) => {
      if (!nodeId) return
      const isOpen = expandedRef.current.has(nodeId)
      const next = new Set(expandedRef.current)
      if (isOpen) next.delete(nodeId)
      else next.add(nodeId)
      putExpanded(next)
      // Collapsing keeps the cached level, so reopening it is instant.
      if (!isOpen) ensureLevel(nodeId)
    },
    [putExpanded, ensureLevel],
  )

  // Open a folder that may already be open — used after adding or moving a
  // node into it, so the user sees where it landed.
  const expandNode = useCallback(
    (nodeId) => {
      if (!nodeId || expandedRef.current.has(nodeId)) return
      putExpanded(new Set(expandedRef.current).add(nodeId))
      ensureLevel(nodeId)
    },
    [putExpanded, ensureLevel],
  )

  // Open every folder above `id`, loading each level on the way down, so a file
  // reached by search is visible in the tree rather than merely selected.
  const revealNode = useCallback(
    async (id) => {
      const parts = String(id || '').split('/')
      // The last segment is the node itself, not a folder to open.
      parts.pop()
      if (!parts.length) return
      const ancestors = parts.map((_, i) => parts.slice(0, i + 1).join('/'))
      putExpanded(new Set([...expandedRef.current, ...ancestors]))
      // Shallowest first: a level can only be fetched once its parent is known.
      for (const ancestor of ancestors) await ensureLevel(ancestor)
    },
    [putExpanded, ensureLevel],
  )

  // ---- search ---------------------------------------------------------------

  // Debounced, and guarded against an earlier request landing after a later
  // one — the results would otherwise flicker back to a stale query's answer.
  useEffect(() => {
    const q = query.trim()
    if (!root || !q) {
      setResults([])
      setSearching(false)
      return undefined
    }
    let cancelled = false
    setSearching(true)
    const timer = setTimeout(async () => {
      try {
        const { data } = await api('GET', `/search?q=${encodeURIComponent(q)}`)
        if (!cancelled) setResults(data || [])
      } catch {
        if (!cancelled) setResults([])
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [root, api, query])

  // A different workspace's results mean nothing here.
  useEffect(() => {
    setQuery('')
  }, [root])

  // ---- cases ----------------------------------------------------------------

  const fetchCases = useCallback(async () => {
    if (!root || !storyId) {
      setCases([])
      return
    }
    try {
      const { data } = await api('GET', `/cases?story_id=${encodeURIComponent(storyId)}`)
      setCases(data || [])
    } catch {
      setCases([])
    }
  }, [api, root, storyId])

  // Re-fetch whenever the selection moves to another story — including the
  // rename case, where the id itself changes under the same story.
  useEffect(() => {
    fetchCases()
  }, [fetchCases])

  // ---- lookups --------------------------------------------------------------

  // Every node currently loaded, by id. A selection can only point at a node
  // the user has seen, so this covers the ones that matter.
  const nodesById = useMemo(() => {
    const out = {}
    for (const nodes of Object.values(levels)) for (const node of nodes) out[node.id] = node
    return out
  }, [levels])

  // undefined when the level hasn't been fetched — distinct from an empty
  // folder, so a row can tell "still opening" from "nothing inside".
  const childrenOf = useCallback((parentId) => levels[parentId || ROOT], [levels])

  const actions = useMemo(() => {
    const seg = (raw) => encodeURIComponent(raw)

    // Await the mutation, refresh the levels it touched, then notify.
    const thenReload = async (promise, parents) => {
      try {
        const result = await promise
        await reloadLevels(parents)
        onChange && onChange()
        return result
      } catch {
        return null
      }
    }

    // A case mutation changes nothing the tree displays — cases are not part
    // of its payload — so re-reading the open story's cases IS the whole
    // update. Refreshing a level here would be work for nothing.
    const thenCases = async (promise) => {
      try {
        await promise
        await fetchCases()
        onChange && onChange()
      } catch {
        /* noop */
      }
    }

    return {
      async updateStory({ storyId: id, field, value }) {
        try {
          const { data: updated } = await api('PUT', `/files/${seg(id)}`, { [field]: value })
          // A title change renames the file, and the id IS the path — so a
          // stale selection would blank the panel out. Re-point it before the
          // level arrives.
          if (updated?.id && updated.id !== id) onFileIdChange && onFileIdChange(id, updated.id)
          await reloadLevels([parentOf(id)])
          onChange && onChange()
        } catch {
          /* noop */
        }
      },

      updateCase({ caseId, body }) {
        return thenCases(api('PUT', `/cases/${seg(caseId)}`, { body }))
      },

      // Empty name — the tab shows "Case N" until the user renames it.
      addCase({ storyId: id }) {
        return thenCases(api('POST', '/cases', { story_id: id, name: '', body: '' }))
      },

      renameCase({ caseId, name }) {
        return thenCases(api('PUT', `/cases/${seg(caseId)}`, { name }))
      },

      deleteCase({ caseId }) {
        return thenCases(api('DELETE', `/cases/${seg(caseId)}`))
      },

      async duplicateCase({ caseId }) {
        try {
          const { data: c } = await api('GET', `/cases/${seg(caseId)}`)
          await api('POST', '/cases', {
            story_id: c.story_id,
            name: c.name ? `${c.name} (copy)` : '',
            body: c.body,
          })
          await fetchCases()
          onChange && onChange()
        } catch {
          /* noop */
        }
      },

      deleteStory({ storyId: id }) {
        return thenReload(api('DELETE', `/files/${seg(id)}`), [parentOf(id)])
      },

      deleteNode({ nodeType, nodeId }) {
        const endpoint = nodeType === 'folder' ? 'folders' : 'files'
        // A deleted folder takes its whole cached subtree with it.
        if (nodeType === 'folder') forget(nodeId)
        return thenReload(api('DELETE', `/${endpoint}/${seg(nodeId)}`), [parentOf(nodeId)])
      },

      async renameNode({ nodeId, nodeType, name }) {
        // Folders rename by `name`; files rename by `title` (the filename IS
        // the title — see repo.js's updateFile).
        const endpoint = nodeType === 'folder' ? 'folders' : 'files'
        const payload = nodeType === 'folder' ? { name } : { title: name }
        try {
          const { data: updated } = await api('PUT', `/${endpoint}/${seg(nodeId)}`, payload)
          if (updated?.id && updated.id !== nodeId) {
            if (nodeType === 'folder') repath(nodeId, updated.id)
            else onFileIdChange && onFileIdChange(nodeId, updated.id)
          }
          await reloadLevels([parentOf(nodeId)])
          onChange && onChange()
        } catch {
          /* noop */
        }
      },

      async moveNode({ nodeType, nodeId, newParentId }) {
        try {
          const { data: moved } = await api('POST', '/move', { nodeType, id: nodeId, newParentId })
          if (moved?.id && moved.id !== nodeId) {
            if (nodeType === 'folder') repath(nodeId, moved.id)
            else onFileIdChange && onFileIdChange(nodeId, moved.id)
          }
          // Show where it landed.
          expandNode(newParentId)
          await reloadLevels([parentOf(nodeId), newParentId])
          onChange && onChange()
        } catch {
          /* noop */
        }
      },

      reorderCase({ storyId: id, orderedIds }) {
        return thenCases(api('POST', '/reorder', { storyId: id, orderedIds }))
      },

      // `nodeType` is 'folder', 'file' (a story) or 'doc' (a plain markdown
      // file). The last two are both files; the kind rides along so the repo
      // knows which extension to write.
      addNode({ nodeType, parentId }) {
        const endpoint = nodeType === 'folder' ? 'folders' : 'files'
        const body =
          nodeType === 'folder'
            ? { parent_id: parentId, name: 'Untitled folder' }
            : nodeType === 'doc'
              ? { parent_id: parentId, title: 'Untitled', kind: 'doc' }
              : { parent_id: parentId, title: 'Untitled file' }
        // Adding into a closed folder opens it, so the new node is visible.
        expandNode(parentId)
        return thenReload(api('POST', `/${endpoint}`, body), [parentId])
      },

      duplicateNode({ nodeType, nodeId }) {
        return thenReload(api('POST', '/duplicate', { nodeType, id: nodeId }), [parentOf(nodeId)])
      },
    }
  }, [api, reloadLevels, fetchCases, forget, repath, expandNode, onChange, onFileIdChange])

  return {
    rootNodes: levels[ROOT] || [],
    childrenOf,
    nodesById,
    expanded,
    loading,
    toggleNode,
    expandNode,
    revealNode,
    reloadLevels,
    reloadAll,
    query,
    setQuery,
    results,
    searching,
    cases,
    setCases,
    refetchCases: fetchCases,
    actions,
  }
}
