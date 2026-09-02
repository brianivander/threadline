// The board's tree column: every markdown and HTML file in the workspace,
// under a workspace bar and above the read-only user footer. Dumb container — every action bubbles up through callbacks.
// It owns only the root-level context menu and the root-level drop target
// (dropping on empty space = move to the workspace root), because there is no
// row to own those.

import { useState } from 'react'
import { File, FileCode, FileText, FolderOpen, GitBranch, Image as ImageIcon, RefreshCw, Search, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
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

// The tree opens collapsed, so a file the user hasn't expanded their way to is
// invisible. This is how they reach it by name.
function SearchBar({ value, onChange }) {
  return (
    <div className="relative shrink-0 border-b px-2 py-1.5">
      <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-4 size-3 -translate-y-1/2" />
      <Input
        className="h-7 pl-7 text-[13px]"
        placeholder="Search files"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') onChange('')
        }}
      />
      {value ? (
        <Button
          variant="ghost"
          size="icon-xs"
          className="absolute top-1/2 right-3 -translate-y-1/2"
          aria-label="Clear search"
          onClick={() => onChange('')}
        >
          <X />
        </Button>
      ) : null}
    </div>
  )
}

// Same glyph vocabulary as a tree row, so a result reads as the file it is.
const RESULT_GLYPHS = { story: FileText, doc: File, page: FileCode, text: FileCode, image: ImageIcon }

