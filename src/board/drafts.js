// Crash-safe drafts for the manual-save editors.
//
// Saving is manual (Ctrl+S), so text that hasn't been saved lives only in the
// editor — and a flat battery takes it with it. Every edit therefore also goes
// to localStorage, which survives a crash, a force-quit and a power cut in a
// way component state does not. This is a safety net, not a save: the file on
// disk is only ever written by an explicit save.
//
// A draft records the BASELINE it was typed against — the file's contents when
// the editor opened. That is what makes offering it back safe. If the file has
// moved on since (a sync pulled a teammate's edit into it), restoring the draft
// blindly would silently revert their work, so the baseline lets the panel see
// the mismatch and say so instead of guessing.
//
// Keyed by scope: an absolute file path for a document, `case:<id>` for a case
// body. Paths are the identity here, so a draft follows the file rather than
// the tab that happened to be showing it.

const PREFIX = 'threadline_draft:'

// Scopes this session has written a draft for. Module state, so it starts empty
// on every load — which is exactly the question worth asking when a draft turns
// up: did THIS session write it, or did it outlive a crash?
//
// A draft is written whenever an editor unmounts with unsaved text, and that
// happens in ordinary use — switching between a story's tabs. Restoring the
// text is right either way, but announcing it as a recovery is only right for
// the crash: the user who just clicked a tab knows perfectly well what they
// typed, and telling them it was rescued makes a normal move look like an
// incident.
const writtenThisSession = new Set()

export function draftKey(scope) {
  return `${PREFIX}${String(scope || '')}`
}

// Did this session write the draft now sitting under `scope`? False for one
// left behind by a previous run — the case that deserves a notice.
export function draftIsFromThisSession(scope) {
  return !!scope && writtenThisSession.has(String(scope))
}

// null when there is no draft, or when what's stored isn't one — a hand-edited
// or half-written entry is treated as absent rather than thrown, because losing
// a draft must never take the editor down with it.
export function readDraft(scope) {
  if (!scope) return null
  try {
    const raw = localStorage.getItem(draftKey(scope))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed.text !== 'string') return null
    return {
      text: parsed.text,
      baseline: typeof parsed.baseline === 'string' ? parsed.baseline : '',
      at: typeof parsed.at === 'string' ? parsed.at : '',
    }
  } catch {
    return null
  }
}

// Best-effort. localStorage throws when it's full or blocked, and the editor
// carries on either way — the draft is insurance, and insurance that fails must
// not stop the thing it was insuring.
export function writeDraft(scope, { text, baseline, at }) {
  if (!scope) return false
  // Recorded even if the write below fails: the point is that this session is
  // the author of whatever is now under this scope, and a failed write leaves
  // nothing there to misread later.
  writtenThisSession.add(String(scope))
  try {
    localStorage.setItem(
      draftKey(scope),
      JSON.stringify({ text: String(text ?? ''), baseline: String(baseline ?? ''), at: at || new Date().toISOString() }),
    )
    return true
  } catch {
    return false
  }
}

export function clearDraft(scope) {
  if (!scope) return
  writtenThisSession.delete(String(scope))
  try {
    localStorage.removeItem(draftKey(scope))
  } catch {
    /* noop */
  }
}

// Whether a recovered draft was typed against the file as it now stands. False
// means the file changed underneath the draft — the one case where restoring it
// would throw away someone else's work.
export function draftMatchesDisk(draft, disk) {
  return String(draft?.baseline ?? '') === String(disk ?? '')
}
