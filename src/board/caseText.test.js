// Headless tests for the Lexical half of comment highlighting: the plain-text
// walk, the offset→node mapping, and applying real MarkNodes to a real Lexical
// document. No DOM — Lexical's editor state works without one, which is why
// this logic lives apart from the MDXEditor plugin that installs it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createEditor,
  $getRoot,
  $createParagraphNode,
  $createTextNode,
  $createRangeSelection,
  $getSelection,
  $isRangeSelection,
  $setSelection,
} from 'lexical'
import { HeadingNode } from '@lexical/rich-text'
import { ListNode, ListItemNode, $createListNode, $createListItemNode } from '@lexical/list'
import { $isMarkNode, MarkNode } from '@lexical/mark'

import { applyCommentMarks, documentText, pointAt } from './caseText.js'
import { createAnchor } from './anchor.js'

function makeEditor() {
  const editor = createEditor({
    nodes: [MarkNode, HeadingNode, ListNode, ListItemNode],
    onError: (e) => {
      throw e
    },
  })
  return editor
}

// Seed a document as an array of paragraph strings.
function seed(editor, paragraphs) {
  editor.update(
    () => {
      const root = $getRoot()
      root.clear()
      for (const text of paragraphs) {
        const p = $createParagraphNode()
        p.append($createTextNode(text))
        root.append(p)
      }
    },
    { discrete: true },
  )
}

function readText(editor) {
  return editor.getEditorState().read(() => documentText().text)
}

// Every MarkNode in the document, as { ids, text }.
function readMarks(editor) {
  return editor.getEditorState().read(() => {
    const found = []
    const walk = (node) => {
      if (typeof node.getChildren !== 'function') return
      if ($isMarkNode(node)) found.push({ ids: node.getIDs(), text: node.getTextContent() })
      for (const child of node.getChildren()) walk(child)
    }
    walk($getRoot())
    return found
  })
}

test('documentText joins blocks with a newline and maps each text node', () => {
  const editor = makeEditor()
  seed(editor, ['Preconditions: a registered user.', 'Steps: log in.'])

  const { text, segments } = editor.getEditorState().read(() => documentText())
  assert.equal(text, 'Preconditions: a registered user.\nSteps: log in.')
  assert.equal(segments.length, 2)
  // Segments must tile the text exactly, in document order.
  assert.equal(text.slice(segments[0].start, segments[0].end), 'Preconditions: a registered user.')
  assert.equal(text.slice(segments[1].start, segments[1].end), 'Steps: log in.')
})

test('documentText walks inline nodes within one block in order', () => {
  const editor = makeEditor()
  editor.update(
    () => {
      const root = $getRoot()
      root.clear()
      const p = $createParagraphNode()
      // Distinct formats, as **bold** in the middle of a line produces.
      // Adjacent nodes of the SAME format are merged by Lexical's
      // normalization, so plain/plain/plain would arrive here as one node.
      const bold = $createTextNode('log in')
      bold.toggleFormat('bold')
      p.append($createTextNode('Steps: '), bold, $createTextNode(' now.'))
      root.append(p)
    },
    { discrete: true },
  )

  const { text, segments } = editor.getEditorState().read(() => documentText())
  assert.equal(text, 'Steps: log in now.')
  assert.equal(segments.length, 3)
  assert.equal(text.slice(segments[1].start, segments[1].end), 'log in')
  // The formatting boundary must not put a gap or overlap in the mapping.
  assert.equal(segments[0].end, segments[1].start)
  assert.equal(segments[1].end, segments[2].start)
})

