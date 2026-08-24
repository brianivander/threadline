// The Lexical half of comment highlighting — the Google-Docs part: a comment
// marks the exact words it's about, not the whole story.
//
// Deliberately free of any @mdxeditor/editor import: everything here is a
// function of the Lexical document, so it runs (and is tested) headless in
// Node. The MDXEditor plugin that installs it lives in commentMarks.js.
//
// The editor is MDXEditor (Lexical) in WYSIWYG mode, so what the user selects
// is RENDERED text ("Steps: log in"), not markdown source ("**Steps:** log
// in"). Anchors are therefore resolved against the rendered text, which is
// also exactly the text quoted back into the markdown file. Nothing anywhere
// stores an offset into the file: the stored anchor is a quote plus its
// surrounding context (see anchor.js), so it survives edits and the markdown
// stays free of coordinates that could go stale.
//
// `documentText()` is the single definition of "the case's plain text". Both
// capturing a selection and resolving an anchor go through it, so the two
// always agree — that consistency matters more than matching any particular
// external rendering of the same content.
//
// Highlights are Lexical MarkNodes, applied from the anchors after load and
// stripped on export (see markExportVisitor): they exist in the editor, never
// in the file. That's what keeps a highlight from ever being saved into a
// story, and why a mark can be rebuilt from scratch on every load without the
// document changing.

import {
  $getRoot,
  $isElementNode,
  $isTextNode,
  $createRangeSelection,
  $getSelection,
  $isRangeSelection,
  $setSelection,
} from 'lexical'
import { $isMarkNode, $unwrapMarkNode, $wrapSelectionInMarkNode } from '@lexical/mark'

// Relative rather than the usual `@/` alias: that alias is a Vite resolution,
// and this module is imported directly by `node --test`.
import { createAnchor, resolveAnchor } from './anchor.js'

// documentText/pointAt are exported for the headless tests in caseText.test.js
// — they're the mapping between plain-text offsets and Lexical nodes that
// every highlight depends on, so they're worth pinning down directly.
export { documentText, pointAt }

// Blocks are joined with a single newline. The exact separator is arbitrary —
// it only has to be the same on the way in and the way out.
const BLOCK_SEPARATOR = '\n'

// Walk the document in order, building its plain text alongside a map from
// text ranges back to the Lexical nodes that produced them.
// -> { text, segments: [{ key, start, end }] }
function documentText() {
  const segments = []
  let text = ''

  const visitBlock = (node) => {
    const walk = (current) => {
      if ($isTextNode(current)) {
        const content = current.getTextContent()
        if (!content) return
        segments.push({ key: current.getKey(), start: text.length, end: text.length + content.length })
        text += content
        return
      }
      if (!$isElementNode(current)) return
      const children = current.getChildren()
      for (const child of children) {
        // A nested block (a list item inside a list) starts its own line.
        if ($isElementNode(child) && !child.isInline() && text.length) text += BLOCK_SEPARATOR
        walk(child)
      }
    }
    walk(node)
  }

  const blocks = $getRoot().getChildren()
  blocks.forEach((block, i) => {
    if (i > 0) text += BLOCK_SEPARATOR
    visitBlock(block)
  })

  return { text, segments }
}

// Turn an offset in that plain text into a (nodeKey, offsetWithinNode) point.
// Offsets landing on a block separator have no text node of their own, so they
// snap to the nearest real one.
function pointAt(segments, offset) {
  for (const segment of segments) {
    if (offset >= segment.start && offset <= segment.end) {
      return { key: segment.key, offset: offset - segment.start }
    }
  }
  const last = segments[segments.length - 1]
  return last ? { key: last.key, offset: last.end - last.start } : null
}

// Read the current selection as an anchor ({ quote, prefix, suffix }), or null
// if nothing is selected. Used by the editor's right-click -> Comment.
export function anchorFromSelection(editor) {
  return editor.getEditorState().read(() => {
    const selection = $getSelection()
    if (!$isRangeSelection(selection) || selection.isCollapsed()) return null

    const { text, segments } = documentText()
    const offsetOf = (point) => {
      const segment = segments.find((s) => s.key === point.key)
      if (segment) return segment.start + point.offset
      // The point sits in an element rather than a text node (a whole-block
      // selection); fall back to the block's own span.
      return null
    }

    let start = offsetOf(selection.anchor)
    let end = offsetOf(selection.focus)
    if (start === null || end === null) {
      // Whole-block or cross-block selection whose endpoints aren't text
      // nodes: use the selected text and locate it in the document instead.
      const selected = selection.getTextContent()
      if (!selected.trim()) return null
      const at = text.indexOf(selected)
      if (at === -1) return null
      start = at
      end = at + selected.length
    }
    if (start > end) [start, end] = [end, start]
    return createAnchor(text, start, end)
  })
}

// Remove every highlight. Marks are rebuilt from the anchors on each pass, so
// this runs first and unconditionally.
function unwrapAllMarks() {
  const seen = new Set()
  const walk = (node) => {
    if (!$isElementNode(node)) return
    for (const child of node.getChildren()) walk(child)
    if ($isMarkNode(node) && !seen.has(node.getKey())) {
      seen.add(node.getKey())
      $unwrapMarkNode(node)
    }
  }
  walk($getRoot())
}