// Results are a flat list, not a tree: the point is to skip the hierarchy. The
// containing folder is shown underneath the name because two files three
// folders apart often share one.
function SearchResults({ results, searching, query, selectedNodeId, onSelect }) {
  if (searching && results.length === 0) {
    return <p className="text-muted-foreground px-3 py-2 text-[13px] italic">Searching…</p>
  }
  if (results.length === 0) {
    return <p className="text-muted-foreground px-3 py-2 text-[13px] italic">No files match “{query}”.</p>
  }
  return (
    <ul className="m-0 list-none p-0">
      {results.map((node) => {
        const Glyph = RESULT_GLYPHS[node.kind] || File
        const folder = node.id.includes('/') ? node.id.slice(0, node.id.lastIndexOf('/')) : ''
        const selected = node.id === selectedNodeId
        return (
          <li key={node.id}>
            <button
              type="button"
              className={
                selected
                  ? 'bg-accent text-accent-foreground border-primary flex w-full items-center gap-1.5 border-l-2 px-[calc(0.75rem-2px)] py-1 text-left text-[13px] font-semibold'
                  : 'text-muted-foreground hover:bg-accent/50 flex w-full items-center gap-1.5 border-l-2 border-transparent px-[calc(0.75rem-2px)] py-1 text-left text-[13px]'
              }
              onClick={() => onSelect(node)}
            >
              <Glyph className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 overflow-hidden">
                <span className="block overflow-hidden text-ellipsis whitespace-nowrap">{node.title}</span>
                {folder ? (
                  <span className="text-muted-foreground/70 block overflow-hidden text-[11px] text-ellipsis whitespace-nowrap">
                    {folder}
                  </span>
                ) : null}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

// Identity on top, sync state underneath. The second line carries whichever
// of three things matters most right now, in that order: a failure, why sync
// can't run at all, or when it last did — a "Last sync 2m ago" sitting above
// an unreported error is the one thing this footer must never show.
function UserFooter({ onUserEmailChange, sync }) {
  const { status, lastSync, syncing, error, detail, onSync, accounts, pushUser, chooseAccount, checkingAccounts } = sync
  const blocked = status && status.state !== 'ready' ? status.state : null
  const ready = !!status && status.state === 'ready'
  const pending = ready ? status.ahead : 0

  // The dropdown lists only accounts that can actually reach this repo. One
  // accessible account is shown as a plain label (no choice to make); several
  // become a picker; none becomes the "can't access" note.
  const accessible = accounts.filter((a) => a.canAccess !== false)
  const noneAccessible = accounts.length > 0 && accessible.length === 0
  const showDropdown = accessible.length > 1
  const singleAccessible = accessible.length === 1 ? accessible[0] : null

  async function handleChooseAccount(username) {
    const result = await chooseAccount(username)
    if (result?.author?.email && onUserEmailChange) onUserEmailChange(result.author.email)
  }

  const line = error
    ? syncMessage(error)
    : blocked
      ? syncMessage(blocked)
      : syncing
        ? 'Syncing…'
        : formatLastSync(lastSync) + (pending > 0 ? ` · ${pending} unpushed` : '')

  return (
    <div className="bg-muted/40 flex shrink-0 flex-col gap-0.5 border-t px-3 py-1.5 text-xs">
      {checkingAccounts ? (
        <span className="text-muted-foreground animate-pulse">Checking saved accounts…</span>
      ) : noneAccessible ? (
        <span className="text-destructive min-w-0 overflow-hidden text-ellipsis whitespace-nowrap" title="None of your saved GitHub accounts can access this repo. Log in with the right account in GitHub Desktop, then reopen this workspace.">
          No saved account can access this repo
        </span>
      ) : singleAccessible ? (
        <span className="text-muted-foreground min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{singleAccessible.username}</span>
      ) : (
        showDropdown && (
          <Select value={pushUser || ''} onValueChange={handleChooseAccount}>
            <SelectTrigger size="sm" className="h-6 w-full px-2 text-xs" aria-label="GitHub account">
              <SelectValue placeholder="Choose GitHub account…" />
            </SelectTrigger>
            <SelectContent>
              {accessible.map((a) => (
                <SelectItem key={a.username} value={a.username}>
                  {a.username}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )
      )}
      <div className="flex min-w-0 items-center gap-1">
        {ready && status.branch && (
          <span className="text-muted-foreground flex shrink-0 items-center gap-0.5" title={`Branch: ${status.branch}`}>
            <GitBranch className="h-3 w-3" />
            {status.branch}
          </span>
        )}
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

export default function SidebarPanel({
  rootNodes,
  selectedNodeId,
  expandedIds,
  loadingIds,
  childrenOf,
  searchQuery,
  onSearchQueryChange,
  searchResults,
  searching,
  onSelectSearchResult,
  workspaceName,
  userEmail,
  onUserEmailChange,
  sync,
  onOpenWorkspace,
  onSelectFile,
  onToggleNode,
  onAddNode,
  onRenameNode,
  onDuplicateRequest,
  onDeleteRequest,
  onCopyPath,
  onShowInFolder,
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
      <SearchBar value={searchQuery} onChange={onSearchQueryChange} />

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
            {searchQuery.trim() ? (
              // The tree is replaced rather than filtered: a hit's ancestors
              // may not be loaded, and half-drawn branches would read as the
              // workspace having lost folders.
              <SearchResults
                results={searchResults}
                searching={searching}
                query={searchQuery.trim()}
                selectedNodeId={selectedNodeId}
                onSelect={onSelectSearchResult}
              />
            ) : (
              <ul className="m-0 list-none p-0">
                {(rootNodes || []).map((node) => (
                  <TreeNode
                    key={node.id}
                    node={node}
                    type={node.type}
                    selectedNodeId={selectedNodeId}
                    expandedIds={expandedIds}
                    loadingIds={loadingIds}
                    childrenOf={childrenOf}
                    onSelectFile={onSelectFile}
                    onToggleNode={onToggleNode}
                    onAddNode={onAddNode}
                    onRenameNode={onRenameNode}
                    onDuplicateRequest={onDuplicateRequest}
                    onDeleteRequest={onDeleteRequest}
                    onCopyPath={onCopyPath}
                    onShowInFolder={onShowInFolder}
                    onMoveNode={onMoveNode}
                  />
                ))}
              </ul>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => onAddNode({ addType: 'folder', parentId: null })}>
            Add folder
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onAddNode({ addType: 'file', parentId: null })}>Add story</ContextMenuItem>
          <ContextMenuItem onSelect={() => onAddNode({ addType: 'doc', parentId: null })}>
            Add markdown
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <UserFooter userEmail={userEmail} onUserEmailChange={onUserEmailChange} sync={sync} />
    </div>
  )
}
