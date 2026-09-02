// Replaces MDXEditor's own link dialog, for two reasons.
//
// The first is where a link OPENS. Threadline's links are as often a file next
// to the story — a PRD, a spec, a screenshot — as they are an http URL, and
// those belong in the app's own doc or browser panel, not a new OS window.
// The stock dialog only offers an open affordance for `http` URLs and sends it
// to window.open. Here every link gets the same right-arrow, and it routes
// through the host's handler (App.jsx's openLink), which already knows how to
// resolve a story-relative path and pick the panel to show it in. That arrow
// is deliberately the same ChevronRight the link chips use in StoryPanel: one
// gesture for "go there", wherever the link is written.
//
// The second is styling. The stock dialog ships its own CSS-module look, which
// index.css then has to fight over hashed class names; this one is built from
// the app's own tokens and needs no overrides at all.
//
// Positioning: `linkDialogState.rectangle` is in VIEWPORT coordinates (the
// stock dialog anchors to it with position:fixed), so this portals to <body>
// and places itself with fixed coordinates. Same technique, and same reason,
// as the floating "Comment" button in CaseEditor.jsx — the editor lives inside
// resizable panels whose overflow would clip a popover positioned within them.

import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronRight, Copy, Pencil, Unlink, X } from 'lucide-react'
import {
  activeEditor$,
  cancelLinkEdit$,
  contentEditableWrapperElement$,
  linkDialogState$,
  onClickLinkCallback$,
  onWindowChange$,
  removeLink$,
  switchFromPreviewToLinkEdit$,
  updateLink$,
  useCellValues,
  usePublisher,
} from '@mdxeditor/editor'

import { cn } from '@/lib/utils'
import { relativePath, toAbsolutePath, workspaceIdOf } from '@/lib/paths'

// The story's folder and the workspace root, for rebasing a pasted local path.
// Supplied through context rather than props because `linkDialogPlugin` takes a
// COMPONENT, not an element — passing props would mean a fresh component type
// on every render of the editor, remounting this popover mid-keystroke.
//
// A surface that doesn't provide it (the plain-document editor in DocPanel)
// leaves links exactly as typed, which is how they already behave there.
const LinkPathsContext = createContext(null)

export function LinkPathsProvider({ root, docDir, children }) {
  return <LinkPathsContext.Provider value={{ root, docDir }}>{children}</LinkPathsContext.Provider>
}

// A pasted absolute path becomes a path relative to the document's own folder,
// so the link survives a clone onto a machine whose drives are named
// differently. Anything we can't make portable is refused outright rather than
// stored as a link that only works here: a message while the field is still
// open is worth more than a dead link found later.
//
// Returns `{ url }` to store, or `{ error }` to show. Web URLs, and paths that
// are already relative, pass through untouched.
async function normalizeUrl(raw, { root, docDir }) {
  const url = String(raw || '').trim()
  const abs = toAbsolutePath(url)
  if (!url || !abs || !root || !docDir) return { url }
  if (!workspaceIdOf(root, abs)) {
    return { error: 'That file is outside this workspace, so the link wouldn’t work for anyone else.' }
  }
  let info
  try {
    const res = await fetch(`/api/threadline/stat?path=${encodeURIComponent(abs)}`)
    info = (await res.json())?.data
  } catch {
    return { error: 'Couldn’t check that path.' }
  }
  if (!info?.exists) return { error: 'There’s no file at that path.' }
  if (info.kind === 'folder') return { error: 'That’s a folder — link to a file inside it.' }
  return { url: relativePath(docDir, abs) }
}

// Keeps the popover on screen when the link sits near the right edge. A rough
// max width is enough — the popover is never wider than this.
const MAX_WIDTH = 380
const GAP = 6

function ActionButton({ className, ...props }) {
  return (
    <button
      type="button"
      className={cn(
        'hover:bg-accent text-muted-foreground hover:text-foreground flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm [&_svg]:size-3.5',
        className,
      )}
      {...props}
    />
  )
}

