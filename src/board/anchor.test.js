// Anchor tests — the edits a comment has to survive, and the ones where it
// must admit defeat instead of pointing at the wrong words.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAnchor, resolveAnchor, resolveThreads, CONTEXT_LENGTH } from './anchor.js'

const BODY = [
  'Preconditions: a registered user.',
  'Steps: open the app, then log in.',
  'Expected: the home screen appears.',
].join('\n')

function anchorOn(text, quote, occurrence = 0) {
  let start = -1
  for (let i = 0; i <= occurrence; i++) start = text.indexOf(quote, start + 1)
  return createAnchor(text, start, start + quote.length)
}

test('createAnchor captures the quote and its surrounding context', () => {
  const a = anchorOn(BODY, 'log in')
  assert.equal(a.quote, 'log in')
  assert.ok(a.prefix.endsWith('then '))
  assert.ok(a.suffix.startsWith('.'))
  assert.ok(a.prefix.length <= CONTEXT_LENGTH)
  assert.ok(a.suffix.length <= CONTEXT_LENGTH)
})

test('createAnchor refuses a whitespace-only selection', () => {
  const newline = BODY.indexOf('\n')
  assert.equal(createAnchor(BODY, newline, newline + 1), null)
  assert.equal(createAnchor('   ', 0, 3), null)
  assert.equal(createAnchor(BODY, 5, 5), null)
})

test('resolves an unchanged body to the original range', () => {
  const a = anchorOn(BODY, 'log in')
  const r = resolveAnchor(BODY, a)
  assert.equal(BODY.slice(r.start, r.end), 'log in')
  assert.equal(r.exact, true)
})

test('survives an insertion ABOVE the anchor — the case offsets would not', () => {
  const a = anchorOn(BODY, 'log in')
  const edited = `A new first line.\nAnd another.\n${BODY}`
  const r = resolveAnchor(edited, a)
  assert.equal(edited.slice(r.start, r.end), 'log in')
  // The offset really did move, which is the whole point.
  assert.notEqual(r.start, resolveAnchor(BODY, a).start)
})

test('survives a deletion above, and edits after the anchor', () => {
  const a = anchorOn(BODY, 'log in')
  const withoutFirstLine = BODY.split('\n').slice(1).join('\n')
  let r = resolveAnchor(withoutFirstLine, a)
  assert.equal(withoutFirstLine.slice(r.start, r.end), 'log in')

  const trailingEdit = `${BODY}\nExpected: also a toast.`
  r = resolveAnchor(trailingEdit, a)
  assert.equal(trailingEdit.slice(r.start, r.end), 'log in')
})

test('picks the occurrence whose context matches when the quote repeats', () => {
  const text = ['Case A', 'Expected: error shown.', 'Case B', 'Expected: error shown.'].join('\n')
  const second = anchorOn(text, 'Expected: error shown.', 1)
  const r = resolveAnchor(text, second)
  // Must land on the SECOND occurrence, not the first match in the string.
  assert.equal(r.start, text.lastIndexOf('Expected: error shown.'))

  const first = anchorOn(text, 'Expected: error shown.', 0)
  assert.equal(resolveAnchor(text, first).start, text.indexOf('Expected: error shown.'))
})

test('a repeated quote still resolves after text is inserted between the copies', () => {
  const text = ['Case A', 'Expected: error shown.', 'Case B', 'Expected: error shown.'].join('\n')
  const second = anchorOn(text, 'Expected: error shown.', 1)
  const edited = text.replace('Case B', 'Case B\nPreconditions: none.')
  const r = resolveAnchor(edited, second)
  assert.equal(r.start, edited.lastIndexOf('Expected: error shown.'))
})

test('the hint short-circuits an unchanged body', () => {
  const a = anchorOn(BODY, 'log in')
  const expected = BODY.indexOf('log in')
  const r = resolveAnchor(BODY, a, expected)
  assert.deepEqual(r, { start: expected, end: expected + 'log in'.length, exact: true })
})

test('a stale hint is ignored rather than trusted', () => {
  const a = anchorOn(BODY, 'log in')
  const r = resolveAnchor(BODY, a, 0)
  assert.equal(BODY.slice(r.start, r.end), 'log in')
})

test('rewrapped whitespace resolves, and says it was not exact', () => {
  const a = createAnchor('Steps: open the app, then log in.', 7, 32)
  assert.equal(a.quote, 'open the app, then log in')
  // The editor reflowed the line; the words are identical.
  const rewrapped = 'Steps: open the app,\nthen log in.'
  const r = resolveAnchor(rewrapped, a)
  assert.equal(r.exact, false)
  assert.equal(rewrapped.slice(r.start, r.end).replace(/\s+/g, ' '), 'open the app, then log in')
})

test('deleted text orphans the thread instead of matching something else', () => {
  const a = anchorOn(BODY, 'log in')
  const gone = BODY.replace('then log in.', 'then give up.')
  assert.equal(resolveAnchor(gone, a), null)
})

