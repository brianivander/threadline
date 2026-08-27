// Drafts are the crash backup behind manual save, so the behaviour that matters
// is what survives and what is correctly refused. Everything here runs against
// a stand-in localStorage — node has none, and the point is the logic, not the
// browser's implementation of it.

import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'

import { clearDraft, draftKey, draftMatchesDisk, readDraft, writeDraft } from './drafts.js'

function fakeStorage({ failWrites = false } = {}) {
  const map = new Map()
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      if (failWrites) throw new Error('QuotaExceededError')
      map.set(k, v)
    },
    removeItem: (k) => map.delete(k),
  }
}

beforeEach(() => {
  globalThis.localStorage = fakeStorage()
})

test('a draft round-trips', () => {
  writeDraft('/tmp/spec.md', { text: 'half a sentence', baseline: 'original' })
  const draft = readDraft('/tmp/spec.md')
  assert.equal(draft.text, 'half a sentence')
  assert.equal(draft.baseline, 'original')
  assert.ok(draft.at, 'stamped, so the panel can say how old it is')
})

test('drafts are keyed per scope, so two open files never collide', () => {
  writeDraft('/tmp/a.md', { text: 'A', baseline: '' })
  writeDraft('/tmp/b.md', { text: 'B', baseline: '' })
  assert.equal(readDraft('/tmp/a.md').text, 'A')
  assert.equal(readDraft('/tmp/b.md').text, 'B')
  assert.notEqual(draftKey('/tmp/a.md'), draftKey('/tmp/b.md'))
})

test('a case body is scoped by id, not by the file holding it', () => {
  writeDraft('case:login-1', { text: 'given a user', baseline: '' })
  assert.equal(readDraft('case:login-1').text, 'given a user')
  assert.equal(readDraft('case:login-2'), null)
})

test('clearing removes it', () => {
  writeDraft('/tmp/spec.md', { text: 'x', baseline: '' })
  clearDraft('/tmp/spec.md')
  assert.equal(readDraft('/tmp/spec.md'), null)
})

test('reading something that was never written is null, not a throw', () => {
  assert.equal(readDraft('/tmp/never.md'), null)
  assert.equal(readDraft(''), null)
  assert.equal(readDraft(null), null)
})

// The editor must not be taken down by its own safety net.
test('a corrupt entry reads as absent rather than throwing', () => {
  globalThis.localStorage.setItem(draftKey('/tmp/spec.md'), 'not json{{')
  assert.equal(readDraft('/tmp/spec.md'), null)
})

test('an entry without text is not a draft', () => {
  globalThis.localStorage.setItem(draftKey('/tmp/spec.md'), JSON.stringify({ baseline: 'x' }))
  assert.equal(readDraft('/tmp/spec.md'), null)
})

// A full or blocked localStorage is a degraded backup, not a broken editor.
test('a failed write is reported, not thrown', () => {
  globalThis.localStorage = fakeStorage({ failWrites: true })
  assert.equal(writeDraft('/tmp/spec.md', { text: 'x', baseline: '' }), false)
})

// The guard that stops a recovered draft silently reverting a teammate's work.
test('draftMatchesDisk is true only when the file is as the draft left it', () => {
  writeDraft('/tmp/spec.md', { text: 'mine', baseline: 'original' })
  const draft = readDraft('/tmp/spec.md')

  assert.equal(draftMatchesDisk(draft, 'original'), true, 'unchanged since the draft was typed')
  assert.equal(draftMatchesDisk(draft, 'someone else pulled this in'), false, 'file moved on — restoring would revert it')
})

test('an empty baseline and a missing one are the same thing', () => {
  writeDraft('/tmp/new.md', { text: 'first words', baseline: '' })
  assert.equal(draftMatchesDisk(readDraft('/tmp/new.md'), ''), true)
  assert.equal(draftMatchesDisk(readDraft('/tmp/new.md'), undefined), true)
})