test('an anchor spanning a formatting boundary resolves and marks correctly', () => {
  const editor = makeEditor()
  editor.update(
    () => {
      const root = $getRoot()
      root.clear()
      const p = $createParagraphNode()
      const bold = $createTextNode('log in')
      bold.toggleFormat('bold')
      p.append($createTextNode('Steps: '), bold, $createTextNode(' now.'))
      root.append(p)
    },
    { discrete: true },
  )
  const text = readText(editor)
  const at = text.indexOf('Steps: log in')
  const threads = [{ id: 't_1', status: 'open', anchor: createAnchor(text, at, at + 'Steps: log in'.length) }]

  const { orphaned } = applyCommentMarks(editor, threads)
  assert.deepEqual(orphaned, [])
  const marks = readMarks(editor)
  assert.equal(
    marks.map((m) => m.text).join(''),
    'Steps: log in',
    'the mark covers the text across the bold boundary',
  )
  assert.equal(readText(editor), text)
})

test('documentText separates list items onto their own lines', () => {
  const editor = makeEditor()
  editor.update(
    () => {
      const root = $getRoot()
      root.clear()
      const list = $createListNode('bullet')
      for (const label of ['first', 'second']) {
        const item = $createListItemNode()
        item.append($createTextNode(label))
        list.append(item)
      }
      root.append(list)
    },
    { discrete: true },
  )
  assert.equal(readText(editor), 'first\nsecond')
})

test('pointAt maps an offset back to the node that produced it', () => {
  const editor = makeEditor()
  seed(editor, ['Preconditions: ok.', 'Steps: log in.'])

  editor.getEditorState().read(() => {
    const { text, segments } = documentText()
    const at = text.indexOf('log in')
    const point = pointAt(segments, at)
    // Offset is relative to the node, not the document.
    assert.equal(point.key, segments[1].key)
    assert.equal(point.offset, at - segments[1].start)

    // Start and end of the document both resolve.
    assert.equal(pointAt(segments, 0).key, segments[0].key)
    assert.equal(pointAt(segments, 0).offset, 0)
    const last = pointAt(segments, text.length)
    assert.equal(last.key, segments[1].key)
  })
})

test('applyCommentMarks wraps exactly the anchored words', () => {
  const editor = makeEditor()
  seed(editor, ['Preconditions: a registered user.', 'Steps: log in.'])
  const text = readText(editor)
  const at = text.indexOf('log in')

  const threads = [{ id: 't_1', status: 'open', anchor: createAnchor(text, at, at + 'log in'.length) }]
  const { hints, orphaned } = applyCommentMarks(editor, threads)

  assert.deepEqual(orphaned, [])
  assert.equal(hints.t_1, at)
  const marks = readMarks(editor)
  assert.equal(marks.length, 1)
  assert.deepEqual(marks[0].ids, ['t_1'])
  assert.equal(marks[0].text, 'log in')
  // The document's text must be untouched by highlighting.
  assert.equal(readText(editor), text)
})

test('several threads each get their own mark', () => {
  const editor = makeEditor()
  seed(editor, ['Preconditions: a registered user.', 'Steps: log in and out.'])
  const text = readText(editor)

  const anchorFor = (quote) => {
    const at = text.indexOf(quote)
    return createAnchor(text, at, at + quote.length)
  }
  const threads = [
    { id: 't_1', status: 'open', anchor: anchorFor('registered user') },
    { id: 't_2', status: 'open', anchor: anchorFor('log in') },
    { id: 't_3', status: 'open', anchor: anchorFor('and out') },
  ]
  const { orphaned } = applyCommentMarks(editor, threads)
  assert.deepEqual(orphaned, [])

  const marks = readMarks(editor)
  assert.equal(marks.length, 3)
  assert.deepEqual(
    marks.map((m) => m.text).sort(),
    ['and out', 'log in', 'registered user'],
  )
  assert.equal(readText(editor), text, 'text unchanged after three marks')
})

test('a mark spanning two text nodes within a block still wraps the right words', () => {
  const editor = makeEditor()
  editor.update(
    () => {
      const root = $getRoot()
      root.clear()
      const p = $createParagraphNode()
      p.append($createTextNode('Steps: '), $createTextNode('log in'), $createTextNode(' now.'))
      root.append(p)
    },
    { discrete: true },
  )
  const text = readText(editor)
  const at = text.indexOf('log in now')
  const threads = [{ id: 't_1', status: 'open', anchor: createAnchor(text, at, at + 'log in now'.length) }]

  const { orphaned } = applyCommentMarks(editor, threads)
  assert.deepEqual(orphaned, [])
  const marks = readMarks(editor)
  assert.ok(marks.length >= 1)
  assert.equal(marks.map((m) => m.text).join(''), 'log in now')
  assert.equal(readText(editor), text)
})