test('an empty body or a missing anchor orphans rather than throwing', () => {
  const a = anchorOn(BODY, 'log in')
  assert.equal(resolveAnchor('', a), null)
  assert.equal(resolveAnchor(BODY, null), null)
  assert.equal(resolveAnchor(BODY, { quote: '' }), null)
  assert.equal(resolveAnchor(BODY, { quote: 'log in' }).exact, true, 'context is optional')
})

test('resolveThreads pairs each thread with its range, orphans included', () => {
  const threads = [
    { id: 't_1', anchor: anchorOn(BODY, 'log in') },
    { id: 't_2', anchor: anchorOn(BODY, 'home screen') },
    { id: 't_3', anchor: { quote: 'nowhere to be found', prefix: '', suffix: '' } },
    { id: 't_4', anchor: null },
  ]
  const resolved = resolveThreads(BODY, threads)
  assert.equal(resolved.length, 4)
  assert.equal(BODY.slice(resolved[0].range.start, resolved[0].range.end), 'log in')
  assert.equal(BODY.slice(resolved[1].range.start, resolved[1].range.end), 'home screen')
  assert.equal(resolved[2].range, null, 'quote gone -> orphaned')
  assert.equal(resolved[3].range, null, 'story-level thread -> no range')
})

test('resolveThreads accepts hints keyed by thread id', () => {
  const threads = [{ id: 't_1', anchor: anchorOn(BODY, 'log in') }]
  const at = BODY.indexOf('log in')
  const [{ range }] = resolveThreads(BODY, threads, { t_1: at })
  assert.equal(range.start, at)
})

test('a quote spanning a newline resolves', () => {
  const a = createAnchor(BODY, BODY.indexOf('user.'), BODY.indexOf('Steps:') + 6)
  assert.match(a.quote, /\n/)
  const r = resolveAnchor(BODY, a)
  assert.equal(BODY.slice(r.start, r.end), a.quote)
})

// ---- nth, the last-resort tiebreaker ----------------------------------------

test('createAnchor records which occurrence the selection was', () => {
  const text = ['asdf', 'asdf', 'asdf'].join('\n')
  assert.equal(anchorOn(text, 'asdf', 0).nth, 1)
  assert.equal(anchorOn(text, 'asdf', 1).nth, 2)
  assert.equal(anchorOn(text, 'asdf', 2).nth, 3)
  // A unique quote is still the first (and only) occurrence.
  assert.equal(anchorOn(BODY, 'log in').nth, 1)
})

test('20 identical lines: every anchor resolves to its own copy', () => {
  const text = Array(20).fill('asdf').join('\n')
  const spots = []
  let i = -1
  while ((i = text.indexOf('asdf', i + 1)) !== -1) spots.push(i)

  for (let which = 0; which < spots.length; which++) {
    const anchor = anchorOn(text, 'asdf', which)
    const r = resolveAnchor(text, anchor)
    assert.equal(r.start, spots[which], `copy #${which + 1} resolved to the wrong line`)
  }
})

test('context still beats nth when the text has shifted', () => {
  const text = ['Case A', 'Expected: error shown.', 'Case B', 'Expected: error shown.'].join('\n')
  // Anchored on the second copy, so nth = 2.
  const anchor = anchorOn(text, 'Expected: error shown.', 1)
  assert.equal(anchor.nth, 2)

  // A copy is inserted at the TOP, so the anchored text is now the third
  // occurrence. nth=2 is stale and would point at the wrong line; context has
  // to win.
  const edited = `Expected: error shown.\n${text}`
  const r = resolveAnchor(edited, anchor)
  assert.equal(r.start, edited.lastIndexOf('Expected: error shown.'))
})

test('a stale nth is ignored when context can distinguish the copies', () => {
  const text = ['Case A', 'Expected: error shown.', 'Case B', 'Expected: error shown.'].join('\n')
  const anchor = { ...anchorOn(text, 'Expected: error shown.', 0), nth: 2 }
  // nth says "the second one", context says "the first one" — context wins.
  assert.equal(resolveAnchor(text, anchor).start, text.indexOf('Expected: error shown.'))
})

test('an out-of-range or missing nth falls back to the earliest tied copy', () => {
  const text = Array(20).fill('asdf').join('\n')
  const first = text.indexOf('asdf')
  assert.equal(resolveAnchor(text, { quote: 'asdf', prefix: '', suffix: '', nth: 99 }).start, first)
  assert.equal(resolveAnchor(text, { quote: 'asdf', prefix: '', suffix: '' }).start, first)
  assert.equal(resolveAnchor(text, { quote: 'asdf', prefix: '', suffix: '', nth: 0 }).start, first)
})

test('nth survives a deletion elsewhere in a long identical run', () => {
  const text = Array(20).fill('asdf').join('\n')
  const anchor = anchorOn(text, 'asdf', 11)
  // Two lines removed from the END — the anchored line is still the 12th.
  const edited = Array(18).fill('asdf').join('\n')
  const spots = []
  let i = -1
  while ((i = edited.indexOf('asdf', i + 1)) !== -1) spots.push(i)
  assert.equal(resolveAnchor(edited, anchor).start, spots[11])
})
