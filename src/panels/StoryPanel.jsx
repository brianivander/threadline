// The board's right column: story detail (title, links, criticality) and the
// case tabs with their markdown editors.

import { useEffect, useRef, useState } from 'react'
import { cva } from 'class-variance-authority'
import {
  Check,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Plus,
  Trash2,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import CaseEditor from '@/board/CaseEditor'
import { clearDrag, getDrag, setDrag } from '@/board/dnd'
import { TAG_COLORS, swatchStyle, tagColorLabel, tagStyle } from '@/board/linkTags'
import { isAbsolutePath, storyDirOf, toRelativePath } from '@/lib/paths'

const CRITICALITIES = ['P1', 'P2', 'P3', 'P4']
const MAX_CASES = 10
const DEBOUNCE_MS = 500

// Reorder indicator for a case tab — one definition for both edges.
const tabVariants = cva('group/tab relative flex min-w-0 items-center', {
  variants: {
    dropEdge: {
      none: '',
      before: 'before:bg-primary before:absolute before:inset-y-0 before:left-0 before:w-[3px]',
      after: 'after:bg-primary after:absolute after:inset-y-0 after:right-0 after:w-[3px]',
    },
  },
  defaultVariants: { dropEdge: 'none' },
})

// Stable tab label for a case: the stored name, or — for legacy cases saved
// without one — a number derived from the case id (creation sequence). Never
// the tab's index: reordering tabs must not renumber the cases.
export function caseLabel(c, i) {
  if (c?.name) return c.name
  const m = String(c?.id || '').match(/(\d+)\s*$/)
  return m ? `Case ${parseInt(m[1], 10)}` : `Case ${i + 1}`
}

const EMPTY_LINK = { url: '', tag: '', color: '' }

// story.links is an array of {url, tag, color}. The editor keeps at least one
// (empty) row so there's never a field-less "add your first link", and widens a
// bare string in case an older payload reaches the panel.
function parseLinks(raw) {
  const rows = (Array.isArray(raw) ? raw : []).map((l) =>
    typeof l === 'string'
      ? { ...EMPTY_LINK, url: l }
      : { url: l?.url || '', tag: l?.tag || '', color: l?.color || '' },
  )
  return rows.length ? rows : [{ ...EMPTY_LINK }]
}

export default function StoryPanel({
  story,
  root,
  activeCaseIndex,
  onUpdateStory,
  onAddCase,
  onSelectCase,
  onRenameCase,
  onReorderCase,
  onCaseDuplicateRequest,
  onCaseDeleteRequest,
  onStoryDeleteRequest,
  onUpdateCase,
  onOpenLink,
  threads = [],
  activeThreadId,
  onRequestComment,
  onActivateThread,
  onOpenThread,
}) {
  const [paramsCollapsed, setParamsCollapsed] = useState(false)
  const [titleDraft, setTitleDraft] = useState(story?.title || '')
  const [linksDraft, setLinksDraft] = useState(() => parseLinks(story?.links))

  // Index of the link row whose colour swatches are open, or -1. Only one at a
  // time — the panel is anchored under the tag field it belongs to.
  const [swatchRow, setSwatchRow] = useState(-1)

  // Case-tab rename state.
  const [renamingIndex, setRenamingIndex] = useState(-1)
  const [renameValue, setRenameValue] = useState('')
  const [showRenameConfirm, setShowRenameConfirm] = useState(false)
  const renameOriginalRef = useRef('')
  const renameCaseIdRef = useRef(null)
  const renameStoryIdRef = useRef(null)
  const renameInputRef = useRef(null)

  const [dropTarget, setDropTarget] = useState({ index: -1, edge: 'none' })

  const titleRef = useRef(null)
  const titleTimer = useRef(null)
  const linksTimer = useRef(null)
  const swatchRef = useRef(null)
  const storyIdRef = useRef(story?.id)

  const storyId = story?.id
  const cases = story?.cases || []

  // The absolute folder this story lives in — the base every relative link is
  // resolved against, and the anchor a pasted absolute path is rebased onto.
  const storyDir = storyDirOf(root, storyId)

  // Committing a title rename changes the file's id, so a self-rename looks
  // like a story switch. Only resync the title draft when the user isn't in
  // the field — otherwise the in-flight save clobbers the characters they
  // typed while it was round-tripping.
  useEffect(() => {
    if (document.activeElement !== titleRef.current) setTitleDraft(story?.title || '')
  }, [story?.title, story?.id])

  // A different story → resync links and abandon any in-progress rename.
  useEffect(() => {
    if (storyIdRef.current === storyId) return
    storyIdRef.current = storyId
    setLinksDraft(parseLinks(story?.links))
    setSwatchRow(-1)
    // ...unless the "unsaved change?" dialog is open: the story switch WAS the
    // click-away that opened it, so keep the pending name available.
    if (!showRenameConfirm) endRename()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storyId])

  useEffect(() => {
    if (renamingIndex === -1) return
    renameInputRef.current?.focus()
    renameInputRef.current?.select()
  }, [renamingIndex, showRenameConfirm])

  // Dismiss the colour swatches on a click anywhere else, or on Escape. The
  // ref wraps the tag field together with its panel, so clicking back into the
  // field it belongs to doesn't count as outside.
  useEffect(() => {
    if (swatchRow === -1) return
    function onPointerDown(e) {
      if (!swatchRef.current?.contains(e.target)) setSwatchRow(-1)
    }
    function onKeyDown(e) {
      if (e.key === 'Escape') setSwatchRow(-1)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [swatchRow])

  useEffect(
    () => () => {
      clearTimeout(titleTimer.current)
      clearTimeout(linksTimer.current)
    },
    [],
  )

  // ---- title ---------------------------------------------------------------

  // Saving the title renames the file on disk (filename IS the title), which
  // changes its id and refetches the tree — so debounce hard, like links.
  function onTitleInput(value) {
    setTitleDraft(value)
    clearTimeout(titleTimer.current)
    titleTimer.current = setTimeout(() => commitTitle(value), DEBOUNCE_MS)
  }

  function commitTitle(raw) {
    if (!story) return
    const value = (raw ?? titleDraft).trim()
    if (!value || value === story.title) return
    onUpdateStory({ storyId: story.id, field: 'title', value })
  }

  // ---- links ---------------------------------------------------------------

  // One patch path for all three fields of a row — the url, the tag, and the
  // colour picked from the swatches all share the debounce. A pasted absolute
  // filesystem path is rebased onto the story's folder as a relative path
  // immediately, so the shared repo stays portable across machines.
  function onLinkInput(i, patch) {
    const next = linksDraft.map((l, idx) =>
      idx === i ? { ...l, ...patch, url: toRelativePath(patch.url ?? l.url, storyDir) } : l,
    )
    setLinksDraft(next)
    clearTimeout(linksTimer.current)
    linksTimer.current = setTimeout(() => commitLinks(next), DEBOUNCE_MS)
  }

  // The copy lands directly under its original, so a duplicated row doesn't
  // jump to the bottom of a long list.
  function duplicateLink(i) {
    clearTimeout(linksTimer.current)
    const next = linksDraft.flatMap((l, idx) => (idx === i ? [l, { ...l }] : [l]))
    setLinksDraft(next)
    setSwatchRow(-1)
    commitLinks(next)
  }

  function removeLink(i) {
    clearTimeout(linksTimer.current)
    const filtered = linksDraft.filter((_, idx) => idx !== i)
    const next = filtered.length ? filtered : [{ ...EMPTY_LINK }]
    setLinksDraft(next)
    setSwatchRow(-1)
    commitLinks(next)
  }

  // Rows with no url yet (an added-but-not-yet-filled field, or a tag typed
  // before the link is pasted) are dropped from what's persisted, but stay in
  // the local draft so the empty input doesn't vanish out from under the user
  // while they're about to type into it.
  function commitLinks(draft) {
    if (!story) return
    const value = draft
      .map((l) => ({ url: toRelativePath(l.url, storyDir).trim(), tag: l.tag.trim(), color: l.color }))
      .filter((l) => l.url)
    onUpdateStory({ storyId: story.id, field: 'links', value })
  }

  // ---- case rename ---------------------------------------------------------

  function startCaseRename(i) {
    const c = cases[i]
    if (!c) return
    const label = caseLabel(c, i)
    renameOriginalRef.current = label
    renameCaseIdRef.current = c.id
    renameStoryIdRef.current = storyId
    setRenameValue(label)
    setRenamingIndex(i)
  }

  function endRename() {
    setRenamingIndex(-1)
    setRenameValue('')
    setShowRenameConfirm(false)
    renameOriginalRef.current = ''
    renameCaseIdRef.current = null
    renameStoryIdRef.current = null
  }

  function confirmCaseRename() {
    const name = renameValue.trim()
    if (name && name !== renameOriginalRef.current && renameCaseIdRef.current) {
      onRenameCase({ caseId: renameCaseIdRef.current, name })
    }
    endRename()
  }

  // Clicking elsewhere: revert silently when the name is untouched, otherwise
  // ask before discarding.
  function requestRenameDismiss() {
    if (renamingIndex === -1) return
    if (renameValue.trim() !== renameOriginalRef.current) setShowRenameConfirm(true)
    else endRename()
  }

  // ---- case tab drag & drop (reorder) --------------------------------------

  function onTabDragStart(e, i) {
    const c = cases[i]
    if (!c) return
    setDrag({ nodeType: 'case', nodeId: c.id })
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', c.id)
  }

  function edgeFor(e) {
    const rect = e.currentTarget.getBoundingClientRect()
    return e.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
  }

  function onTabDragOver(e, i) {
    const drag = getDrag()
    if (!drag || drag.nodeType !== 'case') return
    const c = cases[i]
    if (!c || c.id === drag.nodeId) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropTarget({ index: i, edge: edgeFor(e) })
  }

  function onTabDrop(e, i) {
    const drag = getDrag()
    setDropTarget({ index: -1, edge: 'none' })
    if (!drag || drag.nodeType !== 'case') return
    const c = cases[i]
    if (!c || c.id === drag.nodeId) return
    e.preventDefault()
    const before = edgeFor(e) === 'before'
    onReorderCase({
      caseId: drag.nodeId,
      beforeId: before ? c.id : undefined,
      afterId: before ? undefined : c.id,
    })
    clearDrag()
  }

  if (!story) {
    return (
      <div className="text-muted-foreground flex flex-1 items-center justify-center text-[13px]">
        Select a story from the sidebar.
      </div>
    )
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      <div className="shrink-0 px-4 pt-3">
        {/* The story's own controls: rename, delete, and the parameters
            fold. Everything that acts on another panel lives in the
            column’s shared bar above (see EditorBar). */}
        <div className="mb-2 flex items-center gap-1">
          <input
            ref={titleRef}
            className="hover:bg-accent focus:bg-accent min-w-0 flex-1 rounded-md border-none bg-transparent px-2 py-1.5 text-base font-semibold outline-none"
            value={titleDraft}
            placeholder="Story title"
            onChange={(e) => onTitleInput(e.target.value)}
            onBlur={() => {
              clearTimeout(titleTimer.current)
              commitTitle()
            }}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            className="hover:text-destructive"
            aria-label="Delete story"
            title="Delete story"
            onClick={onStoryDeleteRequest}
          >
            <Trash2 />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={paramsCollapsed ? 'Show parameters' : 'Hide parameters'}
            title={paramsCollapsed ? 'Show parameters' : 'Hide parameters'}
            onClick={() => setParamsCollapsed((v) => !v)}
          >
            <ChevronDown className={cn('transition-transform', paramsCollapsed ? '' : 'rotate-180')} />
          </Button>
        </div>

        {!paramsCollapsed && (
          <>
            <div className="mb-2 flex items-start gap-2 text-[13px]">
              <label className="text-muted-foreground w-14 shrink-0 pt-2 text-xs">Links</label>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                {linksDraft.map((link, i) => (
                  <div key={i} className="flex items-center gap-1">
                    <div
                      ref={swatchRow === i ? swatchRef : null}
                      className="relative w-28 shrink-0"
                    >
                      <Input
                        className="h-7 w-full text-[13px]"
                        style={tagStyle(link.color)}
                        placeholder="tag"
                        value={link.tag}
                        onChange={(e) => onLinkInput(i, { tag: e.target.value })}
                        onFocus={() => setSwatchRow(i)}
                      />
                      {swatchRow === i && (
                        <div
                          className="bg-popover text-popover-foreground absolute top-full left-0 z-50 mt-1 grid w-max grid-cols-6 gap-1 rounded-md border p-1.5 shadow-md"
                          role="group"
                          aria-label="Tag colour"
                        >
                          {/* Twelve swatches and no separate "none" button —
                              clicking the selected one clears it, so the grid
                              stays two clean rows of six. */}
                          {TAG_COLORS.map((color) => (
                            <button
                              key={color}
                              type="button"
                              aria-label={tagColorLabel(color)}
                              aria-pressed={link.color === color}
                              title={tagColorLabel(color)}
                              className={cn(
                                'size-4 rounded-full border',
                                link.color === color && 'ring-ring ring-2 ring-offset-1',
                              )}
                              style={swatchStyle(color)}
                              onClick={() => onLinkInput(i, { color: link.color === color ? '' : color })}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                    <Input
                      className="h-7 flex-1 text-[13px]"
                      placeholder="https://… or a local file path"
                      value={link.url}
                      onChange={(e) => onLinkInput(i, { url: e.target.value })}
                    />
                    {link.url.trim() && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Open in browser"
                        title="Open in browser"
                        onClick={() => onOpenLink(link.url.trim())}
                      >
                        <ChevronRight />
                      </Button>
                    )}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label="Link actions" title="Link actions">
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => duplicateLink(i)}>Duplicate</DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onSelect={() => removeLink(i)}>
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ))}
                <Button
                  variant="ghost"
                  size="xs"
                  className="text-muted-foreground self-start"
                  onClick={() => setLinksDraft([...linksDraft, { ...EMPTY_LINK }])}
                >
                  + add link
                </Button>
              </div>
            </div>

            <div className="mb-2 flex items-center gap-2 text-[13px]">
              <label className="text-muted-foreground w-14 shrink-0 text-xs">Criticality</label>
              <Select
                value={story.criticality || 'P3'}
                onValueChange={(value) => onUpdateStory({ storyId: story.id, field: 'criticality', value })}
              >
                <SelectTrigger size="sm" className="w-28 text-[13px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CRITICALITIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </>
        )}
      </div>

      {cases.length ? (
        <Tabs
          className="min-h-0 flex-1"
          value={`case-${activeCaseIndex}`}
          onValueChange={(name) => {
            const index = parseInt(String(name).replace('case-', ''), 10)
            if (Number.isNaN(index)) return
            // Switching tabs is a click-away for an in-progress rename.
            if (renamingIndex !== -1 && renamingIndex !== index) requestRenameDismiss()
            onSelectCase(index)
          }}
        >
          <TabsList className="w-full min-w-0 shrink-0 justify-start overflow-hidden border-b">
            {cases.map((c, i) => {
              const isRenaming = renamingIndex === i && renameStoryIdRef.current === storyId
              // The rename field and the "…" menu are SIBLINGS of the trigger,
              // never children: <TabsTrigger> renders a <button>, and nesting
              // an input or another button inside it is invalid markup that
              // breaks focus and typing.
              return (
                <div
                  key={c.id}
                  className={tabVariants({ dropEdge: dropTarget.index === i ? dropTarget.edge : 'none' })}
                  draggable={!isRenaming}
                  onDragStart={(e) => onTabDragStart(e, i)}
                  onDragEnd={() => setDropTarget({ index: -1, edge: 'none' })}
                  onDragOver={(e) => onTabDragOver(e, i)}
                  onDrop={(e) => onTabDrop(e, i)}
                >
                  {isRenaming ? (
                    <span className="flex items-center gap-0.5 px-2 py-1.5">
                      <Input
                        ref={renameInputRef}
                        className="h-6 w-40 px-1.5 text-[13px]"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            confirmCaseRename()
                          }
                          if (e.key === 'Escape') requestRenameDismiss()
                        }}
                        onBlur={requestRenameDismiss}
                      />
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="text-primary"
                        aria-label="Confirm rename"
                        // mousedown fires before the input's blur, so the
                        // click-away guard never sees this as "elsewhere".
                        onMouseDown={(e) => {
                          e.preventDefault()
                          confirmCaseRename()
                        }}
                      >
                        <Check />
                      </Button>
                    </span>
                  ) : (
                    <>
                      <TabsTrigger value={`case-${i}`} className="max-w-50 pr-7">
                        <span className="overflow-hidden text-ellipsis whitespace-nowrap">{caseLabel(c, i)}</span>
                      </TabsTrigger>
                      <span className="absolute inset-y-0 right-0 flex items-center pr-1 opacity-0 transition-opacity group-hover/tab:opacity-100 has-[[data-state=open]]:opacity-100">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-xs" aria-label="Case actions">
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => startCaseRename(i)}>Rename</DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() =>
                                onCaseDuplicateRequest({ caseId: c.id, storyId: story.id, name: caseLabel(c, i) })
                              }
                            >
                              Duplicate
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              variant="destructive"
                              onSelect={() =>
                                onCaseDeleteRequest({ caseId: c.id, storyId: story.id, name: caseLabel(c, i) })
                              }
                            >
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </span>
                    </>
                  )}
                </div>
              )
            })}
            {cases.length < MAX_CASES && (
              <Button
                variant="ghost"
                size="icon-sm"
                className="ml-1 self-center"
                aria-label="Add case"
                title="Add case"
                onClick={() => onAddCase({ storyId: story.id })}
              >
                <Plus />
              </Button>
            )}
          </TabsList>

          {cases.map((c, i) => (
            <TabsContent key={c.id} value={`case-${i}`} className="flex min-h-0 flex-col overflow-hidden px-3 py-2">
              <CaseEditor
                caseId={c.id}
                caseName={caseLabel(c, i)}
                value={c.body || ''}
                onChangeBody={onUpdateCase}
                // Only this case's threads: an anchor from another tab can't
                // resolve here, and trying would report it as orphaned.
                threads={threads.filter((t) => !t.case_name || t.case_name === caseLabel(c, i))}
                activeThreadId={activeThreadId}
                onRequestComment={onRequestComment}
                onActivateThread={onActivateThread}
                onOpenThread={onOpenThread}
              />
            </TabsContent>
          ))}
        </Tabs>
      ) : (
        <div className="text-muted-foreground flex items-center gap-1.5 px-4 py-2 text-[13px]">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Add case"
            title="Add case"
            onClick={() => onAddCase({ storyId: story.id })}
          >
            <Plus />
          </Button>
          <span>No cases yet — click + to add one.</span>
        </div>
      )}

      <Dialog
        open={showRenameConfirm}
        onOpenChange={(open) => {
          if (open) return
          // Backdrop/Escape means "go back to editing"; if the click-away also
          // switched stories there's no field to return to.
          setShowRenameConfirm(false)
          if (renameStoryIdRef.current !== storyId) endRename()
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Unsaved case name</DialogTitle>
            <DialogDescription>You changed the case name but didn't save it.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRenameConfirm(false)}>
              Keep editing
            </Button>
            <Button variant="outline" onClick={endRename}>
              Discard
            </Button>
            <Button onClick={confirmCaseRename}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
