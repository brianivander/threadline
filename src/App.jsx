import { useCallback, useEffect, useRef, useState } from 'react'

import EmbedViewer from '@/components/EmbedViewer'
import Board from '@/board/Board'
import ThreadlinePanel from '@/board/ThreadlinePanel'
import { useThreadlineSync, workspaceNameOf } from '@/board/useThreadlineSync'

const LAST_WORKSPACE_KEY = 'threadline_last_workspace'
const BROWSER_OPEN_KEY = 'threadline_browser_open'
const isElectron = typeof window !== 'undefined' && !!window.threadlineDesktop?.isElectron

export default function App() {
  const embedViewerRef = useRef(null)
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
  const [selectedStoryId, setSelectedStoryId] = useState(null)

  // Renaming a file (or editing a story title — the filename IS the title)
  // changes its id, so a selection pointing at the old path would blank the
  // panel out.
  const onFileIdChange = useCallback((oldId, newId) => {
    setSelectedStoryId((current) => (current === oldId ? newId : current))
  }, [])

  const { tree, setTree, actions } = useThreadlineSync({ root, onFileIdChange })

  // Auto-detect the current user from git config (no login) and register
  // them in threadline.db on first sight — see main.cjs's
  // 'threadline:get-user' handler.
  useEffect(() => {
    if (!isElectron) return
    window.threadlineDesktop.getCurrentUserEmail().then((email) => {
      if (email) setUserEmail(email)
    })
  }, [])

  const setBrowser = useCallback((open) => {
    setBrowserOpen(open)
    try {
      localStorage.setItem(BROWSER_OPEN_KEY, open ? '1' : '0')
    } catch {
      /* noop */
    }
  }, [])

  const toggleBrowser = useCallback(() => setBrowser(!browserOpen), [browserOpen, setBrowser])

  // Opening a link always reveals the browser — a tab loading behind a
  // collapsed panel would look like nothing happened.
  const openLink = useCallback(
    (url) => {
      setBrowser(true)
      embedViewerRef.current?.openUrl(url)
    },
    [setBrowser],
  )

  async function handleOpenWorkspace() {
    if (!isElectron) {
      console.warn('Choosing a workspace folder requires the desktop app.')
      return
    }
    const chosen = await window.threadlineDesktop.chooseWorkspace()
    if (!chosen) return
    setRoot(chosen)
    setSelectedStoryId(null)
    try {
      localStorage.setItem(LAST_WORKSPACE_KEY, chosen)
    } catch {
      /* noop */
    }
  }

  return (
    <ThreadlinePanel
      browserOpen={browserOpen}
      onBrowserOpenChange={setBrowser}
      board={
        <Board
          tree={tree}
          setTree={setTree}
          actions={actions}
          root={root}
          selectedStoryId={selectedStoryId}
          onSelectStory={setSelectedStoryId}
          workspaceName={workspaceNameOf(root)}
          userEmail={userEmail}
          onOpenWorkspace={handleOpenWorkspace}
          onOpenLink={openLink}
          browserOpen={browserOpen}
          onToggleBrowser={toggleBrowser}
        />
      }
    >
      <EmbedViewer ref={embedViewerRef} />
    </ThreadlinePanel>
  )
}
