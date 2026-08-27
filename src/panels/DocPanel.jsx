// A plain markdown file, opened in the story column in place of the story.
//
// Story links can point at documents that aren't Threadline stories — a PRD, a
// TRD, a spec sitting in another folder or another repo entirely. Those have
// no cases, no criticality and no comment threads, so none of the story chrome
// applies to them: this panel is the editor and nothing else.
//
// The browser panel is deliberately not involved. Chromium has no markdown
// renderer, so a file:///….md loaded into a webview arrives as raw `# Heading`
// plain text — the browser is for HTML and external links only.
//
// The file is addressed by ABSOLUTE PATH, not by a workspace id: a link is
// stored relative to its story file and may resolve outside the workspace
// entirely, so there's no id and no tree row behind it. Edits save back to
// that path, debounced, the same way a case body does.
//
// MDXEditor's `markdown` prop seeds the document once and is then ignored, so
// a reload (or a switch to a different file) has to remount it — hence the
// seed in the editor's key rather than pushing new text in through the ref.

import { useCallback, useEffect, useRef, useState } from 'react'
import { RotateCw } from 'lucide-react'
import { MDXEditor } from '@mdxeditor/editor'
import '@mdxeditor/editor/style.css'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { markdownPlugins } from '@/board/mdxPlugins'

const API = '/api/threadline'
const DEBOUNCE_MS = 500

