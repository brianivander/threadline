// Tests for src/board/imageSize.js — deciding when an <img>'s inline size is
// left over from a drag and must go.
//
// Node has no DOM, and the point here is the decision rather than the
// browser's implementation of it, so these run against a stand-in element with
// the two things the code touches: a style it can read and remove properties
// from, and attributes it can read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clearStaleImageSizes, findScrollContainer } from './imageSize.js'

function fakeImage({ style = {}, attrs = {} } = {}) {
  const props = { ...style }
  return {
    style: {
      getPropertyValue: (name) => props[name] || '',
      removeProperty: (name) => delete props[name],
    },
    getAttribute: (name) => (name in attrs ? String(attrs[name]) : null),
    // Test-only view of what survived.
    inline: () => ({ ...props }),
  }
}

test('an inline size with no attribute behind it is left over from a drag', () => {
  // What an undo back to the image's natural size leaves: the node carries no
  // size any more, so nothing should be constraining the picture.
  const img = fakeImage({ style: { width: '420px', height: '260px' } })
  assert.equal(clearStaleImageSizes([img]), 1)
  assert.deepEqual(img.inline(), {})
})

test('an inline size that agrees with the attribute is left alone', () => {
  // The state immediately after a resize. Removing and re-applying the same
  // value would redraw the image at the end of every drag for nothing.
  const img = fakeImage({ style: { width: '420px', height: '260px' }, attrs: { width: 420, height: 260 } })
  assert.equal(clearStaleImageSizes([img]), 0)
  assert.deepEqual(img.inline(), { width: '420px', height: '260px' })
})

test('an inline size that disagrees with the attribute goes', () => {
  // An undo from one explicit size back to another.
  const img = fakeImage({ style: { width: '420px', height: '260px' }, attrs: { width: 200, height: 120 } })
  assert.equal(clearStaleImageSizes([img]), 1)
  assert.deepEqual(img.inline(), {})
})

test('both axes are cleared together, so an image never ends up stretched', () => {
  const img = fakeImage({ style: { width: '420px', height: '260px' }, attrs: { width: 420 } })
  assert.equal(clearStaleImageSizes([img]), 1)
  assert.deepEqual(img.inline(), { width: '420px' }, 'the axis that still agrees stays')
})

test('an image with no inline size at all is untouched', () => {
  const img = fakeImage({ attrs: { width: 420 } })
  assert.equal(clearStaleImageSizes([img]), 0)
})

test('counts images changed, not properties, and survives an empty list', () => {
  const stale = () => fakeImage({ style: { width: '420px', height: '260px' } })
  assert.equal(clearStaleImageSizes([stale(), stale(), fakeImage()]), 2)
  assert.equal(clearStaleImageSizes([]), 0)
  assert.equal(clearStaleImageSizes(null), 0)
})

// ---- findScrollContainer -----------------------------------------------------
//
// The scroller above the editor is what has to be held still when a resize
// ends. Same approach as above: a stand-in chain of elements with the three
// things the code reads.

function fakeChain(specs) {
  // specs are innermost-first; each is { overflowY, scrollHeight, clientHeight }.
  // Returns the innermost, which is where the walk starts.
  let leaf = null
  let previous = null
  for (const spec of specs) {
    const node = { ...spec, parentElement: null }
    if (previous) previous.parentElement = node
    else leaf = node
    previous = node
  }
  return leaf
}

const styleOf = (node) => ({ overflowY: node.overflowY })

test('findScrollContainer walks up to the first ancestor that actually scrolls', () => {
  const leaf = fakeChain([
    { overflowY: 'visible', scrollHeight: 100, clientHeight: 100 },
    // Scrollable overflow, but nothing to scroll — the panels are full of these.
    { overflowY: 'auto', scrollHeight: 200, clientHeight: 200 },
    { overflowY: 'hidden', scrollHeight: 900, clientHeight: 300 },
    { overflowY: 'auto', scrollHeight: 900, clientHeight: 300 },
  ])
  const found = findScrollContainer(leaf, styleOf)
  assert.equal(found?.scrollHeight, 900)
  assert.equal(found?.overflowY, 'auto')
})

test('findScrollContainer starts at the parent, never the element itself', () => {
  const self = { overflowY: 'auto', scrollHeight: 900, clientHeight: 300, parentElement: null }
  assert.equal(findScrollContainer(self, styleOf), null)
})

test('findScrollContainer returns null when nothing above scrolls, and tolerates no element', () => {
  const leaf = fakeChain([
    { overflowY: 'visible', scrollHeight: 100, clientHeight: 100 },
    { overflowY: 'hidden', scrollHeight: 900, clientHeight: 300 },
  ])
  assert.equal(findScrollContainer(leaf, styleOf), null)
  assert.equal(findScrollContainer(null, styleOf), null)
})
