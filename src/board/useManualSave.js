// The save state behind every body editor: what's typed, whether it differs
// from disk, and the one action that writes it.
//
// Shared because all three editors — the markdown doc, the plain-text file and
// a story's case body — answer the same questions (is this dirty, what does
// Ctrl+S do, what happens to a draft after a crash) while differing entirely in
// how they render. Only the save call itself is passed in.
//
// Nothing here writes to disk on a timer. The debounce that remains is the
// localStorage draft (see drafts.js), which is a crash backup and not a save —
// the file is written when, and only when, the user asks.
//
// `baseline` is the file's contents as last read from or written to disk. It's
// read once per scope rather than tracked continuously: the parent refetches
// after a save, and reacting to that would reset the editor under a user who
// had already started typing again.
//
// `onSettled` fires once an edit has come to rest — after a successful save,
// and after a discard — with the text before and after. Both cases matter to
// the same caller: pasted images are cleaned up against what the document ends
// up saying, and a discard is just the case where it ends up saying what it
// said before (see useImageAssets.js). Never called for an edit still in
// flight, and never on unmount: an unsaved document lives on as a draft, and
// tidying up behind it would gut the draft.

import { useCallback, useEffect, useRef, useState } from 'react'

import { clearDraft, draftMatchesDisk, readDraft, writeDraft } from '@/board/drafts'

// Short enough that a crash loses at most a few words, long enough that holding
// a key down isn't one localStorage write per character.
const DRAFT_DEBOUNCE_MS = 300

const defaultEqual = (a, b) => String(a ?? '') === String(b ?? '')

