// One row of the workspace tree (folder or file), VS Code Explorer style.
// Recursive: a folder renders its children as nested <TreeNode>s.
//
// Owns only its own rename draft and drop-indicator state; every action is
// reported upward through callbacks.

import { useEffect, useRef, useState } from 'react'
import { cva } from 'class-variance-authority'
import { ChevronDown, ChevronRight, Check, File, FileText, Folder, MoreHorizontal } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { clearDrag, getDrag, setDrag } from '@/board/dnd'

// The row's states as one definition, so the "selected"/"drop target"/
// "dragging" treatments can never drift apart again.
const rowVariants = cva(
  // Layout and density live here; the variants below only change colour, so no
  // two of them can fight over the same property.
  'group/row relative flex h-tree-row cursor-pointer items-center gap-1.5 overflow-hidden border-l-2 pr-1 pl-[calc(0.75rem-2px)] text-[13px] whitespace-nowrap select-none',
  {
    variants: {
      selected: {
        true: 'bg-accent text-accent-foreground border-primary font-semibold',
        false: 'text-muted-foreground hover:bg-accent/50 border-transparent',
      },
      dragging: { true: 'opacity-45', false: '' },
      dropTarget: { true: 'bg-accent ring-ring ring-inset ring-2', false: '' },
    },
    defaultVariants: { selected: false, dragging: false, dropTarget: false },
  },
)

// The hover actions sit on top of the row's text, so they need to mask it.
// Defined once here — the old Lit version wrote this gradient three times with
// three different hardcoded end colours.
const ACTIONS_MASK =
  'absolute inset-y-0 right-0 flex items-center bg-linear-to-r from-transparent to-30% pr-1 pl-5 opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 has-[[data-state=open]]:opacity-100'

const MENU_ITEMS = [
  { value: 'rename', label: 'Rename' },
  { value: 'duplicate', label: 'Duplicate' },
  { value: 'delete', label: 'Delete', variant: 'destructive' },
]

export default function TreeNode({
  node,
  type,
  selectedStoryId,
  collapsedNodes,
  onSelectStory,
  onToggleNode,
  onAddNode,
  onRenameNode,
  onDuplicateRequest,
  onDeleteRequest,
  onMoveNode,
}) {
  const isFolder = type === 'folder'
  const name = node?.name || node?.title || ''
  const collapsed = collapsedNodes?.has(node?.id)
  const selected = type === 'file' && node?.id === selectedStoryId

  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [isDragging, setIsDragging] = useState(false)
  const [isDropTarget, setIsDropTarget] = useState(false)
  const inputRef = useRef(null)

  useEffect(() => {
    if (!renaming) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [renaming])

  if (!node) return null

  function startRename() {
    setRenameValue(name)
    setRenaming(true)
  }

  function confirmRename() {
    const next = renameValue.trim()
    if (next && next !== name) onRenameNode({ nodeId: node.id, nodeType: type, name: next })
    setRenaming(false)
    setRenameValue('')
  }

  function cancelRename() {
    setRenaming(false)
    setRenameValue('')
  }

  function onMenuAction(action) {
    if (action === 'add-folder') onAddNode({ addType: 'folder', parentId: node.id })
    if (action === 'add-file') onAddNode({ addType: 'file', parentId: node.id })
    if (action === 'rename') startRename()
    if (action === 'duplicate') onDuplicateRequest({ nodeType: type, nodeId: node.id, name })
    if (action === 'delete') onDeleteRequest({ nodeType: type, nodeId: node.id, name })
  }

  function onRowClick() {
    if (renaming) return
    if (type === 'file') onSelectStory(node.id)
    else onToggleNode(node.id)
  }

  // ---- drag & drop ---------------------------------------------------------

  function onDragStart(e) {
    if (renaming) {
      e.preventDefault()
      return
    }
    setDrag({ nodeType: type, nodeId: node.id })
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', node.id)
    setIsDragging(true)
  }

  function onDragEnd() {
    setIsDragging(false)
    setIsDropTarget(false)
    clearDrag()
  }

  function onDragOver(e) {
    if (!isFolder) return // only folders accept drops
    const drag = getDrag()
    if (!drag || drag.nodeId === node.id) return
    e.preventDefault()
    e.stopPropagation() // claim it before the sidebar's root-level handler
    e.dataTransfer.dropEffect = 'move'
    setIsDropTarget(true)
  }

  function onDrop(e) {
    if (!isFolder) return
    const drag = getDrag()
    if (!drag || drag.nodeId === node.id) return
    e.preventDefault()
    e.stopPropagation()
    setIsDropTarget(false)
    onMoveNode({ nodeType: drag.nodeType, nodeId: drag.nodeId, newParentId: node.id })
    clearDrag()
  }

  const FileGlyph = selected ? FileText : File

  const row = (
    <div
      className={rowVariants({ selected, dragging: isDragging, dropTarget: isDropTarget })}
      draggable={!renaming}
      onClick={onRowClick}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={() => setIsDropTarget(false)}
      onDrop={onDrop}
    >
      {isFolder ? (
        collapsed ? (
          <ChevronRight className="text-muted-foreground size-3 shrink-0" />
        ) : (
          <ChevronDown className="text-muted-foreground size-3 shrink-0" />
        )
      ) : null}
      {isFolder ? <Folder className="size-3.5 shrink-0" /> : <FileGlyph className="size-3.5 shrink-0" />}

      {renaming ? (
        <>
          <Input
            ref={inputRef}
            className="h-6 min-w-0 flex-1 px-1.5 text-[13px]"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') confirmRename()
              if (e.key === 'Escape') cancelRename()
            }}
            // Leaving the field auto-confirms, matching the old behaviour.
            onBlur={() => (renameValue.trim() ? confirmRename() : cancelRename())}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          />
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-primary shrink-0"
            aria-label="Confirm rename"
            onClick={(e) => {
              e.stopPropagation()
              confirmRename()
            }}
          >
            <Check />
          </Button>
        </>
      ) : (
        <>
          <span className="min-w-0 flex-1 overflow-hidden text-ellipsis">{name}</span>
          <span
            className={cn(ACTIONS_MASK, selected ? 'to-accent' : 'to-background')}
            onClick={(e) => e.stopPropagation()}
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label="More actions">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {isFolder && (
                  <>
                    <DropdownMenuItem onSelect={() => onMenuAction('add-folder')}>Add folder</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => onMenuAction('add-file')}>Add file</DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                {MENU_ITEMS.map((item) => (
                  <DropdownMenuItem
                    key={item.value}
                    variant={item.variant}
                    onSelect={() => onMenuAction(item.value)}
                  >
                    {item.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        </>
      )}
    </div>
  )

  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild disabled={renaming}>
          {row}
        </ContextMenuTrigger>
        <ContextMenuContent>
          {isFolder && (
            <>
              <ContextMenuItem onSelect={() => onMenuAction('add-folder')}>Add folder</ContextMenuItem>
              <ContextMenuItem onSelect={() => onMenuAction('add-file')}>Add file</ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          {MENU_ITEMS.map((item) => (
            <ContextMenuItem key={item.value} variant={item.variant} onSelect={() => onMenuAction(item.value)}>
              {item.label}
            </ContextMenuItem>
          ))}
        </ContextMenuContent>
      </ContextMenu>

      {isFolder && !collapsed && (
        <ul className="pl-tree-indent m-0 list-none p-0">
          {(node.children || []).map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              type={child.type}
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
      )}
    </li>
  )
}
