import test from 'node:test'
import assert from 'node:assert/strict'

import { fromMarkdown } from 'mdast-util-from-markdown'
import { toMarkdown } from 'mdast-util-to-markdown'

// Relative rather than the `@/` alias — that alias is a Vite resolution, and
// this module is imported directly by `node --test`. Same reason as badges.js.
import { BLANK_PARAGRAPH_FILLER, isBlankParagraph, isEmptyParagraph } from './blankLines.js'

const para = (...values) => ({ type: 'paragraph', children: values.map((value) => ({ type: 'text', value })) })

test('the filler is U+00A0, not a plain space', () => {
  assert.equal(BLANK_PARAGRAPH_FILLER, '\u00A0')
  assert.notEqual(BLANK_PARAGRAPH_FILLER, '\u0020')
  assert.equal(BLANK_PARAGRAPH_FILLER.length, 1)
})

// The whole reason the filler exists: prove the format really does destroy an
// empty paragraph, so nobody later "simplifies" this away as unnecessary.
test('an empty paragraph does NOT survive a markdown round trip', () => {
  const tree = {
    type: 'root',
    children: [para('one'), { type: 'paragraph', children: [] }, para('two')],
  }
  const back = fromMarkdown(toMarkdown(tree))
  assert.equal(back.children.length, 2, 'the empty paragraph is gone')
})

test('a filler paragraph DOES survive a markdown round trip', () => {
  const tree = {
    type: 'root',
    children: [para('one'), para(BLANK_PARAGRAPH_FILLER), para(BLANK_PARAGRAPH_FILLER), para('two')],
  }
  const serialized = toMarkdown(tree)
  // No visible markup reached the file — just the invisible character.
  assert.ok(!serialized.includes('&#'), `unexpected entity in ${JSON.stringify(serialized)}`)

  const back = fromMarkdown(serialized)
  assert.equal(back.children.length, 4)
  assert.ok(isBlankParagraph(back.children[1]))
  assert.ok(isBlankParagraph(back.children[2]))
  assert.equal(back.children[0].children[0].value, 'one')
  assert.equal(back.children[3].children[0].value, 'two')
})

// The gap the user reported: several blank lines in a row, each its own
// paragraph, all of them still there after a save and a reopen.
test('a run of blank lines keeps its size', () => {
  const children = [para('a')]
  for (let i = 0; i < 3; i += 1) children.push(para(BLANK_PARAGRAPH_FILLER))
  children.push(para('b'))

  const back = fromMarkdown(toMarkdown({ type: 'root', children }))
  assert.equal(back.children.filter(isBlankParagraph).length, 3)
  assert.equal(back.children.length, 5)
})

test('isBlankParagraph: only whitespace-only paragraphs count', () => {
  assert.ok(isBlankParagraph(para(BLANK_PARAGRAPH_FILLER)))
  assert.ok(isBlankParagraph(para(` ${BLANK_PARAGRAPH_FILLER} `)), 'reflowed by a formatter')
  assert.ok(isBlankParagraph(para(BLANK_PARAGRAPH_FILLER, BLANK_PARAGRAPH_FILLER)), 'split across text nodes')

  assert.ok(!isBlankParagraph(para('text')))
  // Content the user typed, which happens to contain the filler. Emptying this
  // would delete their words.
  assert.ok(!isBlankParagraph(para(`10${BLANK_PARAGRAPH_FILLER}kg`)))
  assert.ok(!isBlankParagraph({ type: 'paragraph', children: [] }), 'nothing to preserve')
  assert.ok(!isBlankParagraph({ type: 'heading', children: [{ type: 'text', value: BLANK_PARAGRAPH_FILLER }] }))
  // A paragraph whose filler sits beside a link is not a spacer.
  assert.ok(
    !isBlankParagraph({
      type: 'paragraph',
      children: [{ type: 'text', value: BLANK_PARAGRAPH_FILLER }, { type: 'link', url: './x.md', children: [] }],
    }),
  )
  assert.ok(!isBlankParagraph(null))
})

test('isEmptyParagraph: childless only', () => {
  assert.ok(isEmptyParagraph({ getChildrenSize: () => 0 }))
  assert.ok(!isEmptyParagraph({ getChildrenSize: () => 1 }))
  // A node that cannot answer is not empty — better to write it out untouched
  // than to replace something unrecognized with a blank line.
  assert.ok(!isEmptyParagraph({}))
  assert.ok(!isEmptyParagraph(null))
})