export function LinkPopover() {
  const [state, activeEditor, wrapper, onClickLink] = useCellValues(
    linkDialogState$,
    activeEditor$,
    contentEditableWrapperElement$,
    onClickLinkCallback$,
  )
  const publishWindowChange = usePublisher(onWindowChange$)
  const updateLink = usePublisher(updateLink$)
  const cancelEdit = usePublisher(cancelLinkEdit$)
  const switchToEdit = usePublisher(switchFromPreviewToLinkEdit$)
  const removeLink = usePublisher(removeLink$)

  const [copied, setCopied] = useState(false)
  const [pathError, setPathError] = useState('')
  const paths = useContext(LinkPathsContext)
  const urlRef = useRef(null)
  const popoverRef = useRef(null)

  const kind = state.type

  // The rectangle is captured once, so scrolling or resizing would leave the
  // popover behind. Republishing onWindowChange$ is how the stock dialog keeps
  // it fresh, and the editor scrolls inside its own container rather than the
  // window — hence the third listener.
  //
  // PREVIEW ONLY, and that is the whole reason pasting into the URL field used
  // to wipe the form. onWindowChange$ doesn't nudge the popover; it makes
  // linkDialogState$ recompute itself from the editor's selection, and that
  // pipeline resolves to `preview` or `inactive` and has no branch that gives
  // back an `edit`. So a reposition fired while the form is open doesn't move
  // the form — it destroys it, along with whatever is in the URL field.
  useEffect(() => {
    if (kind !== 'preview') return
    const scroller = wrapper?.closest('.mdxeditor-root-contenteditable')
    const update = (e) => {
      // The window listener is in the CAPTURE phase because `scroll` doesn't
      // bubble and the editor sits inside resizable panels that scroll on
      // their own — a bubbling listener would never hear those. The price is
      // that it hears every scrolling element on the page, this popover's own
      // fields included, so anything from inside is filtered back out here.
      if (e?.target instanceof Node && popoverRef.current?.contains(e.target)) return
      activeEditor?.getEditorState().read(() => {
        publishWindowChange(true)
      })
    }
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    scroller?.addEventListener('scroll', update)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      scroller?.removeEventListener('scroll', update)
    }
  }, [kind, activeEditor, wrapper, publishWindowChange])

  // A fresh edit starts with the URL selected, so typing replaces it — the
  // common case is pasting a different address over the old one.
  useEffect(() => {
    if (kind === 'edit') urlRef.current?.select()
    setPathError('')
  }, [kind])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1000)
    return () => clearTimeout(timer)
  }, [copied])

  if (kind === 'inactive') return null

  const rect = state.rectangle
  const open = () => {
    // onClickLinkCallback is what the host wires openLink to. Without one there
    // is no panel to show a local file in, so an external URL is all that can
    // sensibly be done.
    if (onClickLink) onClickLink(state.url)
    else if (state.url.startsWith('http')) window.open(state.url, '_blank', 'noreferrer')
  }

  return createPortal(
    <div
      ref={popoverRef}
      className="bg-popover text-popover-foreground fixed z-50 flex items-center gap-1 rounded-md border p-1 text-[13px] shadow-md"
      style={{
        top: rect.top + rect.height + GAP,
        left: Math.min(rect.left, Math.max(GAP, window.innerWidth - MAX_WIDTH - GAP)),
        maxWidth: MAX_WIDTH,
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          cancelEdit()
        }
      }}
    >
      {kind === 'preview' ? (
        <>
          {/* The URL itself stays clickable — it is the biggest target and
              already reads as a link — but the arrow is the affordance that
              says so, and the one that is always there, local file or not. */}
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground max-w-[15rem] cursor-pointer truncate px-1 text-left"
            title={state.url}
            onClick={open}
          >
            {state.url}
          </button>
          <ActionButton title="Open" aria-label="Open" onClick={open}>
            <ChevronRight />
          </ActionButton>
          <ActionButton title="Edit link" aria-label="Edit link" onClick={() => switchToEdit()}>
            <Pencil />
          </ActionButton>
          <ActionButton
            title={copied ? 'Copied' : 'Copy link'}
            aria-label="Copy link"
            onClick={() => {
              void window.navigator.clipboard.writeText(state.url).then(() => setCopied(true))
            }}
          >
            {copied ? <Check /> : <Copy />}
          </ActionButton>
          <ActionButton title="Remove link" aria-label="Remove link" onClick={() => removeLink()}>
            <Unlink />
          </ActionButton>
        </>
      ) : (
        // The form is a column so a rejected path has a line to be said on;
        // the fields themselves stay in the single row they were always in.
        <form
          className="flex min-w-0 flex-col gap-1"
          onSubmit={(e) => {
            e.preventDefault()
            const form = new FormData(e.currentTarget)
            const text = state.withAnchorText ? String(form.get('text') || '') : undefined
            // Async, so the link is committed in the callback rather than
            // inline — the disk check behind normalizeUrl is a round trip to
            // the local server.
            void normalizeUrl(String(form.get('url') || ''), paths || {}).then((result) => {
              if (result.error) {
                setPathError(result.error)
                urlRef.current?.focus()
                return
              }
              updateLink({ url: result.url, title: state.title, text })
            })
          }}
        >
          {/* min-w-0 on this row and on the URL field, or the buttons hang out
              past the popover's border. A flex item defaults to
              `min-width:auto`, which for an <input> is its `size`, so neither
              would shrink: the row's intrinsic width (two fields plus two
              buttons) is wider than MAX_WIDTH, and the overflow spilled the
              Set/Cancel buttons outside the rounded box. Letting the URL field
              absorb the difference keeps everything inside; the buttons stay
              put at their natural size. */}
          <div className="flex min-w-0 items-center gap-1">
            {state.withAnchorText && (
              <input
                name="text"
                defaultValue={state.text}
                placeholder="text"
                aria-label="Link text"
                className="border-input bg-background focus-visible:ring-ring/50 h-7 w-24 shrink-0 rounded-md border px-2 text-[13px] outline-none focus-visible:ring-[3px]"
              />
            )}
            <input
              ref={urlRef}
              name="url"
              defaultValue={state.url}
              placeholder="https://… or a local file path"
              aria-label="Link URL"
              autoFocus
              onChange={() => setPathError('')}
              className="border-input bg-background focus-visible:ring-ring/50 h-7 w-64 min-w-0 rounded-md border px-2 text-[13px] outline-none focus-visible:ring-[3px]"
            />
            <ActionButton type="submit" title="Set URL" aria-label="Set URL">
              <Check />
            </ActionButton>
            <ActionButton title="Cancel" aria-label="Cancel" onClick={() => cancelEdit()}>
              <X />
            </ActionButton>
          </div>
          {pathError && (
            <p role="alert" className="text-destructive px-1 pb-0.5 text-[12px]">
              {pathError}
            </p>
          )}
        </form>
      )}
    </div>,
    document.body,
  )
}
