// The board's right column: the story title and the case tabs with their
// markdown editors.
//
// ONE Save covers the whole story — the title and the open case body — because
// that is how the panel reads to the person using it: a story is one thing, not
// two independently-saved fragments. The body reports its state up from
// CaseEditor rather than saving itself, which is what lets a single button
// speak for all of it.
//
// The title makes the save ORDER load-bearing, and it is the thing to be
// careful about when changing anything here. The filename IS the title, so
// saving it renames the file — and the file's path is the id every case
// (`<story path>::<index>`) is addressed by. The body must therefore be written
// BEFORE the rename; see saveAll, which ends with the title for that reason.
//
// The story's `links` and `criticality` no longer have an editor here — the
// metadata fold that held them is gone. They are deliberately still READ and
// WRITTEN BACK by packages/core, so the frontmatter of a story that already has
// them survives every save this panel makes: updateFile patches named fields
// only, and this panel now names just the title.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cva } from 'class-variance-authority'
import { Check, MoreHorizontal, Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import { useManualSave } from '@/board/useManualSave'
import { SaveButton, SaveNotices } from '@/panels/SaveBar'
import { clearDrag, getDrag, setDrag } from '@/board/dnd'
import { storyDirOf, workspacePathOf } from '@/lib/paths'

const MAX_CASES = 10

// Reorder indicator for a case tab — one definition for both edges.
const tabVariants = cva('group/tab relative flex min-w-16 shrink items-center', {
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
  return m ? `Tab ${parseInt(m[1], 10)}` : `Tab ${i + 1}`
}

// ---- params (the title) -----------------------------------------------------
//
// Only the title is left here now that the metadata fold is gone, but it still
// travels through useManualSave as a serialized string rather than as plain
// state. That is not ceremony: it is what gives the title the same dirty
// tracking and localStorage crash backup the body editors have, and what lets
// one Save button speak for the title and the body together. The JSON envelope
// stays for the same reason — it is the shape useManualSave's scope-keyed
// backups were written with, and a second field will want it back.

function serializeParams({ title }) {
  return JSON.stringify({ title })
}

function deserializeParams(raw) {
  try {
    const parsed = JSON.parse(raw)
    return { title: typeof parsed?.title === 'string' ? parsed.title : '' }
  } catch {
    return { title: '' }
  }
}

// What would actually reach disk. The title compares TRIMMED because trailing
// spaces never survive to the filename — typing one and deleting it again must
// not leave the story looking dirty.
function persistedParams(raw) {
  return JSON.stringify({ title: deserializeParams(raw).title.trim() })
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
  // Bumped when a sync pulled: the case bodies on disk may not be the ones the
  // open editor was seeded from, so it remounts to pick them up.
  reloadSignal = 0,
  onSaveStateChange,
}) {
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
  const storyIdRef = useRef(story?.id)

  const storyId = story?.id
  const cases = story?.cases || []

  // The absolute folder this story lives in. The link editor that used to need
  // this is gone; it stays because CaseEditor resolves the images pasted into a
  // case body against it.
  const storyDir = storyDirOf(root, storyId)

  // ---- params + body: one save between them ---------------------------------

  const paramsBaseline = useMemo(
    () => serializeParams({ title: story?.title || '' }),
    [story?.title],
  )

  // The title is the only field this panel writes, and writing it RENAMES the
  // file — the filename is the story's id. Nothing else may be written after
  // it, which is why saveAll runs the body first; see the note there.
  //
  // `links` and `criticality` are simply not named here, and that is what keeps
  // them safe: updateFile patches the fields it is given, so a story that
  // already carries them keeps them across every save.
  const saveParams = useCallback(
    async (raw) => {
      if (!story) return
      const nextTitle = deserializeParams(raw).title.trim()
      // Refused rather than silently skipped: the filename IS the title, so
      // there is no such thing as a story without one, and a Save that quietly
      // did nothing would leave the field dirty forever with no explanation.
      if (!nextTitle) throw new Error('A story needs a title.')
      if (nextTitle !== story.title) {
        await onUpdateStory({ storyId: story.id, field: 'title', value: nextTitle })
      }
    },
    [story, onUpdateStory],
  )

  const params = useManualSave({
    scope: storyId ? `params:${storyId}` : null,
    baseline: paramsBaseline,
    ready: !!storyId,
    onSave: saveParams,
    isEqual: useCallback((a, b) => persistedParams(a) === persistedParams(b), []),
  })

  const { title: titleDraft } = useMemo(() => deserializeParams(params.text), [params.text])

  // Kept as a patch-shaped helper rather than collapsed into a bare setter: the
  // envelope is what useManualSave tracks, so an edit has to go through
  // serializeParams either way.
  const paramsEdit = params.edit
  const editParams = useCallback(
    (patch) => paramsEdit(serializeParams({ title: patch.title ?? titleDraft })),
    [paramsEdit, titleDraft],
  )

  // The case body reports up here rather than to Board, so the Save button on
  // the title row can cover the whole panel — params and body together.
  const caseSave = useRef({ dirty: false, save: null, discard: null })
  const [caseDirty, setCaseDirty] = useState(false)
  const onCaseSaveState = useCallback((next) => {
    caseSave.current = next
    setCaseDirty(next.dirty)
  }, [])

  const dirty = params.dirty || caseDirty
  const paramsSave = params.save
  const paramsDiscard = params.discard

  // The BODY GOES FIRST, and this order is not cosmetic. A case is addressed by
  // `<story path>::<index>`, so the title rename inside paramsSave changes the
  // id this write targets — writing the body afterwards would send it to a path
  // that no longer exists. Params saves the title last for the same reason.
  //
  // A failed body save stops there: pressing on would rename the file out from
  // under text that still hasn't been written anywhere.
  const saveAll = useCallback(async () => {
    const savedBody = (await caseSave.current.save?.()) ?? true
    if (!savedBody) return false
    return await paramsSave()
  }, [paramsSave])

  const discardAll = useCallback(() => {
    paramsDiscard()
    caseSave.current.discard?.()
  }, [paramsDiscard])

  // Board guards leaving the story on the combined state, and guards switching
  // CASE TABS on the body alone — a tab switch doesn't unmount the params, so
  // prompting for them there would be a dialog about nothing at risk.
  useEffect(() => {
    onSaveStateChange?.({
      dirty,
      save: saveAll,
      discard: discardAll,
      case: { dirty: caseDirty, save: caseSave.current.save, discard: caseSave.current.discard },
    })
  }, [dirty, caseDirty, saveAll, discardAll, onSaveStateChange])

  // A different story → abandon any in-progress rename. The title draft resyncs
  // itself: useManualSave re-reads on a new scope, and a title save is now
  // something the user asked for rather than a debounce firing mid-sentence, so
  // there is no in-flight write to guard against clobbering what they are still
  // typing.
  useEffect(() => {
    if (storyIdRef.current === storyId) return
    storyIdRef.current = storyId
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
        {/* The story's own controls: rename and delete. Everything that acts
            on another panel lives in the column’s shared bar above (see
            EditorBar). */}
        <div className="mb-2 flex items-center gap-1">
          <input
            ref={titleRef}
            className="hover:bg-accent focus:bg-accent min-w-0 flex-1 rounded-md border-none bg-transparent px-2 py-1.5 text-base font-semibold outline-none"
            value={titleDraft}
            placeholder="Story title"
            // Nothing commits on change or on blur any more: the title is part
            // of the story's one Save, like everything else on this panel.
            onChange={(e) => editParams({ title: e.target.value })}
          />
          {/* One Save for the whole story: the title and the case body. */}
          <SaveButton dirty={dirty} saving={params.saving} onSave={saveAll} />
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
        </div>

        <SaveNotices
          recovered={params.recovered}
          error={params.error}
          onDiscard={discardAll}
          onSave={saveAll}
        />

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
          <TabsList className="w-full min-w-0 shrink-0 justify-start overflow-x-auto border-b">
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
                      <TabsTrigger value={`case-${i}`} className="w-full max-w-50">
                        <span className="overflow-hidden text-ellipsis whitespace-nowrap">{caseLabel(c, i)}</span>
                      </TabsTrigger>
                      <span className="bg-linear-to-r from-transparent to-background to-30% absolute top-0 right-0 bottom-0.5 flex items-center pr-1 pl-5 opacity-0 transition-opacity group-hover/tab:opacity-100 has-[[data-state=open]]:opacity-100">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-xs" aria-label="Tab actions">
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
                className="ml-1 shrink-0 self-center"
                aria-label="Add tab"
                title="Add tab"
                onClick={() => onAddCase({ storyId: story.id })}
              >
                <Plus />
              </Button>
            )}
          </TabsList>

          {cases.map((c, i) => (
            <TabsContent key={c.id} value={`case-${i}`} className="flex min-h-0 flex-col overflow-hidden px-3 py-2">
              <CaseEditor
                // The reload signal is in the key, not a prop: a pulled body is
                // a different document, and MDXEditor only takes one at mount.
                key={`${c.id}:${reloadSignal}`}
                caseId={c.id}
                caseName={caseLabel(c, i)}
                // Images pasted into a case body belong next to the story file
                // that holds it, so the editor is told which file that is.
                docPath={workspacePathOf(root, storyId)}
                docDir={storyDir}
                root={root}
                value={c.body || ''}
                onChangeBody={onUpdateCase}
                onSaveStateChange={onCaseSaveState}
                // Only this case's threads: an anchor from another tab can't
                // resolve here, and trying would report it as orphaned.
                threads={threads.filter((t) => !t.case_name || t.case_name === caseLabel(c, i))}
                activeThreadId={activeThreadId}
                onRequestComment={onRequestComment}
                onActivateThread={onActivateThread}
                onOpenThread={onOpenThread}
                // The same handler the link chips above use, so a link written
                // into the body opens exactly where a chip's would.
                onOpenLink={onOpenLink}
              />
            </TabsContent>
          ))}
        </Tabs>
      ) : (
        <div className="text-muted-foreground flex items-center gap-1.5 px-4 py-2 text-[13px]">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Add tab"
            title="Add tab"
            onClick={() => onAddCase({ storyId: story.id })}
          >
            <Plus />
          </Button>
          <span>No tabs yet — click + to add one.</span>
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
