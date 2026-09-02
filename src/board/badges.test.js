// The badge format's only stateful part is the class attribute, and it is what
// reaches the markdown file — so it is worth pinning down directly. Everything
// else about a badge is a Lexical mutation (badgeMarks.js) that needs a live
// editor; this is the half that has to be exactly right on disk.

import assert from 'node:assert/strict'
import test from 'node:test'

import { badgeClass, badgeColor, isBlankBadgeText, withBadgeClass } from './badges.js'

test('a palette key becomes its class', () => {
  assert.equal(badgeClass('purple'), 'tag-purple')
  assert.equal(badgeClass('light-blue'), 'tag-light-blue')
})

test('an unknown colour is not a badge', () => {
  assert.equal(badgeClass('chartreuse'), '')
  assert.equal(badgeClass(''), '')
  assert.equal(badgeClass(undefined), '')
})

test('the colour reads back out of the class', () => {
  assert.equal(badgeColor('tag-purple'), 'purple')
  assert.equal(badgeColor('tag-light-blue'), 'light-blue')
})

// A span pasted in from elsewhere can carry classes of its own; ours only has
// to be findable among them.
test('the colour is found among other classes', () => {
  assert.equal(badgeColor('foo tag-green bar'), 'green')
  assert.equal(badgeColor('  tag-red  '), 'red')
})

test('a span with no badge class is not a badge', () => {
  assert.equal(badgeColor('callout warning'), '')
  assert.equal(badgeColor('tag-chartreuse'), '')
  assert.equal(badgeColor(''), '')
  assert.equal(badgeColor(null), '')
})

test('recolouring replaces the badge token and keeps the rest', () => {
  assert.equal(withBadgeClass('foo tag-green bar', 'red'), 'foo tag-red bar')
  assert.equal(withBadgeClass('tag-green', 'red'), 'tag-red')
})

test('recolouring a plain span adds the token', () => {
  assert.equal(withBadgeClass('callout', 'red'), 'callout tag-red')
  assert.equal(withBadgeClass('', 'red'), 'tag-red')
})

// Clearing the colour is how a badge is removed, and it must not leave an
// empty class behind for the exporter to write out.
test('clearing the colour drops the token', () => {
  assert.equal(withBadgeClass('foo tag-green bar', ''), 'foo bar')
  assert.equal(withBadgeClass('tag-green', ''), '')
})

// The predicate behind the empty-badge cleanup. A badge that has lost its text
// is the undeletable chip described in badges.js, and whitespace counts as
// lost — a badge around one space is the same chip wearing a disguise.
test('a badge with no text left is empty', () => {
  assert.equal(isBlankBadgeText(''), true)
  assert.equal(isBlankBadgeText(null), true)
  assert.equal(isBlankBadgeText(undefined), true)
})

test('whitespace-only counts as empty', () => {
  assert.equal(isBlankBadgeText(' '), true)
  assert.equal(isBlankBadgeText('   \t\n'), true)
  // A non-breaking space is what a blank paragraph is padded with on the way
  // to the file (see blankLines.js), so it turns up in text more than it looks
  // like it should. It is still nothing to badge.
  assert.equal(isBlankBadgeText('\u00a0'), true)
})

test('a badge with text is not empty', () => {
  assert.equal(isBlankBadgeText('a'), false)
  assert.equal(isBlankBadgeText('  hello  '), false)
})
