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

import { useCallback, useEffect, useRef, useState } from 'react'
import { Eye, RotateCw } from 'lucide-react'

import { Button } from '@/components/ui/button'

// Long enough that a pause reads as "done typing", short enough that closing a
// tab straight after a keystroke doesn't feel like a gamble. Matches the case
// editor and DocPanel.
const DEBOUNCE_MS = 500

export default function TextPanel({ filePath, isHtml = false, onPreview }) {
  const [text, setText] = useState('')
  const [loadError, setLoadError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [loading, setLoading] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  const debounceRef = useRef(null)
  // What a pending save is FOR. Switching files has to flush the old file's
  // text to the old file's path, never to the new one.
  const pendingRef = useRef(null)

  const write = useCallback(async (path, value) => {
    try {
      const res = await fetch('/api/threadline/text', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, text: value }),
      })
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}))
        throw new Error(payload.error || `Save failed: ${res.status}`)
      }
      setSaveError('')
    } catch (err) {
      // A failed save must never be silent: the text is only in the editor.
      setSaveError(err.message)
    }
  }, [])

  // Finish a save that was still waiting. Called when the file changes and on
  // unmount, so closing a tab can't discard the last keystrokes.
  const flush = useCallback(() => {
    clearTimeout(debounceRef.current)
    const pending = pendingRef.current
    pendingRef.current = null
    if (pending) write(pending.path, pending.text)
  }, [write])

  useEffect(() => {
    if (!filePath) {
      setText('')
      return undefined
    }
    let cancelled = false
    setLoading(true)
    setLoadError('')
    setSaveError('')
    fetch(`/api/threadline/text?path=${encodeURIComponent(filePath)}`)
      .then(async (res) => {
        const payload = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(payload.error || `Couldn’t open this file: ${res.status}`)
        if (!cancelled) setText(payload.data?.text ?? '')
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(err.message)
          setText('')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [filePath, reloadKey])

  // Flush on the way out of a file, and on the way out entirely.
  useEffect(() => () => flush(), [filePath, flush])

  function onInput(value) {
    setText(value)
    pendingRef.current = { path: filePath, text: value }
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(flush, DEBOUNCE_MS)
  }

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
          title="Reload from disk"
          // Discards nothing unsaved: the pending write goes out first.
          onClick={() => {
            flush()
            setReloadKey((k) => k + 1)
          }}
        >
          <RotateCw />
        </Button>
      </div>

      {saveError && (
        <div className="bg-destructive/10 text-destructive shrink-0 border-y px-4 py-1.5 text-xs">
          Couldn’t save: {saveError}
        </div>
      )}

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
            onInput(next)
            // Put the caret after the inserted spaces once React has painted.
            requestAnimationFrame(() => el.setSelectionRange(from + 2, from + 2))
          }}
          onChange={(e) => onInput(e.target.value)}
          placeholder={loading ? 'Opening…' : ''}
        />
      )}
    </div>
  )
}
