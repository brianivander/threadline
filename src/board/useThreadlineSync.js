// useThreadlineSync — the board's data layer. Fetches the hierarchy from the
// Threadline API and exposes one action per mutation, refetching the tree
// after each. Nothing here renders; the board is a pure consumer.
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

import { useCallback, useEffect, useMemo, useState } from 'react'

const API = '/api/threadline'

export function workspaceNameOf(root) {
  if (!root) return ''
  const parts = String(root).split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || root
}

export function useThreadlineSync({ root, apiBase = API, onChange, onFileIdChange }) {
  const [tree, setTree] = useState([])

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

  const fetchTree = useCallback(async () => {
    if (!root) {
      setTree([])
      return
    }
    try {
      const { data } = await api('GET', '/tree')
      setTree(data)
    } catch {
      setTree([])
    }
  }, [api, root])

  // Fetch on mount and whenever the workspace root changes.
  useEffect(() => {
    fetchTree()
  }, [fetchTree])

  const actions = useMemo(() => {
    const id = (raw) => encodeURIComponent(raw)
    const thenRefetch = async (promise) => {
      try {
        await promise
        await fetchTree()
        onChange && onChange()
      } catch {
        /* noop */
      }
    }

    return {
      async updateStory({ storyId, field, value }) {
        try {
          const { data: updated } = await api('PUT', `/files/${id(storyId)}`, { [field]: value })
          // A title change renames the file, and the id IS the path — so a
          // stale selection would blank the panel out. Re-point it before the
          // tree arrives.
          if (updated?.id && updated.id !== storyId) onFileIdChange && onFileIdChange(storyId, updated.id)
          await fetchTree()
          onChange && onChange()
        } catch {
          /* noop */
        }
      },

      updateCase({ caseId, body }) {
        return thenRefetch(api('PUT', `/cases/${id(caseId)}`, { body }))
      },

      // Empty name — the tab shows "Case N" until the user renames it.
      addCase({ storyId }) {
        return thenRefetch(api('POST', '/cases', { story_id: storyId, name: '', body: '' }))
      },

      renameCase({ caseId, name }) {
        return thenRefetch(api('PUT', `/cases/${id(caseId)}`, { name }))
      },

      deleteCase({ caseId }) {
        return thenRefetch(api('DELETE', `/cases/${id(caseId)}`))
      },

      async duplicateCase({ caseId }) {
        try {
          const { data: c } = await api('GET', `/cases/${id(caseId)}`)
          await api('POST', '/cases', {
            story_id: c.story_id,
            name: c.name ? `${c.name} (copy)` : '',
            body: c.body,
          })
          await fetchTree()
          onChange && onChange()
        } catch {
          /* noop */
        }
      },

      deleteStory({ storyId }) {
        return thenRefetch(api('DELETE', `/files/${id(storyId)}`))
      },

      deleteNode({ nodeType, nodeId }) {
        const endpoint = nodeType === 'folder' ? 'folders' : 'files'
        return thenRefetch(api('DELETE', `/${endpoint}/${id(nodeId)}`))
      },

      async renameNode({ nodeId, nodeType, name }) {
        // Folders rename by `name`; files rename by `title` (the filename IS
        // the title — see repo.js's updateFile).
        const endpoint = nodeType === 'folder' ? 'folders' : 'files'
        const payload = nodeType === 'folder' ? { name } : { title: name }
        try {
          const { data: updated } = await api('PUT', `/${endpoint}/${id(nodeId)}`, payload)
          if (nodeType === 'file' && updated?.id && updated.id !== nodeId) {
            onFileIdChange && onFileIdChange(nodeId, updated.id)
          }
          await fetchTree()
          onChange && onChange()
        } catch {
          /* noop */
        }
      },

      moveNode({ nodeType, nodeId, newParentId }) {
        return thenRefetch(api('POST', '/move', { nodeType, id: nodeId, newParentId }))
      },

      reorderCase({ storyId, orderedIds }) {
        return thenRefetch(api('POST', '/reorder', { storyId, orderedIds }))
      },

      addNode({ nodeType, parentId }) {
        if (nodeType === 'folder') {
          return thenRefetch(api('POST', '/folders', { parent_id: parentId, name: 'Untitled folder' }))
        }
        return thenRefetch(api('POST', '/files', { parent_id: parentId, title: 'Untitled file' }))
      },

      duplicateNode({ nodeType, nodeId }) {
        return thenRefetch(api('POST', '/duplicate', { nodeType, id: nodeId }))
      },
    }
  }, [api, fetchTree, onChange, onFileIdChange])

  return { tree, setTree, refetch: fetchTree, actions }
}
