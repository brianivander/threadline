// The board: sidebar tree + story panel, and the owner of all board-local
// state (selection, collapsed folders, active case tab, pending confirmation).
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
import { ResizableGroup, ResizableHandle, ResizablePanel } from '@/components/ui/resizable'
import Sidebar from '@/board/Sidebar'
import StoryPanel, { caseLabel } from '@/board/StoryPanel'
import CommentsPanel from '@/board/CommentsPanel'
import { useComments } from '@/board/useComments'
import { useWorkspaceSync } from '@/board/useWorkspaceSync'

const STORAGE_KEY_COLLAPSED = 'threadline_collapsed_nodes'
const STORAGE_KEY_SIDEBAR_HIDDEN = 'threadline_sidebar_hidden'
const STORAGE_KEY_COMMENTS_OPEN = 'threadline_comments_open'

function loadCollapsedNodes() {
  try {
    const arr = JSON.parse(localStorage.getItem(STORAGE_KEY_COLLAPSED))
    return Array.isArray(arr) ? new Set(arr) : new Set()
  } catch {
    return new Set()
  }
}

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

// The tree is a recursive children array of folder/file nodes (folders first,
// then files, both alphabetical, at every level).
function findFile(nodes, id) {
  for (const node of nodes || []) {
    if (node.type === 'file' && node.id === id) return node
    if (node.type === 'folder') {
      const found = findFile(node.children, id)
      if (found) return found
    }
  }
  return null
}

function findFirstFile(nodes) {
  for (const node of nodes || []) {
    if (node.type === 'file') return node
    if (node.type === 'folder') {
      const found = findFirstFile(node.children)
      if (found) return found
    }
  }
  return null
}

function withReorderedCases(nodes, storyId, newCases) {
  return (nodes || []).map((node) => {
    if (node.type === 'file') return node.id === storyId ? { ...node, cases: newCases } : node
    return { ...node, children: withReorderedCases(node.children, storyId, newCases) }
  })
}

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
  tree,
  setTree,
  actions,
  root,
  selectedStoryId,
  onSelectStory,
  workspaceName,
  userEmail,
  onUserEmailChange,
  onOpenWorkspace,
  onOpenLink,
  browserOpen,
  onToggleBrowser,
}) {
  const [activeCaseIndex, setActiveCaseIndex] = useState(0)
  const [collapsedNodes, setCollapsedNodes] = useState(loadCollapsedNodes)
  const [sidebarHidden, setSidebarHidden] = useState(loadSidebarHidden)
  const [pendingAction, setPendingAction] = useState(null)

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
    setMentionsOnly,
  } = useComments({ root, storyId: selectedStoryId, userEmail })

  const workspaceSync = useWorkspaceSync({ root })

  const selectedStory = useMemo(
    () => (selectedStoryId ? findFile(tree, selectedStoryId) : null),
    [tree, selectedStoryId],
  )

  // Auto-select the top story once data arrives and nothing is selected.
  useEffect(() => {
    if (selectedStoryId) return
    const first = findFirstFile(tree)
    if (first) {
      onSelectStory(first.id)
      setActiveCaseIndex(0)
    }
  }, [tree, selectedStoryId, onSelectStory])

  const persistCollapsed = useCallback((next) => {
    setCollapsedNodes(next)
    try {
      localStorage.setItem(STORAGE_KEY_COLLAPSED, JSON.stringify([...next]))
    } catch {
      /* noop */
    }
  }, [])

  // Adding to or moving into a collapsed folder expands it, so the user can
  // see where the node landed.
  const expandNode = useCallback(
    (nodeId) => {
      if (!nodeId || !collapsedNodes.has(nodeId)) return
      const next = new Set(collapsedNodes)
      next.delete(nodeId)
      persistCollapsed(next)
    },
    [collapsedNodes, persistCollapsed],
  )

  function toggleNode(nodeId) {
    const next = new Set(collapsedNodes)
    if (next.has(nodeId)) next.delete(nodeId)
    else next.add(nodeId)
    persistCollapsed(next)
  }

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
    const cases = caseName ? findFile(tree, storyId)?.cases || [] : []
    const index = cases.findIndex((c, i) => caseLabel(c, i) === caseName)
    setActiveCaseIndex(index === -1 ? 0 : index)
    // A held selection belongs to the case we're leaving, and a focused thread
    // to the story we're leaving — neither means anything in the new one.
    setPendingAnchor(null)
    setActiveThreadId(null)
  }

  function addNode({ addType, parentId }) {
    expandNode(parentId)
    actions.addNode({ nodeType: addType, parentId })
  }

  function moveNode({ nodeType, nodeId, newParentId }) {
    expandNode(newParentId)
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

    setTree((current) => withReorderedCases(current, selectedStory.id, list))
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
      if (selectedStoryId === p.nodeId) onSelectStory(null)
    }
    setPendingAction(null)
  }

  const copy = dialogCopy(pendingAction)

  const clearPendingAnchor = useCallback(() => setPendingAnchor(null), [])

  // The toggle's badge: open threads on the story being edited.
  const openCommentCount = useMemo(
    () => storyThreads.filter((t) => t.status !== 'resolved').length,
    [storyThreads],
  )

  const storyPanel = (
    <StoryPanel
      story={selectedStory}
      activeCaseIndex={activeCaseIndex}
      onToggleSidebar={toggleSidebar}
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
      browserOpen={browserOpen}
      onToggleBrowser={onToggleBrowser}
      threads={storyThreads}
      activeThreadId={activeThreadId}
      openCommentCount={openCommentCount}
      commentsOpen={commentsOpen}
      onToggleComments={toggleComments}
      onRequestComment={requestComment}
      onActivateThread={setActiveThreadId}
      onOpenThread={openThread}
    />
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
      onSetMentionsOnly={setMentionsOnly}
      actions={commentActions}
    />
  )

  return (
    <div className="bg-background flex h-full flex-col overflow-hidden">
      {/* One group with conditional members rather than three hand-written
          layouts: the tree and the comment panel each toggle independently, so
          the four combinations would otherwise be four copies of this tree.
          The layout is keyed by which panels are showing, so hiding one
          doesn't leave the remembered sizes of a different arrangement behind. */}
      <ResizableGroup
        storageId={`threadline_board_layout_${sidebarHidden ? 'notree' : 'tree'}_${commentsOpen ? 'comments' : 'nocomments'}`}
        className="min-h-0 flex-1"
      >
        {!sidebarHidden && (
          <ResizablePanel id="tree" defaultSize="34%" minSize="18%" maxSize="60%">
            <Sidebar
              tree={tree}
              selectedStoryId={selectedStoryId || ''}
              collapsedNodes={collapsedNodes}
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
              onSelectStory={selectStory}
              onToggleNode={toggleNode}
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
          </ResizablePanel>
        )}
        {!sidebarHidden && <ResizableHandle />}

        <ResizablePanel id="story" defaultSize={sidebarHidden ? '100%' : '66%'} minSize="30%">
          {storyPanel}
        </ResizablePanel>

        {commentsOpen && <ResizableHandle />}
        {commentsOpen && (
          <ResizablePanel id="comments" defaultSize="34%" minSize="20%" maxSize="60%">
            {commentsPanel}
          </ResizablePanel>
        )}
      </ResizableGroup>

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
    </div>
  )
}