test('resolved threads and story-level threads get no mark', () => {
  const editor = makeEditor()
  seed(editor, ['Steps: log in.'])
  const text = readText(editor)
  const at = text.indexOf('log in')

  const threads = [
    { id: 't_done', status: 'resolved', anchor: createAnchor(text, at, at + 6) },
    { id: 't_story', status: 'open', anchor: null },
  ]
  const { orphaned } = applyCommentMarks(editor, threads)
  assert.deepEqual(orphaned, [], 'neither is orphaned — neither was meant to draw')
  assert.deepEqual(readMarks(editor), [])
})

test('a thread whose text is gone is reported orphaned, and marks nothing', () => {
  const editor = makeEditor()
  seed(editor, ['Steps: log in.'])
  const threads = [{ id: 't_gone', status: 'open', anchor: { quote: 'nowhere', prefix: '', suffix: '' } }]

  const { hints, orphaned } = applyCommentMarks(editor, threads)
  assert.deepEqual(orphaned, ['t_gone'])
  assert.equal(hints.t_gone, undefined)
  assert.deepEqual(readMarks(editor), [])
})

test('reapplying is idempotent — old marks are cleared, not stacked', () => {
  const editor = makeEditor()
  seed(editor, ['Steps: log in.'])
  const text = readText(editor)
  const at = text.indexOf('log in')
  const threads = [{ id: 't_1', status: 'open', anchor: createAnchor(text, at, at + 6) }]

  let hints = applyCommentMarks(editor, threads).hints
  for (let i = 0; i < 4; i++) hints = applyCommentMarks(editor, threads, hints).hints

  const marks = readMarks(editor)
  assert.equal(marks.length, 1, 'still exactly one mark after five passes')
  assert.equal(marks[0].text, 'log in')
  assert.equal(readText(editor), text)
})

test('a thread removed from the list loses its highlight', () => {
  const editor = makeEditor()
  seed(editor, ['Steps: log in and out.'])
  const text = readText(editor)
  const anchorFor = (q) => createAnchor(text, text.indexOf(q), text.indexOf(q) + q.length)
  const both = [
    { id: 't_1', status: 'open', anchor: anchorFor('log in') },
    { id: 't_2', status: 'open', anchor: anchorFor('and out') },
  ]
  applyCommentMarks(editor, both)
  assert.equal(readMarks(editor).length, 2)

  applyCommentMarks(editor, [both[0]])
  const marks = readMarks(editor)
  assert.equal(marks.length, 1)
  assert.deepEqual(marks[0].ids, ['t_1'])
})

test('a highlight follows its words after text is inserted above', () => {
  const editor = makeEditor()
  seed(editor, ['Steps: log in.'])
  let text = readText(editor)
  const at = text.indexOf('log in')
  const threads = [{ id: 't_1', status: 'open', anchor: createAnchor(text, at, at + 6) }]
  const first = applyCommentMarks(editor, threads)

  // The user types a new paragraph above the anchored text.
  editor.update(
    () => {
      const p = $createParagraphNode()
      p.append($createTextNode('Preconditions: a registered user.'))
      $getRoot().getFirstChild().insertBefore(p)
    },
    { discrete: true },
  )

  const { hints, orphaned } = applyCommentMarks(editor, threads, first.hints)
  assert.deepEqual(orphaned, [])
  const marks = readMarks(editor)
  assert.equal(marks.length, 1)
  assert.equal(marks[0].text, 'log in')
  // The offset really moved, and the stale hint didn't mislead it.
  assert.notEqual(hints.t_1, first.hints.t_1)
})

