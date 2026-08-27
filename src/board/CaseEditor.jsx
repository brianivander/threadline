// Markdown editor for a case body — MDXEditor (Lexical) in WYSIWYG mode, so
// formatting is easy to read and edit while the DATA stays markdown.
//
// Saving is MANUAL — Ctrl+S or the Save button. What's typed lives in
// useManualSave until then, backed up to localStorage on a short debounce so a
// crash can't take it (see drafts.js). The parent's `value` is therefore the
// baseline this editor started from, not a live mirror of the text.
//
// MDXEditor's `markdown` prop behaves like a textarea's defaultValue: it seeds
// the document and is then ignored. So:
//
//   - switching case -> the `caseId` in the key remounts, seeding the new body
//     cleanly (and dropping the previous case's undo history with it)
//   - text replaced from outside (a recovered draft, a discard) -> the `seed`
//     in the key remounts too. Nothing is pushed in imperatively any more:
//     setMarkdown() rebuilds the document and drops the selection, and the only
//     writes now are ones the user asked for, which a remount already covers.
//
// Comment highlights are painted on top of that document as Lexical MarkNodes
// and stripped again on export, so they never reach the file — see
// commentMarks.js. They're reapplied whenever the thread list or the body
// changes, because either can move where a comment's text now sits.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MessageSquarePlus } from 'lucide-react'
import { MDXEditor } from '@mdxeditor/editor'
import '@mdxeditor/editor/style.css'

import { markdownPlugins } from '@/board/mdxPlugins'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { anchorFromSelection, applyCommentMarks, setActiveMark, threadIdAtSelection } from '@/board/caseText'
import { commentMarksPlugin } from '@/board/commentMarks'
import { useImageAssets } from '@/board/useImageAssets'
import { useManualSave } from '@/board/useManualSave'
import { SaveNotices } from '@/panels/SaveBar'

// Trailing whitespace is not an edit. MDXEditor normalizes it on export, so
// comparing raw strings would call a freshly-opened case dirty.
const sameMarkdown = (a, b) =>
  (a || '').replace(/[ \t]+$/gm, '').trimEnd() === (b || '').replace(/[ \t]+$/gm, '').trimEnd()

