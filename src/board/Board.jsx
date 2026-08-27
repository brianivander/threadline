// The board: owner of all board-local state (selection, active case tab,
// pending confirmation) and of what each of the four panels shows. Folder
// expansion is NOT board state: it decides which levels get fetched, so it
// lives with the tree itself in useThreadlineSync. The panels themselves live in `src/panels`, arranged by PanelLayout.
// Persistence goes out through the `actions` object from useThreadlineSync.

import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { buttonVariants } from '@/components/ui/button'
import PanelLayout from '@/panels/PanelLayout'
import SidebarPanel from '@/panels/SidebarPanel'
import StoryPanel, { caseLabel } from '@/panels/StoryPanel'
import CommentsPanel from '@/panels/CommentsPanel'
import DocPanel from '@/panels/DocPanel'
import EditorBar from '@/panels/EditorBar'
import ImagePanel from '@/panels/ImagePanel'
import TextPanel from '@/panels/TextPanel'
import { useComments } from '@/board/useComments'
import { workspaceIdOf, workspacePathOf } from '@/lib/paths'
import { useWorkspaceSync } from '@/board/useWorkspaceSync'

const STORAGE_KEY_SIDEBAR_HIDDEN = 'threadline_sidebar_hidden'
const STORAGE_KEY_COMMENTS_OPEN = 'threadline_comments_open'

function loadSidebarHidden() {
  try {
    return localStorage.getItem(STORAGE_KEY_SIDEBAR_HIDDEN) === 'true'
  } catch {
    return false
  }
}

function loadCommentsOpen() {
  try {
    return localStorage.getItem(STORAGE_KEY_COMMENTS_OPEN) === 'true'
  } catch {
    return false
  }
}

// The auto-selection on open, so the story column has something in it. A doc
// or a page is skipped: opening one would put the workspace's first README in
// the editor while the story panel — the thing this app is for — never appears.
//
// Only the root level is considered. Descending to find a story would mean
// reading every folder in the workspace before the window could be drawn,
// which is exactly what the lazy tree exists to avoid — so a workspace whose
// stories all live in subfolders opens with nothing selected, as an editor
// does.
function findFirstStory(nodes) {
  return (nodes || []).find((node) => node.type === 'file' && node.kind === 'story') || null
}

// Every kind the editor column can show. A kind absent from here either goes
// somewhere else (pdf -> the browser) or can't be opened at all.
const TAB_KINDS = ['story', 'doc', 'image', 'text', 'page']

function dialogCopy(pending) {
  if (!pending) return { title: '', body: '' }
  const kind = pending.nodeType || 'item'
  const name = pending.name ? `"${pending.name}"` : ''
  const title = pending.action === 'duplicate' ? `Duplicate ${kind}?` : `Delete ${kind}?`

  if (kind === 'case') {
    return {
      title,
      body:
        pending.action === 'duplicate'
          ? `Create a copy of the case ${name}? Its content will be copied too.`
          : `Delete case ${name}? This cannot be undone.`,
    }
  }
  if (pending.action === 'duplicate') {
    return {
      title,
      body:
        kind === 'folder'
          ? `Create a copy of the folder ${name}? Everything inside it will be copied too.`
          : `Create a copy of the file ${name}? Its cases will be copied too.`,
    }
  }
  return {
    title,
    body:
      kind === 'folder'
        ? `Delete folder ${name}? This also deletes everything inside it. This cannot be undone.`
        : `Delete file ${name}? This also deletes its cases. This cannot be undone.`,
  }
}

