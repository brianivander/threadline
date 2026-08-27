// A plain-text file opened in the editor column — a config, a log, a CSV, or
// the source of an HTML page.
//
// Deliberately a textarea and not the markdown editor. A JSON file put through
// a WYSIWYG markdown editor comes back reformatted and broken; what these files
// need is exactly the characters they already have, in a monospace font, with
// nothing helping.
//
// HTML is edited here too, and gets a Preview button: the file is source to
// change as well as a page to look at, and Chromium is the thing that should
// render it.
//
// Addressed by absolute path, like DocPanel — a file can be linked from a story
// and live outside the workspace, in which case it has no id.

import { useCallback, useEffect, useState } from 'react'
import { Eye, RotateCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useManualSave } from '@/board/useManualSave'
import { SaveButton, SaveNotices } from '@/panels/SaveBar'

// `reloadSignal` changes when the file may have been rewritten underneath us —
// a sync that pulled — and means the same thing as the Reload button.
//
// `onSaveStateChange` reports dirtiness up to Board, which needs it to guard a
// tab switch and to mark the tab.
export default function TextPanel({ filePath, isHtml = false, onPreview, reloadSignal = 0, onSaveStateChange }) {
  // What's on disk, as last read. useManualSave holds what's in the editor.
  const [disk, setDisk] = useState('')
  const [loadError, setLoadError] = useState('')
  const [loading, setLoading] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [ready, setReady] = useState(false)

  const write = useCallback(
    async (value) => {
      const res = await fetch('/api/threadline/text', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, text: value }),
      })
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}))
        throw new Error(payload.error || `Save failed: ${res.status}`)
      }
    },
    [filePath],
  )

  const { text, dirty, saving, error: saveError, recovered, edit, save, discard } = useManualSave({
    scope: filePath,
    baseline: disk,
    ready,
    onSave: write,
  })

  useEffect(() => {
    if (!filePath) {
      setDisk('')
      setReady(false)
      return undefined
    }
    let cancelled = false
    setLoading(true)
    setReady(false)
    setLoadError('')
    fetch(`/api/threadline/text?path=${encodeURIComponent(filePath)}`)
      .then(async (res) => {
        const payload = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(payload.error || `Couldn’t open this file: ${res.status}`)
        if (cancelled) return
        setDisk(payload.data?.text ?? '')
        setReady(true)
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(err.message)
          setDisk('')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [filePath, reloadKey, reloadSignal])

  // Board guards navigation on this, and needs the actions to offer save and
  // discard from its own dialog.
  useEffect(() => {
    onSaveStateChange?.({ dirty, save, discard })
  }, [dirty, save, discard, onSaveStateChange])

  if (!filePath) return null

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-1 px-4 pt-3 pb-2">
        <div className="min-w-0 flex-1">
          <div className="text-muted-foreground truncate font-mono text-[11px]" title={filePath}>
            {filePath}
          </div>
        </div>
        {isHtml && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Preview in browser"
            title="Preview in browser"
            onClick={() => onPreview && onPreview(filePath)}
          >
            <Eye />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Reload from disk"
          // Re-reading throws away unsaved work, so say so rather than letting
          // the icon look like a harmless refresh.
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

      <SaveNotices recovered={recovered} error={saveError} onDiscard={discard} onSave={save} />

      {loadError ? (
        <p className="text-muted-foreground px-4 py-3 text-[13px] italic">{loadError}</p>
      ) : (
        <textarea
          // Keyed on the path so switching tabs replaces the field rather than
          // reusing one holding the previous file's scroll position and undo
          // history.
          key={filePath}
          className="min-h-0 flex-1 resize-none border-none bg-transparent px-4 pb-4 font-mono text-[12px] leading-relaxed outline-none"
          value={text}
          spellCheck={false}
          // Tab should indent here, not move focus out of the editor.
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key !== 'Tab') return
            e.preventDefault()
            const el = e.target
            const { selectionStart: from, selectionEnd: to } = el
            const next = `${text.slice(0, from)}  ${text.slice(to)}`
            edit(next)
            // Put the caret after the inserted spaces once React has painted.
            requestAnimationFrame(() => el.setSelectionRange(from + 2, from + 2))
          }}
          onChange={(e) => edit(e.target.value)}
          placeholder={loading ? 'Opening…' : ''}
        />
      )}
    </div>
  )
}
