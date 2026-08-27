import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import BrowserPanel from '@/panels/BrowserPanel'
import Board from '@/board/Board'
import { useThreadlineSync, workspaceNameOf } from '@/board/useThreadlineSync'
import { useEditorTabs } from '@/board/useEditorTabs'
import {
  fromFileUrl,
  isLocalMarkdownUrl,
  resolveLocalLink,
  storyDirOf,
  workspaceIdOf,
  workspacePathOf,
} from '@/lib/paths'

const LAST_WORKSPACE_KEY = 'threadline_last_workspace'
const BROWSER_OPEN_KEY = 'threadline_browser_open'
const isElectron = typeof window !== 'undefined' && !!window.threadlineDesktop?.isElectron

// A file's display name: its filename with the extension taken off, matching
// what the repo does for a tree row. Used for tabs opened by absolute path,
// where there is no node to take a title from.
function titleOf(absPath) {
  const base = String(absPath || '').split(/[\\/]/).pop() || ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

export default function App() {
  const browserRef = useRef(null)
  const [root, setRoot] = useState(() => {
    try {
      return localStorage.getItem(LAST_WORKSPACE_KEY) || ''
    } catch {
      return ''
    }
  })
  const [browserOpen, setBrowserOpen] = useState(() => {
    try {
      return localStorage.getItem(BROWSER_OPEN_KEY) !== '0'
    } catch {
      return true
    }
  })
  const [userEmail, setUserEmail] = useState('')

  // The editor column's open files. Tabs replaced the old pair of "the
  // selected story" and "the open document": those were two mutually exclusive
  // slots, so opening a PRD closed the story you were reading it for.
  const editor = useEditorTabs()
  const { tabs, activeTab, openTab, closeUnderPath, repathTab, repathUnder } = editor

  // The story being edited, when that's what's in front. Everything keyed on a
  // story — its cases, its comment threads, the folder its relative links
  // resolve against — follows the active tab rather than a separate selection.
  const selectedStoryId = useMemo(() => (activeTab?.kind === 'story' ? activeTab.id : null), [activeTab])

  // Renaming a file (or editing a story title — the filename IS the title)
  // changes its id, and the id is the path. A tab left pointing at the old one
  // would show a file that is no longer there, so it moves with the file.
  const onFileIdChange = useCallback(
    (oldId, newId) => {
      const newPath = workspacePathOf(root, newId)
      repathTab(workspacePathOf(root, oldId), { path: newPath, id: newId, title: titleOf(newPath) })
    },
    [root, repathTab],
  )

  // A folder rename or move takes its whole subtree with it, so any tab opened
  // from inside it has to follow rather than be left pointing at a path that
  // no longer exists.
  const onFolderRepath = useCallback(
    (oldId, newId) => repathUnder(workspacePathOf(root, oldId), workspacePathOf(root, newId)),
    [repathUnder, root],
  )

  const {
    rootNodes,
    childrenOf,
    nodesById,
    expanded,
    loading,
    toggleNode,
    expandNode,
    revealNode,
    query,
    setQuery,
    results,
    searching,
    cases,
    setCases,
    actions,
  } = useThreadlineSync({ root, storyId: selectedStoryId, onFileIdChange, onFolderRepath })

  // Auto-detect the current user from the workspace's git config (no login)
  // and register them in threadline.db on first sight — see main.cjs's
  // 'threadline:get-user' handler. Re-resolves whenever the workspace changes,
  // so each repo reports the identity its own git config has.
  useEffect(() => {
    if (!isElectron) return
    window.threadlineDesktop.getCurrentUserEmail(root || undefined).then((email) => {
      if (email) setUserEmail(email)
    })
  }, [root])

  const setBrowser = useCallback((open) => {
    setBrowserOpen(open)
    try {
      localStorage.setItem(BROWSER_OPEN_KEY, open ? '1' : '0')
    } catch {
      /* noop */
    }
  }, [])

  const toggleBrowser = useCallback(() => setBrowser(!browserOpen), [browserOpen, setBrowser])

  // Open a markdown document by absolute path — a story link's target, which
  // may resolve outside the workspace entirely and so has no id. Inside the
  // workspace it gets its id too, so a rename can follow it.
  const openDoc = useCallback(
    (absPath) => {
      if (!absPath) return
      openTab({ path: absPath, id: workspaceIdOf(root, absPath) || null, kind: 'doc', title: titleOf(absPath) })
    },
    [openTab, root],
  )

  // A link can be a web URL or a filesystem path; relative paths resolve
  // against the selected story's folder first.
  //
  // Where it opens depends on what it is. A local markdown file becomes a tab,
  // because it's a document to read and edit and the browser would only show it
  // as raw text. Everything else — HTML, Figma, anything external — goes to the
  // browser, which is always revealed on the way: a tab loading behind a
  // collapsed panel would look like nothing happened.
  const openLink = useCallback(
    (url) => {
      const resolved = resolveLocalLink(url, storyDirOf(root, selectedStoryId))
      if (isLocalMarkdownUrl(resolved)) {
        openDoc(fromFileUrl(resolved))
        return
      }
      setBrowser(true)
      browserRef.current?.openUrl(resolved)
    },
    [setBrowser, openDoc, root, selectedStoryId],
  )

  // The comments panel's "go to story" — the story may not be open, and may not
  // even be in a folder the tree has loaded.
  const openStoryById = useCallback(
    (storyId) => {
      if (!storyId) return
      const path = workspacePathOf(root, storyId)
      openTab({ path, id: storyId, kind: 'story', title: titleOf(path) })
    },
    [openTab, root],
  )

  // A deleted file's tab has nothing left to show — and a deleted folder takes
  // every tab opened from inside it with it.
  const onFileGone = useCallback((id) => closeUnderPath(workspacePathOf(root, id)), [closeUnderPath, root])

  async function handleOpenWorkspace() {
    if (!isElectron) {
      console.warn('Choosing a workspace folder requires the desktop app.')
      return
    }
    const chosen = await window.threadlineDesktop.chooseWorkspace()
    if (!chosen) return
    setRoot(chosen)
    // Another workspace's tabs point at another workspace's files.
    editor.closeAll()
    try {
      localStorage.setItem(LAST_WORKSPACE_KEY, chosen)
    } catch {
      /* noop */
    }
  }

  return (
    <Board
      rootNodes={rootNodes}
      childrenOf={childrenOf}
      nodesById={nodesById}
      expandedIds={expanded}
      loadingIds={loading}
      onToggleNode={toggleNode}
      onExpandNode={expandNode}
      onRevealNode={revealNode}
      searchQuery={query}
      onSearchQueryChange={setQuery}
      searchResults={results}
      searching={searching}
      cases={cases}
      setCases={setCases}
      actions={actions}
      root={root}
      tabs={tabs}
      activeTab={activeTab}
      onOpenTab={openTab}
      onActivateTab={editor.activateTab}
      onCloseTab={editor.closeTab}
      onFileGone={onFileGone}
      selectedStoryId={selectedStoryId}
      onSelectStory={openStoryById}
      workspaceName={workspaceNameOf(root)}
      userEmail={userEmail}
      onUserEmailChange={setUserEmail}
      onOpenWorkspace={handleOpenWorkspace}
      onOpenLink={openLink}
      browser={<BrowserPanel ref={browserRef} />}
      browserOpen={browserOpen}
      onToggleBrowser={toggleBrowser}
      onBrowserOpenChange={setBrowser}
    />
  )
}
