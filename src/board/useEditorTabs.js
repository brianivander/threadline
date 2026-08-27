// The editor column's open tabs.
//
// One tab per file the user has opened in the column, in the order they opened
// them. A tab is identified by the file's ABSOLUTE path, not by its
// workspace-relative id: a story link can point at a document outside the
// workspace entirely (a TRD in a sibling repo), which has no id — see
// DocPanel. Files inside the workspace carry their id too, because the story
// API is addressed by id.
//
// Only kinds the column can actually show get a tab: 'story', 'doc' and
// 'image'. An HTML page goes to the browser panel and never becomes a tab
// (Chromium is the renderer for those), and anything else can't be opened at
// all — Board handles both of those before calling open().
//
// Tabs deliberately do NOT survive a restart. The workspace opens with nothing
// in the column, the way the tree opens with nothing expanded.

import { useCallback, useMemo, useState } from 'react'

// Windows writes the same path with either separator, so comparison is
// normalized while the tab keeps the path it was given — that is the one the
// API and the <img> src have to use.
const SEPARATOR = String.fromCharCode(92)

function toSlashes(value) {
  return String(value || '').split(SEPARATOR).join('/')
}

function keyOf(path) {
  return toSlashes(path).toLowerCase()
}

export function useEditorTabs() {
  const [tabs, setTabs] = useState([])
  const [activeKey, setActiveKey] = useState(null)

  // Open a file, or focus it if it's already open. `file` is
  // { path, id, kind, title, ext } — path is required, id only for files that
  // live inside the workspace.
  const openTab = useCallback((file) => {
    if (!file?.path) return
    const key = keyOf(file.path)
    setTabs((current) => {
      const existing = current.findIndex((t) => t.key === key)
      // Reopening a file must refresh what we know about it — a story that has
      // been renamed arrives with a new id and title under the same path.
      if (existing !== -1) {
        const next = [...current]
        next[existing] = { ...next[existing], ...file, key }
        return next
      }
      return [...current, { ...file, key }]
    })
    setActiveKey(key)
  }, [])

  const activateTab = useCallback((key) => setActiveKey(key), [])

  // Closing the active tab moves to its right-hand neighbour, falling back to
  // the left — closing the last tab of a row shouldn't jump to the far end.
  const closeTab = useCallback((key) => {
    setTabs((current) => {
      const i = current.findIndex((t) => t.key === key)
      if (i === -1) return current
      const next = current.filter((t) => t.key !== key)
      setActiveKey((active) => {
        if (active !== key) return active
        const neighbour = next[i] || next[i - 1]
        return neighbour ? neighbour.key : null
      })
      return next
    })
  }, [])

  const closeAll = useCallback(() => {
    setTabs([])
    setActiveKey(null)
  }, [])

  // A rename changes both the id and the path, so the tab has to move with the
  // file rather than be left pointing at somewhere nothing lives.
  const repathTab = useCallback((oldPath, file) => {
    const oldKey = keyOf(oldPath)
    const newKey = keyOf(file?.path)
    if (!newKey) return
    setTabs((current) => current.map((t) => (t.key === oldKey ? { ...t, ...file, key: newKey } : t)))
    setActiveKey((active) => (active === oldKey ? newKey : active))
  }, [])

  // The file is gone — deleted, or moved somewhere this tab can't follow.
  const closeByPath = useCallback((path) => closeTab(keyOf(path)), [closeTab])

  // A folder was deleted, so everything open from inside it is gone too.
  const closeUnderPath = useCallback((path) => {
    const prefix = keyOf(path)
    setTabs((current) => {
      const doomed = current.filter((t) => t.key === prefix || t.key.startsWith(prefix + '/'))
      if (!doomed.length) return current
      const next = current.filter((t) => !doomed.includes(t))
      setActiveKey((active) => (doomed.some((t) => t.key === active) ? next[next.length - 1]?.key ?? null : active))
      return next
    })
  }, [])

  // A folder was renamed or moved. Its files are the same files at new paths,
  // so the tabs follow rather than being closed — the alternative is a rename
  // silently emptying the column.
  const repathUnder = useCallback((oldPath, newPath) => {
    const from = keyOf(oldPath)
    const to = newPath
    setTabs((current) =>
      current.map((t) => {
        if (t.key !== from && !t.key.startsWith(from + '/')) return t
        const moved = to + toSlashes(t.path).slice(toSlashes(oldPath).length)
        return { ...t, path: moved, key: keyOf(moved) }
      }),
    )
    setActiveKey((active) => {
      if (!active) return active
      if (active !== from && !active.startsWith(from + '/')) return active
      return keyOf(to + active.slice(from.length))
    })
  }, [])

  const activeTab = useMemo(() => tabs.find((t) => t.key === activeKey) || null, [tabs, activeKey])

  return {
    tabs,
    activeTab,
    activeKey,
    openTab,
    activateTab,
    closeTab,
    closeAll,
    closeByPath,
    closeUnderPath,
    repathTab,
    repathUnder,
  }
}
