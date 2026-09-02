// One row of the workspace tree (folder or file), VS Code Explorer style.
// Recursive: an OPEN folder renders its children as nested <TreeNode>s.
//
// A folder's children are not part of its node — they're fetched per level and
// handed down through `childrenOf` (see useThreadlineSync). So a closed folder
// renders nothing below it and costs nothing, and `childrenOf` returning
// undefined means "still loading" as distinct from an empty array's "empty".
// `node.has_children` is what decides whether an expand arrow is drawn, since
// that is known without reading the folder.
//
// A file row carries a `kind` from the repo — 'story', 'doc' or 'page' — which
// decides its glyph here and which panel opens it in Board. The row itself
// doesn't route: it hands the whole node up through `onSelectFile`, because the
// three destinations (story editor, document editor, browser) are the board's
// business, not a tree row's.
//
// Owns only its own rename draft and drop-indicator state; every action is
// reported upward through callbacks.

import { useEffect, useRef, useState } from 'react'
import { cva } from 'class-variance-authority'
import {
  ChevronDown,
  ChevronRight,
  Check,
  File,
  FileCode,
  FileText,
  Folder,
  Image as ImageIcon,
  MoreHorizontal,
} from 'lucide-react'

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
import { canShowInFolder, revealLabel } from '@/lib/desktop'

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

// The glyph says what opening the row will do — a story's case tabs, a plain
// document, or a page or image handed to the browser. Selection is already
// spelled out by the row's background, border and weight, so the icon is free
// to carry the kind instead of repeating it.
const KIND_GLYPHS = { story: FileText, doc: File, page: FileCode, text: FileCode, image: ImageIcon }

// The file-type label at the end of a row ('MD', 'HTML', 'PNG'). It comes from
// the repo's `ext`, not from parsing the name here: a story's title has already
// had its extension taken off, so there is nothing left in the text to read it
// from.
//
// A story's extension is '.s.md', which as a tag would read 'S.MD' — a spelling
// of the rule rather than the thing it means. The row says STORY instead: it is
// what the extension is for, and it is the one distinction in this tree that the
// filenames alone make hard to scan.
//
// `bg-foreground/10` rather than a named surface token because this sits on two
// different row backgrounds — the default and the selected row's accent — and a
// translucent tint of the text colour stays legible on both, in either theme.
const TAG_CLASS =
  'text-muted-foreground bg-foreground/10 shrink-0 rounded-sm px-1 font-mono text-[9px] leading-[1.5] tracking-wide uppercase'

// Both menus on a row — the … dropdown and the right-click one — offer the
// same actions, so they are one list rendered twice rather than two lists that
// can drift. `{ separator: true }` entries are rendered as the menus' own
// separator component.
//
// "Reveal" is dropped outside the desktop shell: in a plain browser tab there
// is no file manager to hand the path to, and a menu item that silently does
// nothing is worse than one that isn't there. Copying a path needs no shell,
// so it always stays.
function menuItemsFor() {
  return [
    { value: 'rename', label: 'Rename' },
    { value: 'duplicate', label: 'Duplicate' },
    { separator: true },
    { value: 'copy-path', label: 'Copy path' },
    ...(canShowInFolder() ? [{ value: 'reveal', label: revealLabel() }] : []),
    { separator: true },
    { value: 'delete', label: 'Delete', variant: 'destructive' },
  ]
}

export default function TreeNode({
  node,
  type,
  selectedNodeId,
  expandedIds,
  loadingIds,
  childrenOf,
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
  const isFolder = type === 'folder'
  const name = node?.name || node?.title || ''
  const open = isFolder && !!expandedIds?.has(node?.id)
  const children = open ? childrenOf(node?.id) : undefined
  const loadingChildren = open && children === undefined && !!loadingIds?.has(node?.id)
  const selected = type === 'file' && node?.id === selectedNodeId

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
    if (action === 'add-doc') onAddNode({ addType: 'doc', parentId: node.id })
    if (action === 'rename') startRename()
    if (action === 'duplicate') onDuplicateRequest({ nodeType: type, nodeId: node.id, name })
    if (action === 'copy-path') onCopyPath({ nodeType: type, nodeId: node.id, name })
    if (action === 'reveal') onShowInFolder({ nodeType: type, nodeId: node.id, name })
    if (action === 'delete') onDeleteRequest({ nodeType: type, nodeId: node.id, name })
  }

  function onRowClick() {
    if (renaming) return
    if (type === 'file') onSelectFile(node)
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

  const FileGlyph = KIND_GLYPHS[node.kind] || File
  const menuItems = menuItemsFor()

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
        open ? (
          <ChevronDown className="text-muted-foreground size-3 shrink-0" />
        ) : (
          // Kept for a folder known to be empty too, so rows stay aligned and
          // the arrow doesn't appear and disappear as folders are filled.
          <ChevronRight className="text-muted-foreground size-3 shrink-0" />
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
          {/* Outside the truncating span, so a long name shortens and the type
              stays readable rather than the two competing for the same space. */}
          {(node.kind === 'story' || node.ext) && (
            <span className={TAG_CLASS}>{node.kind === 'story' ? 'story' : node.ext}</span>
          )}
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
                    <DropdownMenuItem onSelect={() => onMenuAction('add-file')}>Add story</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => onMenuAction('add-doc')}>Add markdown</DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                {menuItems.map((item, i) =>
                  item.separator ? (
                    <DropdownMenuSeparator key={`sep-${i}`} />
                  ) : (
                    <DropdownMenuItem
                      key={item.value}
                      variant={item.variant}
                      onSelect={() => onMenuAction(item.value)}
                    >
                      {item.label}
                    </DropdownMenuItem>
                  ),
                )}
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
              <ContextMenuItem onSelect={() => onMenuAction('add-file')}>Add story</ContextMenuItem>
              <ContextMenuItem onSelect={() => onMenuAction('add-doc')}>Add markdown</ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          {menuItems.map((item, i) =>
            item.separator ? (
              <ContextMenuSeparator key={`sep-${i}`} />
            ) : (
              <ContextMenuItem key={item.value} variant={item.variant} onSelect={() => onMenuAction(item.value)}>
                {item.label}
              </ContextMenuItem>
            ),
          )}
        </ContextMenuContent>
      </ContextMenu>

      {open && (
        <ul className="pl-tree-indent m-0 list-none p-0">
          {loadingChildren && (
            <li className="text-muted-foreground flex h-tree-row items-center pl-3 text-[13px] italic">Opening…</li>
          )}
          {(children || []).map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              type={child.type}
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
    </li>
  )
}
