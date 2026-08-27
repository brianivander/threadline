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

import { Button } from '@/components/ui/button'
import { markdownPlugins } from '@/board/mdxPlugins'
import { useImageAssets } from '@/board/useImageAssets'
import { useManualSave } from '@/board/useManualSave'
import { toPosix } from '@/lib/paths'
import { SaveButton, SaveNotices } from '@/panels/SaveBar'

const API = '/api/threadline'

export default function DocPanel({
  filePath,
  root,
  // Changes when the file may have been rewritten underneath us — a sync that
  // pulled. Read exactly like the Reload button's own key below, because it
  // asks for the same thing: this file, from disk, again.
  reloadSignal = 0,
  // Reports dirtiness up to Board, which guards a tab switch on it.
  onSaveStateChange,
}) {
  // 'loading' until the first read settles, so an empty file doesn't flash an
  // error and a slow disk doesn't show an empty editor the user might type in
  // before the real contents land on top.
  const [state, setState] = useState({ status: 'loading', markdown: '', error: '' })
  // Bumped by Reload. Read as an effect dependency rather than calling the
  // loader directly, so a re-read always cancels the one before it instead of
  // racing it — two clicks would otherwise let the older response land last.
  const [reloadKey, setReloadKey] = useState(0)

  // Whether the user has actually touched this document. MDXEditor normalizes
  // markdown on export (bullet markers, emphasis characters, table padding),
  // so seeding it can emit an onChange whose text differs from the file
  // without anyone having edited anything. Treating that as an edit would mark
  // a file dirty — one that may live in a different repo — merely because it
  // was opened. Any real edit needs a key, a paste or a click inside the editor
  // first, so that is what arms it.
  const touchedRef = useRef(false)

  const fileName = String(filePath || '').split('/').pop()
  // Pasted images are stored relative to the document's own folder, and the
  // document here is addressed by absolute path — which may well be outside
  // this workspace. See useImageAssets.js: the file lands in the repo that
  // owns the document, not necessarily in the workspace.
  const docDir = toPosix(filePath || '').split('/').slice(0, -1).join('/')

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

  const write = useCallback(
    (markdown) => request('PUT', '/doc', { path: filePath, markdown }),
    [request, filePath],
  )

  const images = useImageAssets({ docPath: filePath, docDir, root })

  const { text, seed, dirty, saving, error: saveError, recovered, edit, save, discard } = useManualSave({
    scope: filePath,
    baseline: state.markdown,
    ready: state.status === 'ready',
    onSave: write,
    onSettled: images.settle,
  })

  useEffect(() => {
    if (!filePath) return undefined
    let cancelled = false
    touchedRef.current = false
    setState({ status: 'loading', markdown: '', error: '' })
    request('GET', `/doc?path=${encodeURIComponent(filePath)}`)
      .then(({ data }) => {
        if (cancelled) return
        setState({ status: 'ready', markdown: data.markdown || '', error: '' })
      })
      .catch((err) => {
        if (cancelled) return
        setState({ status: 'error', markdown: '', error: String(err.message || err) })
      })
    return () => {
      cancelled = true
    }
  }, [filePath, request, reloadKey, reloadSignal])

  // Board guards navigation on this, and needs the actions for its dialog.
  useEffect(() => {
    onSaveStateChange?.({ dirty, save, discard })
  }, [dirty, save, discard, onSaveStateChange])

  function onChange(markdown) {
    // See touchedRef above: MDXEditor emits a normalized document on seeding,
    // which is not an edit and must not mark the file dirty.
    if (!touchedRef.current) return
    edit(markdown)
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
            // Re-reading throws away unsaved work, so say so rather than
            // letting the icon look like a harmless refresh.
            title={dirty ? 'Reload from disk — discards your unsaved changes' : 'Reload from disk'}
            onClick={() => {
              if (dirty && !window.confirm('Reload from disk? Your unsaved changes will be lost.')) return
              discard()
              setReloadKey((k) => k + 1)
            }}
          >
            <RotateCw />
          </Button>
          <SaveButton dirty={dirty} saving={saving} onSave={save} />
        </div>
      </div>

      <SaveNotices recovered={recovered} error={saveError} problem={images.error} onDiscard={discard} onSave={save} />

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
          // Seeded like a defaultValue, so replacing the text from outside — a
          // recovered draft, a discard — only lands via a remount.
          key={`${filePath}:${seed}`}
          markdown={text}
          onChange={onChange}
          contentEditableClassName="threadline-prose"
          className="flex min-h-0 flex-1 flex-col"
          plugins={markdownPlugins([], { images })}
        />
      )}
    </div>
  )
}
