// The board's tree column: workspace bar, the tree itself, and the read-only
// user footer. Dumb container — every action bubbles up through callbacks.
// It owns only the root-level context menu and the root-level drop target
// (dropping on empty space = move to the workspace root), because there is no
// row to own those.

import { useState } from 'react'
import { FolderOpen, RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { ThemeToggle } from '@/components/theme-toggle'
import TreeNode from '@/board/TreeNode'
import { clearDrag, getDrag } from '@/board/dnd'
import { formatLastSync, syncMessage } from '@/board/useWorkspaceSync'

function WorkspaceBar({ workspaceName, onOpenWorkspace }) {
  return (
    <div className="bg-muted/40 flex h-9 shrink-0 items-center gap-1 border-b px-3 text-xs">
      <span
        className={
          workspaceName
            ? 'text-foreground min-w-0 flex-1 overflow-hidden font-semibold text-ellipsis whitespace-nowrap'
            : 'text-muted-foreground min-w-0 flex-1 overflow-hidden italic text-ellipsis whitespace-nowrap'
        }
      >
        {workspaceName || 'No folder open'}
      </span>
      <ThemeToggle />
      <Button variant="ghost" size="icon-sm" aria-label="Open folder" title="Open folder" onClick={onOpenWorkspace}>
        <FolderOpen />
      </Button>
    </div>
  )
}

// Identity on top, sync state underneath. The second line carries whichever
// of three things matters most right now, in that order: a failure, why sync
// can't run at all, or when it last did — a "Last sync 2m ago" sitting above
// an unreported error is the one thing this footer must never show.
function UserFooter({ userEmail, sync }) {
  const { status, lastSync, syncing, error, detail, onSync } = sync
  const blocked = status && status.state !== 'ready' ? status.state : null
  const ready = !!status && status.state === 'ready'
  const pending = ready ? status.ahead : 0

  const line = error
    ? syncMessage(error)
    : blocked
      ? syncMessage(blocked)
      : syncing
        ? 'Syncing…'
        : formatLastSync(lastSync) + (pending > 0 ? ` · ${pending} unpushed` : '')

  return (
    <div className="bg-muted/40 flex shrink-0 flex-col gap-0.5 border-t px-3 py-1.5 text-xs">
      <span
        className={
          userEmail
            ? 'min-w-0 overflow-hidden text-ellipsis whitespace-nowrap'
            : 'text-muted-foreground min-w-0 overflow-hidden italic text-ellipsis whitespace-nowrap'
        }
      >
        {userEmail || 'No git email configured'}
      </span>
      <div className="flex min-w-0 items-center gap-1">
        <span
          className={
            error || blocked
              ? 'text-destructive min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap'
              : 'text-muted-foreground min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap'
          }
          // Hovering a failure shows git's own words, not just our summary of
          // them — the difference between reporting a problem and diagnosing it.
          title={detail ? `${line}\n\n${detail}` : line}
        >
          {line}
        </span>
        {/* Kept mounted even when sync can't run, so the reason beside it has
            something to explain — a button that vanishes reads as a bug. */}
        <Button
          variant="ghost"
          size="xs"
          disabled={syncing || !ready}
          onClick={onSync}
          aria-label="Sync workspace"
          title={ready ? 'Pull, commit and push this folder' : syncMessage(blocked || 'no-workspace')}
        >
          <RefreshCw className={syncing ? 'animate-spin' : undefined} />
          Sync
        </Button>
      </div>
    </div>
  )
}

export default function Sidebar({
  tree,
  selectedStoryId,
  collapsedNodes,
  workspaceName,
  userEmail,
  sync,
  onOpenWorkspace,
  onSelectStory,
  onToggleNode,
  onAddNode,
  onRenameNode,
  onDuplicateRequest,
  onDeleteRequest,
  onMoveNode,
}) {
  const [rootDropActive, setRootDropActive] = useState(false)

  // A row's own handler stops propagation when it claims the drag, so anything
  // reaching here landed on empty space — i.e. the workspace root.
  function onRootDragOver(e) {
    if (!getDrag()) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setRootDropActive(true)
  }

  function onRootDrop(e) {
    const drag = getDrag()
    setRootDropActive(false)
    if (!drag) return
    e.preventDefault()
    onMoveNode({ nodeType: drag.nodeType, nodeId: drag.nodeId, newParentId: null })
    clearDrag()
  }

  return (
    <div className="bg-muted/20 flex h-full flex-col overflow-hidden border-r">
      <WorkspaceBar workspaceName={workspaceName} onOpenWorkspace={onOpenWorkspace} />

      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={
              rootDropActive
                ? 'ring-ring min-h-0 flex-1 overflow-x-hidden overflow-y-auto py-2 ring-2 ring-inset'
                : 'min-h-0 flex-1 overflow-x-hidden overflow-y-auto py-2'
            }
            onDragOver={onRootDragOver}
            onDragLeave={() => setRootDropActive(false)}
            onDrop={onRootDrop}
          >
            <ul className="m-0 list-none p-0">
              {(tree || []).map((node) => (
                <TreeNode
                  key={node.id}
                  node={node}
                  type={node.type}
                  selectedStoryId={selectedStoryId}
                  collapsedNodes={collapsedNodes}
                  onSelectStory={onSelectStory}
                  onToggleNode={onToggleNode}
                  onAddNode={onAddNode}
                  onRenameNode={onRenameNode}
                  onDuplicateRequest={onDuplicateRequest}
                  onDeleteRequest={onDeleteRequest}
                  onMoveNode={onMoveNode}
                />
              ))}
            </ul>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => onAddNode({ addType: 'folder', parentId: null })}>
            Add folder
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onAddNode({ addType: 'file', parentId: null })}>Add file</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <UserFooter userEmail={userEmail} sync={sync} />
    </div>
  )
}