// Snapshot the caret so a mark repaint can restore it afterward. A point
// inside a text node is captured as a plain-text offset (stable across the
// text-node splitting that wrapping does); a point inside an element (e.g.
// caret in an empty paragraph) has no text offset, so it's captured as-is.
function captureCaret() {
  const selection = $getSelection()
  if (!$isRangeSelection(selection)) return null

  const { segments } = documentText()
  const pointToOffset = (point) => {
    const segment = segments.find((s) => s.key === point.key)
    return segment ? segment.start + point.offset : null
  }

  const anchorOffset = pointToOffset(selection.anchor)
  const focusOffset = pointToOffset(selection.focus)
  if (anchorOffset !== null && focusOffset !== null) {
    return { kind: 'text', anchorOffset, focusOffset }
  }
  return {
    kind: 'element',
    anchor: { key: selection.anchor.key, offset: selection.anchor.offset, type: selection.anchor.type },
    focus: { key: selection.focus.key, offset: selection.focus.offset, type: selection.focus.type },
  }
}

// Restore a snapshot taken by captureCaret, remapping text offsets back
// through the (possibly rewrapped) document.
function restoreCaret(saved) {
  if (!saved) return
  const selection = $createRangeSelection()
  if (saved.kind === 'text') {
    const { segments } = documentText()
    const anchor = pointAt(segments, saved.anchorOffset)
    const focus = pointAt(segments, saved.focusOffset)
    if (!anchor || !focus) return
    selection.anchor.set(anchor.key, anchor.offset, 'text')
    selection.focus.set(focus.key, focus.offset, 'text')
  } else {
    selection.anchor.set(saved.anchor.key, saved.anchor.offset, saved.anchor.type)
    selection.focus.set(saved.focus.key, saved.focus.offset, saved.focus.type)
  }
  $setSelection(selection)
}

// Paint the given threads' anchors as MarkNodes.
//
// Returns { hints, orphaned }: `hints` are the resolved start offsets, fed
// back in next time so an unchanged case re-resolves in one comparison
// instead of a scan; `orphaned` are the thread ids whose quoted text is no
// longer in the document — the panel still lists those, without a highlight,
// rather than pretending they resolved.
export function applyCommentMarks(editor, threads, hints = {}) {
  const result = { hints: {}, orphaned: [] }
  if (!editor) return result

  // `discrete` forces the update to flush synchronously so the caller sees a
  // settled document; 'history-merge' keeps highlighting out of the undo
  // stack, so the user's first Ctrl+Z is their own last edit.
  editor.update(
    () => {
      // $wrapSelectionInMarkNode moves the caret to the end of the mark it
      // creates, assuming it's called from a user gesture. This repaint runs
      // on every autosave, so without saving and restoring the caret here,
      // the typist's cursor would jump to wherever a highlight lands.
      const savedCaret = captureCaret()

      unwrapAllMarks()

      const anchored = (threads || []).filter((t) => t.anchor?.quote && t.status !== 'resolved')
      for (const thread of anchored) {
        // Recomputed per thread: wrapping splits text nodes, which invalidates
        // any map taken before it.
        const { text, segments } = documentText()
        const range = resolveAnchor(text, thread.anchor, hints[thread.id])
        if (!range) {
          result.orphaned.push(thread.id)
          continue
        }
        const from = pointAt(segments, range.start)
        const to = pointAt(segments, range.end)
        if (!from || !to) {
          result.orphaned.push(thread.id)
          continue
        }

        const selection = $createRangeSelection()
        selection.anchor.set(from.key, from.offset, 'text')
        selection.focus.set(to.key, to.offset, 'text')
        try {
          $wrapSelectionInMarkNode(selection, false, thread.id)
          result.hints[thread.id] = range.start
        } catch {
          // A range the editor won't wrap (a boundary Lexical rejects) is
          // reported as orphaned rather than left half-applied.
          result.orphaned.push(thread.id)
        }
      }

      restoreCaret(savedCaret)
    },
    { discrete: true, tag: 'history-merge' },
  )

  tagMarkElements(editor)
  return result
}

// Stamp each highlight's DOM element with its thread id. MarkNode carries its
// ids in editor state, not in the DOM, so this is what lets CSS (and the
// active-thread tint below) reach an individual highlight.
function tagMarkElements(editor) {
  editor.getEditorState().read(() => {
    const walk = (node) => {
      if (!$isElementNode(node)) return
      if ($isMarkNode(node)) {
        const element = editor.getElementByKey(node.getKey())
        if (element) element.dataset.threadId = node.getIDs()[0] || ''
      }
      for (const child of node.getChildren()) walk(child)
    }
    walk($getRoot())
  })
}

// Give the focused thread's highlight a stronger tint, so selecting a comment
// in the panel shows you where it points.
export function setActiveMark(editor, threadId) {
  if (!editor) return
  const root = editor.getRootElement()
  if (!root) return
  for (const element of root.querySelectorAll('mark[data-thread-id]')) {
    element.toggleAttribute('data-active', element.dataset.threadId === threadId)
  }
}

// The thread whose highlight the caret currently sits in, or null. Lets
// clicking highlighted text focus its comment, the way it does in a doc.
export function threadIdAtSelection(editor) {
  return editor.getEditorState().read(() => {
    const selection = $getSelection()
    if (!$isRangeSelection(selection)) return null
    let node = selection.anchor.getNode()
    while (node) {
      if ($isMarkNode(node)) return node.getIDs()[0] || null
      node = node.getParent()
    }
    return null
  })
}