export default function DocPanel({
  filePath,
  root,
}) {
  // 'loading' until the first read settles, so an empty file doesn't flash an
  // error and a slow disk doesn't show an empty editor the user might type in
  // before the real contents land on top.
  const [state, setState] = useState({ status: 'loading', markdown: '', error: '' })
  const [seed, setSeed] = useState(0)
  const [saveError, setSaveError] = useState('')
  // Bumped by Reload. Read as an effect dependency rather than calling the
  // loader directly, so a re-read always cancels the one before it instead of
  // racing it — two clicks would otherwise let the older response land last.
  const [reloadKey, setReloadKey] = useState(0)

  const debounceRef = useRef(null)
  // What a pending save is FOR — the path and the text. Held separately from
  // the timer so the write can still be completed after the timer is torn
  // down, which is what closing a tab or switching files does.
  const pendingRef = useRef(null)
  // The text the editor last emitted, so a change event carrying nothing new
  // doesn't queue a redundant write.
  const lastTextRef = useRef('')
  // Whether the user has actually touched this document. MDXEditor normalizes
  // markdown on export (bullet markers, emphasis characters, table padding),
  // so seeding it can emit an onChange whose text differs from the file
  // without anyone having edited anything. Saving that would rewrite a file —
  // one that may live in a different repo — into a git diff nobody asked for
  // merely by opening it. Any real edit needs a key, a paste or a click inside
  // the editor first, so that is what arms the save.
  const touchedRef = useRef(false)

  const fileName = String(filePath || '').split('/').pop()

  const request = useCallback(
    async (method, path, body) => {
      const opts = { method, headers: { 'Content-Type': 'application/json' } }
      if (root) opts.headers['x-threadline-root'] = encodeURIComponent(root)
      if (body !== undefined) opts.body = JSON.stringify(body)
      const res = await fetch(`${API}${path}`, opts)
      const payload = await res.json().catch(() => ({}))
      // The API separates "that file isn't there any more" (404) from a real
      // fault, and this panel shows the message — so carry it through.
      if (!res.ok) throw new Error(payload.error || `Request failed: ${res.status}`)
      return payload
    },
    [root],
  )

  useEffect(() => {
    if (!filePath) return undefined
    let cancelled = false
    // A pending save belongs to the file we're LEAVING. It has to go out
    // against that file's own path before this one loads — dropping it would
    // silently discard whatever was typed in the last half-second.
    flushRef.current()
    touchedRef.current = false
    setState({ status: 'loading', markdown: '', error: '' })
    setSaveError('')
    request('GET', `/doc?path=${encodeURIComponent(filePath)}`)
      .then(({ data }) => {
        if (cancelled) return
        lastTextRef.current = data.markdown || ''
        setState({ status: 'ready', markdown: data.markdown || '', error: '' })
        setSeed((n) => n + 1)
      })
      .catch((err) => {
        if (cancelled) return
        setState({ status: 'error', markdown: '', error: String(err.message || err) })
      })
    return () => {
      cancelled = true
    }
  }, [filePath, request, reloadKey])

  // Finish any pending write. Kept in a ref because the loader effect above
  // has to call it without taking a dependency on it, and unmount has to call
  // the version that closes over the file being left.
  const flush = useCallback(() => {
    clearTimeout(debounceRef.current)
    const pending = pendingRef.current
    pendingRef.current = null
    if (!pending) return
    request('PUT', '/doc', { path: pending.path, markdown: pending.markdown })
      .then(() => setSaveError(''))
      .catch((err) => setSaveError(String(err.message || err)))
  }, [request])

  const flushRef = useRef(flush)
  useEffect(() => {
    flushRef.current = flush
  }, [flush])

  // Closing the tab must not lose the last keystrokes either.
  useEffect(() => () => flushRef.current(), [])

  function onChange(markdown) {
    const unchanged = markdown === lastTextRef.current
    // Recorded either way, so the next change is compared against what the
    // editor last emitted rather than a stale baseline.
    lastTextRef.current = markdown
    if (unchanged || !touchedRef.current) return
    // Wait for a pause in typing, so fast typing doesn't write the file once
    // per keystroke — same debounce the case editor uses.
    // A failed save must never be silent: the text is only in the editor at
    // this point. flush() reports it.
    pendingRef.current = { path: filePath, markdown }
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => flushRef.current(), DEBOUNCE_MS)
  }

  return (
    // Capture phase, and on the wrapper rather than the editable area, so a
    // toolbar click counts as touching the document too — it edits the text
    // just as surely as typing does.
    <div
      className="flex h-full min-w-0 flex-1 flex-col overflow-hidden"
      onKeyDownCapture={() => (touchedRef.current = true)}
      onMouseDownCapture={() => (touchedRef.current = true)}
      onPasteCapture={() => (touchedRef.current = true)}
    >
      <div className="shrink-0 px-4 pt-3">
        {/* The file’s name and its absolute path — the tab above shows
            only the name, and for a document linked out of another repo the
            path is the thing worth seeing. */}
        <div className="mb-2 flex items-center gap-1">
          {/* Read-only, unlike the story title: renaming here would rename a
              file that may belong to another repo, and the workspace tree has
              no row to keep in step with it. */}
          <div className="min-w-0 flex-1 px-2 py-0.5">
            <div className="truncate text-base font-semibold" title={filePath}>
              {fileName}
            </div>
            <div className="text-muted-foreground truncate font-mono text-[11px]" title={filePath}>
              {filePath}
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Reload from disk"
            title="Reload from disk"
            onClick={() => setReloadKey((k) => k + 1)}
          >
            <RotateCw />
          </Button>
        </div>
      </div>

      {saveError && (
        <div className="bg-destructive/10 text-destructive shrink-0 border-y px-4 py-1.5 text-xs">
          Couldn’t save: {saveError}
        </div>
      )}

      {state.status === 'loading' && (
        <div className="text-muted-foreground px-4 py-3 text-sm">Loading…</div>
      )}

      {state.status === 'error' && (
        <div className="px-4 py-3 text-sm">
          <p className="text-foreground font-medium">Can’t open this file</p>
          <p className="text-muted-foreground mt-1">{state.error}</p>
        </div>
      )}

      {state.status === 'ready' && (
        <MDXEditor
          key={`${filePath}:${seed}`}
          markdown={state.markdown}
          onChange={onChange}
          contentEditableClassName="threadline-prose"
          className="flex min-h-0 flex-1 flex-col"
          plugins={markdownPlugins()}
        />
      )}
    </div>
  )
}
