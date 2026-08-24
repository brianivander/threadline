// Text-quote anchoring — how a comment stays attached to the words it was
// made about while the text around it keeps changing.
//
// A stored anchor is { quote, prefix, suffix, nth }: the selected text, a short
// run of the characters on either side, and which occurrence it was. Resolving
// it means finding the quote again in the current text and, when it occurs more
// than once, picking the occurrence whose neighbours best match the remembered
// context — falling back to `nth` only when the candidates are genuinely
// indistinguishable, e.g. twenty identical checklist lines, where context has
// nothing to say and would otherwise pick arbitrarily.
//
// Character offsets were the obvious alternative and are the wrong tool: they
// shift the moment anyone types above the anchor, so every comment on a
// living document would drift within a day. A quote with context survives
// insertions, deletions and reordering elsewhere in the case, and fails
// honestly — an unresolvable anchor is reported as orphaned rather than
// silently re-pointed at the wrong words.

// How much context to keep on each side. Long enough to disambiguate repeated
// phrases in a test case ('Expected: error shown' appears in many), short
// enough to survive a nearby edit.
export const CONTEXT_LENGTH = 32

// Build an anchor from a selection within `text`.
//
// `nth` (1-based) records which occurrence of the quote this was. It's a
// last-resort tiebreaker, never a primary signal: see resolveAnchor. Its only
// job is the case where the quote AND its context repeat identically — twenty
// identical checklist lines — which context alone cannot tell apart at all.
export function createAnchor(text, start, end) {
  const quote = text.slice(start, end)
  if (!quote.trim()) return null
  const nth = allOccurrences(text, quote).indexOf(start) + 1
  return {
    quote,
    prefix: text.slice(Math.max(0, start - CONTEXT_LENGTH), start),
    suffix: text.slice(end, Math.min(text.length, end + CONTEXT_LENGTH)),
    ...(nth > 0 ? { nth } : {}),
  }
}

// Length of the common run where two strings meet: prefixes compared from
// their ends, suffixes from their starts.
function sharedTail(a, b) {
  let n = 0
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++
  return n
}

function sharedHead(a, b) {
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n++
  return n
}

// Longest run of characters appearing in both strings, anywhere in either.
// Both are at most CONTEXT_LENGTH, so the quadratic table is ~1k cells.
function longestCommonRun(a, b) {
  if (!a.length || !b.length) return 0
  let best = 0
  let previous = new Array(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    const current = new Array(b.length + 1).fill(0)
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        current[j] = previous[j - 1] + 1
        if (current[j] > best) best = current[j]
      }
    }
    previous = current
  }
  return best
}

// How much a candidate's surroundings look like the remembered ones.
//
// Two signals, because either alone gets a repeated quote wrong. The run of
// characters directly touching the quote is the strongest evidence, so it's
// weighted double — but an edit landing right before the quote wipes it out
// entirely, and then the only thing left is whether the remembered context
// appears nearby at all. Scoring both means a rewritten neighbourhood
// degrades the match instead of destroying it.
// One side's contribution. A candidate near the start or end of the document
// has less context available than was saved, and would otherwise score lower
// for that reason alone — the file ending early is not evidence against it. So
// matching everything available earns the same credit as a full-length match,
// which keeps genuinely indistinguishable candidates tied instead of ordering
// them by an accident of position.
function edgeScore(available, saved, matched) {
  const comparable = Math.min(available.length, saved.length)
  if (comparable > 0 && matched === comparable) return saved.length
  return matched
}

function contextScore(before, after, prefix, suffix) {
  const adjacent =
    edgeScore(before, prefix, sharedTail(before, prefix)) + edgeScore(after, suffix, sharedHead(after, suffix))
  const nearby =
    edgeScore(before, prefix, longestCommonRun(before, prefix)) +
    edgeScore(after, suffix, longestCommonRun(after, suffix))
  return adjacent * 2 + nearby
}

function allOccurrences(text, quote) {
  const found = []
  let from = 0
  while (from <= text.length - quote.length) {
    const at = text.indexOf(quote, from)
    if (at === -1) break
    found.push(at)
    from = at + 1
  }
  return found
}

// Whitespace differences are not meaningful here: the editor is a WYSIWYG
// markdown surface, so the same visible text can come back with a different
// line wrap or a collapsed blank line without the user having touched it.
function normalize(text) {
  return String(text || '').replace(/\s+/g, ' ')
}

// Resolve an anchor against the current text.
//   { start, end, exact }  — found; `exact` is false when it took the
//                            whitespace-insensitive pass to find it
//   null                   — orphaned: the quoted text is no longer present
//
// `hint` is a previously resolved start offset, tried first: reopening an
// unchanged case then costs one comparison instead of a scan.
export function resolveAnchor(text, anchor, hint) {
  if (!anchor?.quote || !text) return null
  const { quote, prefix = '', suffix = '' } = anchor

  if (typeof hint === 'number' && text.substr(hint, quote.length) === quote) {
    return { start: hint, end: hint + quote.length, exact: true }
  }

  const occurrences = allOccurrences(text, quote)
  if (occurrences.length === 1) {
    return { start: occurrences[0], end: occurrences[0] + quote.length, exact: true }
  }
  if (occurrences.length > 1) {
    // Several candidates: the one whose surroundings look most like what was
    // remembered wins.
    const scored = occurrences.map((at) => ({
      at,
      score: contextScore(
        text.slice(Math.max(0, at - CONTEXT_LENGTH), at),
        text.slice(at + quote.length, at + quote.length + CONTEXT_LENGTH),
        prefix,
        suffix,
      ),
    }))
    const bestScore = Math.max(...scored.map((s) => s.score))
    const tied = scored.filter((s) => s.score === bestScore)

    // Only now does `nth` get a vote. Context has already had its say, so an
    // edit that shifted the text still wins — `nth` speaks only when the
    // candidates are genuinely indistinguishable, which is exactly the long
    // run of identical lines that context can say nothing about. Remaining
    // ties go to the earliest, keeping the choice stable across reloads.
    let chosen = tied[0].at
    if (tied.length > 1 && Number.isInteger(anchor.nth)) {
      const byNth = occurrences[anchor.nth - 1]
      if (byNth !== undefined && tied.some((t) => t.at === byNth)) chosen = byNth
    }
    return { start: chosen, end: chosen + quote.length, exact: true }
  }

  // Not found verbatim. Try again ignoring whitespace runs, then map the hit
  // in the normalized string back to real offsets in the original.
  const flatQuote = normalize(quote).trim()
  if (!flatQuote) return null

  const map = []
  let flat = ''
  let pendingSpace = false
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) {
      pendingSpace = flat.length > 0
      continue
    }
    if (pendingSpace) {
      flat += ' '
      map.push(i)
      pendingSpace = false
    }
    flat += text[i]
    map.push(i)
  }

  const at = flat.indexOf(flatQuote)
  if (at === -1) return null
  const start = map[at]
  const lastIndex = map[at + flatQuote.length - 1]
  if (start === undefined || lastIndex === undefined) return null
  return { start, end: lastIndex + 1, exact: false }
}

// Resolve every thread anchored in one case body, in one pass.
// Returns [{ thread, range | null }] — a null range is an orphaned thread,
// which the panel still lists (with no highlight) rather than hiding.
export function resolveThreads(text, threads, hints = {}) {
  return (threads || []).map((thread) => ({
    thread,
    range: thread.anchor ? resolveAnchor(text, thread.anchor, hints[thread.id]) : null,
  }))
}