test('applyCommentMarks on a null editor is a no-op, not a throw', () => {
  const { hints, orphaned } = applyCommentMarks(null, [{ id: 't', anchor: { quote: 'x' } }])
  assert.deepEqual(hints, {})
  assert.deepEqual(orphaned, [])
})

test('an empty document orphans every anchored thread', () => {
  const editor = makeEditor()
  seed(editor, [''])
  const threads = [{ id: 't_1', status: 'open', anchor: { quote: 'log in', prefix: '', suffix: '' } }]
  assert.deepEqual(applyCommentMarks(editor, threads).orphaned, ['t_1'])
})

test('a RangeSelection built from pointAt selects the intended text', () => {
  const editor = makeEditor()
  seed(editor, ['Preconditions: ok.', 'Steps: log in.'])

  const selected = editor.getEditorState().read(() => {
    const { text, segments } = documentText()
    const at = text.indexOf('log in')
    const from = pointAt(segments, at)
    const to = pointAt(segments, at + 'log in'.length)
    const selection = $createRangeSelection()
    selection.anchor.set(from.key, from.offset, 'text')
    selection.focus.set(to.key, to.offset, 'text')
    return selection.getTextContent()
  })
  assert.equal(selected, 'log in')
})

// Regression: $wrapSelectionInMarkNode moves the caret to the end of the mark
// it just created, assuming a user gesture. applyCommentMarks runs on every
// autosave repaint, so without restoring the caret afterward, typing a new
// paragraph and pausing would silently teleport the cursor to wherever an
// unrelated highlight lands elsewhere in the document.
test('applyCommentMarks preserves the caret in an untouched empty paragraph', () => {
  const editor = makeEditor()
  editor.update(
    () => {
      const root = $getRoot()
      root.clear()
      const first = $createParagraphNode()
      first.append($createTextNode('Steps: log in.'))
      const empty = $createParagraphNode()
      root.append(first, empty)
      empty.selectEnd()
    },
    { discrete: true },
  )

  const emptyParagraphKey = editor.getEditorState().read(() => $getRoot().getChildren()[1].getKey())

  const threads = [{ id: 't_1', status: 'open', anchor: { quote: 'log in', prefix: 'Steps: ', suffix: '.' } }]
  const { orphaned } = applyCommentMarks(editor, threads)
  assert.deepEqual(orphaned, [])

  editor.getEditorState().read(() => {
    const selection = $getSelection()
    assert.ok($isRangeSelection(selection))
    assert.equal(selection.anchor.key, emptyParagraphKey)
    assert.equal(selection.isCollapsed(), true)
  })
})

// Same guarantee when the caret sits inside ordinary text, unrelated to any
// highlight — e.g. mid-word in a paragraph with no comment on it.
test('applyCommentMarks preserves a text caret elsewhere in the document', () => {
  const editor = makeEditor()
  seed(editor, ['Steps: log in.', 'Some other unrelated sentence.'])

  editor.update(
    () => {
      const { text, segments } = documentText()
      const at = text.indexOf('unrelated') + 'unrel'.length
      const point = pointAt(segments, at)
      const selection = $createRangeSelection()
      selection.anchor.set(point.key, point.offset, 'text')
      selection.focus.set(point.key, point.offset, 'text')
      $setSelection(selection)
    },
    { discrete: true },
  )

  const threads = [{ id: 't_1', status: 'open', anchor: { quote: 'log in', prefix: 'Steps: ', suffix: '.' } }]
  const { orphaned } = applyCommentMarks(editor, threads)
  assert.deepEqual(orphaned, [])

  editor.getEditorState().read(() => {
    const { text, segments } = documentText()
    const expectedOffset = text.indexOf('unrelated') + 'unrel'.length
    const point = pointAt(segments, expectedOffset)
    const selection = $getSelection()
    assert.ok($isRangeSelection(selection))
    assert.equal(selection.anchor.key, point.key)
    assert.equal(selection.anchor.offset, point.offset)
  })
})