export function useManualSave({ scope, baseline, ready = true, onSave, onSettled, isEqual = defaultEqual }) {
  // `seed` exists for the MDXEditor callers: that editor takes its markdown
  // like a defaultValue, so text replaced from outside (a recovered draft, a
  // discard) only lands if the editor is remounted. Bumping this does that.
  const [state, setState] = useState({ scope: null, text: '', dirty: false, seed: 0, recovered: null })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Mirrors, so the keyboard handler and the parent's imperative save can read
  // the current values without being rebuilt on every keystroke.
  const baselineRef = useRef('')
  const textRef = useRef('')
  const dirtyRef = useRef(false)
  const scopeRef = useRef(null)
  const draftTimer = useRef(null)
  const equalRef = useRef(isEqual)
  equalRef.current = isEqual
  // Mirrored so save/discard don't have to be rebuilt — and so a parent that
  // passes an inline function can't make them.
  const settledRef = useRef(onSettled)
  settledRef.current = onSettled

  // Load: adopt the file's contents, unless a draft says the user was partway
  // through something when the app last stopped.
  //
  // Deliberately NOT keyed on `baseline`. It changes on every save round-trip,
  // and re-running this then would reset the editor mid-sentence.
  useEffect(() => {
    if (!scope || !ready) return
    const disk = String(baseline ?? '')
    baselineRef.current = disk
    scopeRef.current = scope

    const draft = readDraft(scope)
    if (draft && !equalRef.current(draft.text, disk)) {
      textRef.current = draft.text
      dirtyRef.current = true
      setState((s) => ({
        scope,
        text: draft.text,
        dirty: true,
        seed: s.seed + 1,
        // `stale` is the dangerous case: the draft was typed against a version
        // of this file that is no longer what's on disk.
        recovered: { at: draft.at, stale: !draftMatchesDisk(draft, disk) },
      }))
      return
    }
    // A draft identical to disk was already saved — nothing to recover, and
    // leaving it would offer a pointless choice on every future open.
    if (draft) clearDraft(scope)
    textRef.current = disk
    dirtyRef.current = false
    setState((s) => ({ scope, text: disk, dirty: false, seed: s.seed + 1, recovered: null }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, ready])

  // The draft write, debounced. Clears rather than writes once the text matches
  // disk again — an undo back to the original should leave nothing behind.
  const queueDraft = useCallback((text, dirty) => {
    clearTimeout(draftTimer.current)
    draftTimer.current = setTimeout(() => {
      const current = scopeRef.current
      if (!current) return
      if (dirty) writeDraft(current, { text, baseline: baselineRef.current })
      else clearDraft(current)
    }, DRAFT_DEBOUNCE_MS)
  }, [])

  const edit = useCallback(
    (next) => {
      const text = String(next ?? '')
      if (text === textRef.current) return
      const dirty = !equalRef.current(text, baselineRef.current)
      textRef.current = text
      dirtyRef.current = dirty
      // The recovery notice is answered by typing: once the user has carried
      // on from a restored draft, there's nothing left to tell them about.
      setState((s) => ({ ...s, text, dirty, recovered: null }))
      queueDraft(text, dirty)
    },
    [queueDraft],
  )

  // Returns true when the file is safe to leave — saved, or nothing to save.
  // The caller (a tab switch, a close) depends on that answer, so a failed
  // write must report false rather than let the edit be navigated away from.
  const save = useCallback(async () => {
    const current = scopeRef.current
    if (!current || !dirtyRef.current) return true
    setSaving(true)
    setError('')
    try {
      const previous = baselineRef.current
      await onSave(textRef.current)
      baselineRef.current = textRef.current
      dirtyRef.current = false
      clearTimeout(draftTimer.current)
      clearDraft(current)
      setState((s) => ({ ...s, dirty: false, recovered: null }))
      settledRef.current?.({ previous, text: textRef.current })
      return true
    } catch (err) {
      // Never silent: at this point the text exists only in the editor.
      setError(String(err?.message || err))
      return false
    } finally {
      setSaving(false)
    }
  }, [onSave])

  const discard = useCallback(() => {
    const current = scopeRef.current
    clearTimeout(draftTimer.current)
    if (current) clearDraft(current)
    textRef.current = baselineRef.current
    dirtyRef.current = false
    setState((s) => ({ ...s, text: baselineRef.current, dirty: false, seed: s.seed + 1, recovered: null }))
    setError('')
    // Both sides are the file as it stands: nothing the user typed survives a
    // discard, so anything they added along the way has nothing pointing at it.
    settledRef.current?.({ previous: baselineRef.current, text: baselineRef.current })
  }, [])

  // Ctrl+S / Cmd+S, on the window and in the CAPTURE phase.
  //
  // Both parts matter. On the window because MDXEditor owns its own keymap and
  // the plain-text editor is a textarea that stops propagation — a listener
  // bound inside either would miss the very case it exists for. In the capture
  // phase for the same reason from the other direction: capture runs on the way
  // DOWN to the target, so it fires before the editor that would have swallowed
  // it on the way back up.
  useEffect(() => {
    const onKeyDown = (event) => {
      const accel = event.ctrlKey || event.metaKey
      if (!accel || String(event.key).toLowerCase() !== 's' || event.altKey) return
      // Always prevented, dirty or not — the browser's own "save page" dialog
      // is never what Ctrl+S means in here.
      event.preventDefault()
      if (dirtyRef.current) save()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [save])

  // The last line of defence on quit. The draft is already on disk by now, so
  // this is about giving the user the chance to save properly rather than about
  // preventing loss — hence a prompt and not a block.
  useEffect(() => {
    const onBeforeUnload = (event) => {
      if (!dirtyRef.current) return
      // Flush the draft synchronously: the debounce above may still be pending,
      // and there is no later for it to fire in.
      clearTimeout(draftTimer.current)
      if (scopeRef.current) writeDraft(scopeRef.current, { text: textRef.current, baseline: baselineRef.current })
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  // Leaving the editor must not lose the pending draft write either — closing a
  // tab straight after a keystroke is exactly when that debounce is in flight.
  useEffect(
    () => () => {
      clearTimeout(draftTimer.current)
      if (dirtyRef.current && scopeRef.current) {
        writeDraft(scopeRef.current, { text: textRef.current, baseline: baselineRef.current })
      }
    },
    [],
  )

  return {
    text: state.text,
    seed: state.seed,
    dirty: state.dirty,
    recovered: state.recovered,
    saving,
    error,
    edit,
    save,
    discard,
  }
}