export default function Board({
  rootNodes,
  childrenOf,
  nodesById,
  expandedIds,
  loadingIds,
  onToggleNode,
  onExpandNode,
  onRevealNode,
  searchQuery,
  onSearchQueryChange,
  searchResults,
  searching,
  cases,
  setCases,
  actions,
  root,
  tabs,
  activeTab,
  onOpenTab,
  onActivateTab,
  onCloseTab,
  onFileGone,
  selectedStoryId,
  onSelectStory,
  workspaceName,
  userEmail,
  onUserEmailChange,
  onOpenWorkspace,
  onOpenLink,
  browser,
  browserOpen,
  onToggleBrowser,
  onBrowserOpenChange,
}) {
  const [activeCaseIndex, setActiveCaseIndex] = useState(0)
  // A case name arrived with a story selection (from a comment) before that
  // story's cases had loaded — held here until they do. See selectStory.
  const [pendingCaseName, setPendingCaseName] = useState(null)
  const [sidebarHidden, setSidebarHidden] = useState(loadSidebarHidden)
  const [pendingAction, setPendingAction] = useState(null)
  // A file the column has no way to show — held so the dialog can name it.
  const [unopenable, setUnopenable] = useState(null)

  const [commentsOpen, setCommentsOpen] = useState(loadCommentsOpen)
  const [activeThreadId, setActiveThreadId] = useState(null)
  // A selection captured by the editor's right-click -> Comment, waiting for
  // the panel's composer to turn it into a thread.
  const [pendingAnchor, setPendingAnchor] = useState(null)

  const {
    storyThreads,
    repoThreads,
    users,
    error: commentError,
    actions: commentActions,
    mentionCount,
  } = useComments({ root, storyId: selectedStoryId, userEmail })

  const workspaceSync = useWorkspaceSync({ root })

  // A tree node carries metadata only — its cases come from their own fetch
  // (see useThreadlineSync). Re-attached here so every consumer below still
  // sees one whole story rather than two halves.
  const selectedStory = useMemo(() => {
    if (!selectedStoryId) return null
    const node = nodesById[selectedStoryId]
    return node ? { ...node, cases } : null
  }, [nodesById, selectedStoryId, cases])

  // Auto-select the top story once data arrives and nothing is selected.
  useEffect(() => {
    if (selectedStoryId) return
    const first = findFirstStory(rootNodes)
    if (first) {
      onSelectStory(first.id)
      setActiveCaseIndex(0)
    }
  }, [rootNodes, selectedStoryId, onSelectStory])

  // Place the tab a comment pointed at, once its story's cases have arrived.
  useEffect(() => {
    if (!pendingCaseName || cases.length === 0) return
    const index = cases.findIndex((c, i) => caseLabel(c, i) === pendingCaseName)
    if (index !== -1) setActiveCaseIndex(index)
    setPendingCaseName(null)
  }, [cases, pendingCaseName])

  function toggleComments() {
    setCommentsOpen((open) => {
      const next = !open
      if (!next) {
        setPendingAnchor(null)
        setActiveThreadId(null)
      }
      try {
        localStorage.setItem(STORAGE_KEY_COMMENTS_OPEN, String(next))
      } catch {
        /* noop */
      }
      return next
    })
  }

  const openCommentsPanel = useCallback(() => {
    setCommentsOpen(true)
    try {
      localStorage.setItem(STORAGE_KEY_COMMENTS_OPEN, 'true')
    } catch {
      /* noop */
    }
  }, [])

  // Right-click -> Comment in the editor: hold the selection and make sure the
  // panel is showing, so the composer it opens is actually visible.
  const requestComment = useCallback(
    ({ anchor, caseName }) => {
      if (!anchor) return
      setPendingAnchor({ anchor, caseName })
      openCommentsPanel()
    },
    [openCommentsPanel],
  )

  // Clicking a highlight in the editor: show the panel and focus that thread.
  const openThread = useCallback(
    (threadId) => {
      setActiveThreadId(threadId)
      openCommentsPanel()
    },
    [openCommentsPanel],
  )

  function toggleSidebar() {
    setSidebarHidden((hidden) => {
      const next = !hidden
      try {
        localStorage.setItem(STORAGE_KEY_SIDEBAR_HIDDEN, String(next))
      } catch {
        /* noop */
      }
      return next
    })
  }

  // `caseName` is optional: passed when arriving from a comment, so the tab
  // holding that comment's text is the one that opens. Landing on Case 1 when
  // the comment is anchored in another tab would show a story with no visible
  // highlight.
  function selectStory(storyId, caseName) {
    onSelectStory(storyId)
    // The new story's cases haven't been fetched yet, so the tab holding this
    // comment can't be resolved here — hold the name for the effect below.
    setPendingCaseName(caseName || null)
    setActiveCaseIndex(0)
    // A held selection belongs to the case we're leaving, and a focused thread
    // to the story we're leaving — neither means anything in the new one.
    setPendingAnchor(null)
    setActiveThreadId(null)
  }

  // Clicking a file, wherever it was clicked — the tree or a search result.
  // What happens is decided by its `kind`, set by the repo from the file itself
  // (see repo.js) and not by its extension here, because a `.md` can be either
  // a story or a plain document and only its contents say which.
  //
  //   story          a tab: the story editor
  //   doc            a tab: the markdown editor
  //   image          a tab: the image, shown as-is
  //   text / page    a tab: a plain-text editor. HTML is source to edit as much
  //                  as a page to look at, so it lands here with a Preview
  //                  button rather than going straight to the browser
  //   pdf            the browser panel, no tab — Chromium already renders those
  //   other          nothing here can open it, so say so
  function openFile(node) {
    if (!node) return
    const path = workspacePathOf(root, node.id)

    if (node.kind === 'pdf') {
      onOpenLink(path)
      return
    }
    if (TAB_KINDS.includes(node.kind)) {
      onOpenTab({ path, id: node.id, kind: node.kind, title: node.title, ext: node.ext })
      // A story's case tabs and any held selection belong to the story we came
      // from, not the one arriving.
      if (node.kind === 'story') {
        setPendingCaseName(null)
        setActiveCaseIndex(0)
        setPendingAnchor(null)
        setActiveThreadId(null)
      }
      return
    }
    setUnopenable({ title: node.title, ext: node.ext })
  }

  // A search result opens exactly like a tree row — but the folders it lives
  // in may never have been loaded, so it is revealed first and the search box
  // handed back to the tree. Otherwise the user lands on a file with no idea
  // where it sits.
  function selectSearchResult(node) {
    if (!node) return
    onRevealNode(node.id)
    onSearchQueryChange('')
    openFile(node)
  }

  function addNode({ addType, parentId }) {
    onExpandNode(parentId)
    actions.addNode({ nodeType: addType, parentId })
  }

  function moveNode({ nodeType, nodeId, newParentId }) {
    onExpandNode(newParentId)
    actions.moveNode({ nodeType, nodeId, newParentId })
  }

  function requestStoryDelete() {
    if (!selectedStoryId) return
    setPendingAction({
      action: 'delete',
      nodeType: 'file',
      nodeId: selectedStoryId,
      name: selectedStory?.title || '',
    })
  }

  function reorderCase({ caseId, beforeId, afterId }) {
    const cases = selectedStory?.cases || []
    const fromIndex = cases.findIndex((c) => c.id === caseId)
    if (fromIndex === -1) return
    const list = [...cases]
    const [moved] = list.splice(fromIndex, 1)

    let insertAt
    if (beforeId != null) {
      const i = list.findIndex((c) => c.id === beforeId)
      if (i === -1) return
      insertAt = i
    } else if (afterId != null) {
      const i = list.findIndex((c) => c.id === afterId)
      if (i === -1) return
      insertAt = i + 1
    } else {
      return
    }
    list.splice(insertAt, 0, moved)
    // Dropped back into the same position → nothing to do.
    if (list.every((c, i) => c.id === cases[i].id)) return

    // Keep the ACTIVE case active (its tab index may have changed).
    const activeId = cases[activeCaseIndex]?.id
    const newActiveIndex = list.findIndex((c) => c.id === activeId)
    if (newActiveIndex === -1) return

    setCases(list)
    setActiveCaseIndex(newActiveIndex)
    actions.reorderCase({ storyId: selectedStory.id, orderedIds: list.map((c) => c.id) })
  }

  function confirmPendingAction() {
    const p = pendingAction
    if (!p) return

    if (p.action === 'duplicate') {
      if (p.nodeType === 'case') actions.duplicateCase({ caseId: p.nodeId })
      else actions.duplicateNode({ nodeType: p.nodeType, nodeId: p.nodeId })
    } else if (p.action === 'delete') {
      if (p.nodeType === 'file') {
        actions.deleteStory({ storyId: p.nodeId })
      } else if (p.nodeType === 'case') {
        actions.deleteCase({ caseId: p.nodeId })
        // Clamp the active tab into the range that remains after the delete
        // (the tree refreshes a tick later — compute from the current count).
        const maxIndex = (selectedStory?.cases || []).length - 2
        setActiveCaseIndex(Math.max(0, Math.min(activeCaseIndex, maxIndex)))
      } else {
        actions.deleteNode({ nodeType: p.nodeType, nodeId: p.nodeId })
      }
      // A case is part of a file that still exists; a file or folder is not, so
      // any tab showing it (or anything inside it) has nothing left to show.
      if (p.nodeType !== 'case') onFileGone(p.nodeId)
    }
    setPendingAction(null)
  }

  const copy = dialogCopy(pendingAction)

  // The row the sidebar highlights: whatever the editor column is currently
  // showing. Derived rather than stored, so it can't drift from the panel — a
  // rename changes a file's id, and a remembered id would keep pointing at the
  // path the file used to have.
  //
  // A doc opened from a story LINK can live outside the workspace, in which
  // case there is no row to highlight — the sidebar simply shows nothing
  // selected, which is the truth.
  const selectedNodeId = useMemo(
    () => activeTab?.id || (activeTab ? workspaceIdOf(root, activeTab.path) : '') || '',
    [activeTab, root],
  )

  const clearPendingAnchor = useCallback(() => setPendingAnchor(null), [])

  // The toggle's badge: open comments across the workspace that mention you.
  // Workspace-wide rather than per-story on purpose — a mention on a story you
  // don't happen to have open is exactly the one you need telling about.

  const sidebarPanel = (
    <SidebarPanel
      rootNodes={rootNodes}
      selectedNodeId={selectedNodeId}
      expandedIds={expandedIds}
      loadingIds={loadingIds}
      childrenOf={childrenOf}
      searchQuery={searchQuery}
      onSearchQueryChange={onSearchQueryChange}
      searchResults={searchResults}
      searching={searching}
      onSelectSearchResult={selectSearchResult}
      workspaceName={workspaceName}
      userEmail={userEmail}
      onUserEmailChange={onUserEmailChange}
      sync={{
        status: workspaceSync.status,
        lastSync: workspaceSync.lastSync,
        syncing: workspaceSync.syncing,
        error: workspaceSync.error,
        detail: workspaceSync.detail,
        onSync: workspaceSync.sync,
        accounts: workspaceSync.accounts,
        pushUser: workspaceSync.pushUser,
        chooseAccount: workspaceSync.chooseAccount,
        checkingAccounts: workspaceSync.checkingAccounts,
      }}
      onOpenWorkspace={onOpenWorkspace}
      onSelectFile={openFile}
      onToggleNode={onToggleNode}
      onAddNode={addNode}
      onRenameNode={actions.renameNode}
      onDuplicateRequest={({ nodeType, nodeId, name }) =>
        setPendingAction({ action: 'duplicate', nodeType, nodeId, name })
      }
      onDeleteRequest={({ nodeType, nodeId, name }) =>
        setPendingAction({ action: 'delete', nodeType, nodeId, name })
      }
      onMoveNode={moveNode}
    />
  )

  const storyPanel = (
    <StoryPanel
      story={selectedStory}
      root={root}
      activeCaseIndex={activeCaseIndex}
      onUpdateStory={actions.updateStory}
      onUpdateCase={actions.updateCase}
      onAddCase={actions.addCase}
      onSelectCase={setActiveCaseIndex}
      onRenameCase={actions.renameCase}
      onReorderCase={reorderCase}
      onCaseDuplicateRequest={({ caseId, storyId, name }) =>
        setPendingAction({ action: 'duplicate', nodeType: 'case', nodeId: caseId, storyId, name })
      }
      onCaseDeleteRequest={({ caseId, storyId, name }) =>
        setPendingAction({ action: 'delete', nodeType: 'case', nodeId: caseId, storyId, name })
      }
      onStoryDeleteRequest={requestStoryDelete}
      onOpenLink={onOpenLink}
      threads={storyThreads}
      activeThreadId={activeThreadId}
      onRequestComment={requestComment}
      onActivateThread={setActiveThreadId}
      onOpenThread={openThread}
    />
  )

  // A markdown document — a PRD, a TRD, a README. No cases, criticality or
  // comment threads for the story chrome to act on.
  const docPanel = (
    <DocPanel
      filePath={activeTab?.path || ''}
      root={root}
    />
  )

  // The editor column: one general bar, then whichever panel the active tab
  // needs under it. Nothing below the bar knows about tabs, and the bar's
  // controls are there whatever kind of file is open — including none.
  const editorColumn = (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <EditorBar
        tabs={tabs}
        activeKey={activeTab?.key || null}
        onActivateTab={onActivateTab}
        onCloseTab={onCloseTab}
        onToggleSidebar={toggleSidebar}
        commentsOpen={commentsOpen}
        onToggleComments={toggleComments}
        openCommentCount={mentionCount}
        browserOpen={browserOpen}
        onToggleBrowser={onToggleBrowser}
      />
      {activeTab?.kind === 'story' ? (
        storyPanel
      ) : activeTab?.kind === 'doc' ? (
        docPanel
      ) : activeTab?.kind === 'image' ? (
        <ImagePanel filePath={activeTab.path} title={activeTab.title} />
      ) : activeTab?.kind === 'text' || activeTab?.kind === 'page' ? (
        <TextPanel filePath={activeTab.path} isHtml={activeTab.kind === 'page'} onPreview={onOpenLink} />
      ) : (
        <div className="text-muted-foreground flex flex-1 items-center justify-center px-6 text-center text-[13px]">
          Open a file from the sidebar, or search for one.
        </div>
      )}
    </div>
  )

  const commentsPanel = (
    <CommentsPanel
      storyId={selectedStoryId}
      storyTitle={selectedStory?.title || ''}
      storyThreads={storyThreads}
      repoThreads={repoThreads}
      users={users}
      userEmail={userEmail}
      error={commentError}
      activeThreadId={activeThreadId}
      pendingAnchor={pendingAnchor}
      onClose={toggleComments}
      onSelectStory={selectStory}
      onActivateThread={setActiveThreadId}
      onClearPendingAnchor={clearPendingAnchor}
      actions={commentActions}
    />
  )

  return (
    <div className="bg-background flex h-screen flex-col overflow-hidden">
      <PanelLayout
        sidebar={sidebarHidden ? null : sidebarPanel}
        story={editorColumn}
        comments={commentsOpen ? commentsPanel : null}
        browser={browser}
        browserOpen={browserOpen}
        onBrowserOpenChange={onBrowserOpenChange}
      />

      <AlertDialog open={!!pendingAction} onOpenChange={(open) => !open && setPendingAction(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.title}</AlertDialogTitle>
            <AlertDialogDescription>{copy.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={pendingAction?.action === 'duplicate' ? undefined : buttonVariants({ variant: 'destructive' })}
              onClick={confirmPendingAction}
            >
              {pendingAction?.action === 'duplicate' ? 'Duplicate' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* A file the tree lists but this app has no editor or viewer for. The
          tree shows every file on purpose — hiding them would make it lie
          about what's on disk — so this is the honest end of that promise. */}
      <AlertDialog open={!!unopenable} onOpenChange={(open) => !open && setUnopenable(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Can’t open this file here</AlertDialogTitle>
            <AlertDialogDescription>
              Threadline opens stories, markdown, plain text, images, web pages and PDFs.
              {unopenable?.ext ? ` A .${unopenable.ext} file` : ' This file'} needs an app that understands it — open{' '}
              {unopenable?.title ? `“${unopenable.title}”` : 'it'} from your file manager instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setUnopenable(null)}>Got it</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