export default function CaseEditor({
  caseId,
  caseName,
  // The story file this case body lives in, and its folder. A case has no file
  // of its own, so an image pasted into one is stored against the story that
  // holds it — see useImageAssets.js.
  docPath,
  docDir,
  root,
  value,
  onChangeBody,
  threads = [],
  activeThreadId,
  onRequestComment,
  onActivateThread,
  onOpenThread,
  onSaveStateChange,
}) {
  const editorRef = useRef(null)
  const [lexicalEditor, setLexicalEditor] = useState(null)
  // Resolved anchor positions from the last pass, reused as a starting guess
  // for the next one.
  const hintsRef = useRef({})
  // A selection is captured on right-click, BEFORE the menu opens: opening it
  // can collapse the selection, and by the time "Comment" is chosen the range
  // the user meant may be gone.
  const pendingSelectionRef = useRef(null)

  const write = useCallback((body) => onChangeBody({ caseId, body }), [onChangeBody, caseId])

  const images = useImageAssets({ docPath, docDir, root })

  const { text, seed, dirty, error: saveError, recovered, edit, save, discard } = useManualSave({
    scope: caseId ? `case:${caseId}` : null,
    baseline: value || '',
    ready: !!caseId,
    onSave: write,
    onSettled: images.settle,
    isEqual: sameMarkdown,
  })

  // Board guards navigation on this — switching case tabs, switching stories
  // and closing the file's tab all have to ask before losing an unsaved body.
  useEffect(() => {
    onSaveStateChange?.({ dirty, save, discard })
  }, [dirty, save, discard, onSaveStateChange])

  // Only the anchored, unresolved threads affect the highlights — rebuilding
  // on every reply or status flip would be churn for no visible change.
  const anchorSignature = useMemo(
    () =>
      threads
        .filter((t) => t.anchor?.quote && t.status !== 'resolved')
        .map((t) => `${t.id}:${t.anchor.quote}`)
        .join('|'),
    [threads],
  )

  useEffect(() => {
    if (!lexicalEditor) return
    const { hints } = applyCommentMarks(lexicalEditor, threads, hintsRef.current)
    hintsRef.current = hints
    setActiveMark(lexicalEditor, activeThreadId)
    // `threads` is intentionally not a dependency: anchorSignature is the part
    // of it that changes what gets drawn. `text` is — where a comment's quoted
    // text now sits moves as the body is edited, saved or not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lexicalEditor, anchorSignature, text])

  // Repainting every mark just to move the focus ring would be wasteful, so
  // the active tint is its own pass over the existing elements.
  useEffect(() => {
    if (lexicalEditor) setActiveMark(lexicalEditor, activeThreadId)
  }, [lexicalEditor, activeThreadId])

  // Moving the caret through highlighted text focuses that comment in the
  // panel, but doesn't force the panel open — that would fight the user every
  // time they edited a sentence they'd once commented on.
  useEffect(() => {
    if (!lexicalEditor || !onActivateThread) return
    return lexicalEditor.registerUpdateListener(() => {
      const id = threadIdAtSelection(lexicalEditor)
      if (id) onActivateThread(id)
    })
  }, [lexicalEditor, onActivateThread])

  // Clicking a highlight, though, IS a request to see the comment — so that
  // opens the panel. Handled as a DOM click on the <mark> rather than through
  // the selection listener, because only a click carries that intent; a
  // selection change can happen from typing or an arrow key.
  useEffect(() => {
    if (!lexicalEditor || !onOpenThread) return
    const handler = (event) => {
      const mark = event.target?.closest?.('mark[data-thread-id]')
      const id = mark?.dataset?.threadId
      if (id) onOpenThread(id)
    }
    // registerRootListener fires with the current root immediately and again
    // whenever it changes, so the listener follows the contenteditable element.
    return lexicalEditor.registerRootListener((root, previousRoot) => {
      previousRoot?.removeEventListener('click', handler)
      root?.addEventListener('click', handler)
    })
  }, [lexicalEditor, onOpenThread])

  const onChange = edit

  // The context menu only ever holds "Comment", so it opens only when there's
  // something to comment on. A menu whose single item is greyed out tells the
  // user nothing they can act on — and it appears in places commenting can't
  // work at all, such as inside a table: MDXEditor gives each table cell its
  // own nested Lexical editor, so the outer editor has no selection to read
  // and no tree to mark up.
  const [menuOpen, setMenuOpen] = useState(false)

  // Capture phase, so the selection is recorded before Radix's own
  // contextmenu handler decides to open.
  const captureSelection = useCallback(() => {
    pendingSelectionRef.current = lexicalEditor ? anchorFromSelection(lexicalEditor) : null
  }, [lexicalEditor])

  // ---- floating "Comment" button -------------------------------------------
  //
  // Selecting text is already the gesture that means "this bit here", so the
  // button appears on the selection rather than waiting for a right-click.
  // Its presence doubles as the honest signal of whether commenting is
  // possible at all: it's driven by anchorFromSelection, so it simply doesn't
  // appear for a selection we couldn't anchor (inside a table, say) instead of
  // offering an action that would fail.
  const [floating, setFloating] = useState(null)

  useEffect(() => {
    if (!lexicalEditor || !onRequestComment) return

    let frame = 0
    const recompute = () => {
      const domSelection = window.getSelection()
      const root = lexicalEditor.getRootElement()
      if (!root || !domSelection || domSelection.isCollapsed || !domSelection.rangeCount) {
        setFloating(null)
        return
      }
      const range = domSelection.getRangeAt(0)
      if (!root.contains(range.commonAncestorContainer)) {
        setFloating(null)
        return
      }
      // The authority on "can this be commented on" — same call the click
      // uses, so the button can never promise something the action can't do.
      const anchor = anchorFromSelection(lexicalEditor)
      if (!anchor) {
        setFloating(null)
        return
      }
      const rect = range.getBoundingClientRect()
      if (!rect.width && !rect.height) {
        setFloating(null)
        return
      }
      setFloating({ anchor, top: rect.top, left: rect.left + rect.width / 2 })
    }

    // selectionchange fires on every cursor move during a drag, so coalesce to
    // one recompute per frame.
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(recompute)
    }

    document.addEventListener('selectionchange', schedule)
    // Capture phase: the editor scrolls inside its own container, not the
    // window, and a bubbling listener wouldn't see that.
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('selectionchange', schedule)
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
    }
  }, [lexicalEditor, onRequestComment])

  // A new case means a new document; any leftover button belongs to the old one.
  useEffect(() => setFloating(null), [caseId])

  return (
    <ContextMenu
      open={menuOpen}
      onOpenChange={(open) => setMenuOpen(open && !!pendingSelectionRef.current)}
    >
      <ContextMenuTrigger asChild>
        <div className="flex min-h-0 flex-1 flex-col" onContextMenuCapture={captureSelection}>
          {/* No Save button here: the story's single Save lives on the title
              row and covers this body along with the params. A recovered draft
              still needs explaining where it was recovered, though. */}
          <SaveNotices recovered={recovered} error={saveError} problem={images.error} onDiscard={discard} onSave={save} />
          <MDXEditor
            // Seeded like a defaultValue, so text replaced from outside — a
            // recovered draft, a discard — only lands via a remount.
            key={`${caseId}:${seed}`}
            ref={editorRef}
            markdown={text}
            onChange={onChange}
            contentEditableClassName="threadline-prose"
            className="flex min-h-0 flex-1 flex-col"
            plugins={markdownPlugins([commentMarksPlugin({ onEditor: setLexicalEditor })], { images })}
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={() => {
            const anchor = pendingSelectionRef.current
            if (anchor) onRequestComment?.({ anchor, caseName })
          }}
        >
          Comment
        </ContextMenuItem>
      </ContextMenuContent>

      {/* Portalled to <body>: the editor sits inside resizable panels with
          their own overflow clipping, which would cut the button off near an
          edge. Fixed coordinates come from the selection's viewport rect, so
          the portal needs no offset maths of its own. */}
      {floating &&
        createPortal(
          <button
            type="button"
            className="bg-popover text-popover-foreground hover:bg-accent fixed z-50 flex -translate-x-1/2 -translate-y-full items-center gap-1 rounded-md border px-2 py-1 text-[12px] font-medium shadow-md"
            style={{ top: Math.max(28, floating.top - 8), left: floating.left }}
            // mousedown, not click: by the time click fires the browser has
            // already collapsed the selection this button exists to act on.
            onMouseDown={(e) => {
              e.preventDefault()
              onRequestComment?.({ anchor: floating.anchor, caseName })
              setFloating(null)
            }}
          >
            <MessageSquarePlus className="size-3.5" />
            Comment
          </button>,
          document.body,
        )}
    </ContextMenu>
  )
}
