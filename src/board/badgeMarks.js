// The Lexical half of inline badges: wrapping a selection in one, recolouring
// one, and taking one off again. The format itself — what reaches the file —
// is badges.js; this is only the document surgery.
//
// A badge is a GenericHTMLNode, which is MDXEditor's node for inline HTML it
// round-trips verbatim. Using it rather than a node of our own is what keeps
// badges out of the import/export visitor business entirely: core already
// parses `<span class="tag-purple">` on the way in and writes it back on the
// way out, so there is nothing here for a save to get wrong.
//
// Wrapping is the fiddly part, and the reason is Lexical's selection model:
// `extract()` hands back BOTH an element and the children of it that fall in
// the selection. Wrapping all of them would move the same text twice, so only
// the topmost nodes are wrapped, and contiguous siblings are wrapped TOGETHER
// — one span per run, not one per text node, or a selection spanning a bold
// word would come out as three adjacent spans in the markdown.

import { $getSelection, $isRangeSelection, $isTextNode } from 'lexical'
import { $createGenericHTMLNode, $isGenericHTMLNode } from '@mdxeditor/editor'

import { BADGE_TAG, badgeClass, badgeColor, isBlankBadgeText, withBadgeClass } from '@/board/badges'

const CLASS = 'class'

function attributeValue(node, name) {
  return node.getAttributes().find((a) => a.name === name)?.value ?? ''
}

// Recolouring is a REPLACE, not an attribute edit, and that is not a stylistic
// choice. GenericHTMLNode paints its attributes onto the element once in
// createDOM() and then returns false from updateDOM() — "the DOM I already made
// is still fine". So calling updateAttributes() to swap the class does update
// the editor state (and would save correctly), while the span on screen keeps
// its old colour until something else forces a remount. That is the whole of
// the "changing the tag colour does nothing" bug.
//
// Building a fresh node and moving the children across gets a createDOM() call,
// so the new class actually lands. The children move rather than being cloned,
// which keeps their keys — and therefore keeps the selection sitting on them.
function recolour(badge, color) {
  const rest = badge.getAttributes().filter((a) => a.name !== CLASS)
  const value = withBadgeClass(attributeValue(badge, CLASS), color)
  const next = $createGenericHTMLNode(BADGE_TAG, badge.getNodeType(), [
    ...rest,
    ...(value ? [{ type: 'mdxJsxAttribute', name: CLASS, value }] : []),
  ])
  for (const child of badge.getChildren()) next.append(child)
  badge.replace(next)
  return next
}

// A GenericHTMLNode is only OUR badge if it is a span carrying a palette key.
// Inline HTML the user pasted from somewhere else stays untouched.
export function isBadge(node) {
  return (
    $isGenericHTMLNode(node) &&
    node.getTag() === BADGE_TAG &&
    !!badgeColor(attributeValue(node, CLASS))
  )
}

// The innermost badge the point sits inside, if any — badges can end up nested
// when one is applied inside another, and the innermost is the one whose
// colour the toolbar shows and whose colour a click changes.
function badgeAt(node) {
  for (let current = node; current; current = current.getParent()) {
    if (isBadge(current)) return current
  }
  return null
}

// The colour to show as active in the toolbar: the badge under the caret, or
// '' for none. Read-only, so it runs against the editor state directly.
export function badgeColorAtSelection(editor) {
  if (!editor) return ''
  return editor.getEditorState().read(() => {
    const selection = $getSelection()
    if (!$isRangeSelection(selection)) return ''
    const badge = badgeAt(selection.anchor.getNode())
    return badge ? badgeColor(attributeValue(badge, CLASS)) : ''
  })
}

// Lift a badge's children out in place and drop the span. Inserting each child
// before the span in order preserves their order, and removing the now-empty
// span is what makes this a formatting toggle rather than a delete.
function unwrap(badge) {
  for (const child of badge.getChildren()) badge.insertBefore(child)
  badge.remove()
}

// Of the nodes a selection extracts, the ones with no selected ancestor. See
// the note at the top: an element and its children both come back, and only
// the element should be moved.
function topmost(nodes) {
  const selected = new Set(nodes.map((n) => n.getKey()))
  return nodes.filter((node) => {
    for (let parent = node.getParent(); parent; parent = parent.getParent()) {
      if (selected.has(parent.getKey())) return false
    }
    return true
  })
}

function wrapSelection(selection, color) {
  const nodes = topmost(selection.extract()).filter((n) => n.isAttached())
  if (!nodes.length) return

  // One span per run of adjacent siblings. `run` is flushed whenever the next
  // node isn't the immediate next sibling of the last one.
  let run = []
  const flush = () => {
    if (!run.length) return
    const badge = $createGenericHTMLNode(BADGE_TAG, 'mdxJsxTextElement', [
      { type: 'mdxJsxAttribute', name: CLASS, value: badgeClass(color) },
    ])
    run[0].insertBefore(badge)
    for (const node of run) badge.append(node)
    run = []
  }

  for (const node of nodes) {
    const previous = run[run.length - 1]
    if (previous && !previous.getNextSibling()?.is(node)) flush()
    run.push(node)
  }
  flush()
}

// The one entry point the toolbar calls. Picking the colour a badge already
// has means "take it off", which is what lets a single swatch grid both apply
// and clear without a separate "none" button — the same gesture the link
// chips' picker uses (see StoryPanel.jsx).
export function toggleBadge(editor, color) {
  if (!editor) return
  editor.update(() => {
    const selection = $getSelection()
    if (!$isRangeSelection(selection)) return

    const existing = badgeAt(selection.anchor.getNode())
    if (existing) {
      const current = badgeColor(attributeValue(existing, CLASS))
      if (!color || current === color) unwrap(existing)
      else recolour(existing, color)
      return
    }

    // Nothing to paint on: a collapsed caret has no words to badge, and there
    // is no badge under it to take off either.
    if (!color || selection.isCollapsed()) return
    wrapSelection(selection, color)
  })
}

// ---- empty badges ----
//
// The rest of this file is the user asking for a badge. This part is the
// cleanup for a badge nobody asked to keep: see isBlankBadgeText in badges.js
// for what goes wrong and why an empty span cannot be got rid of by hand.

// Only text is prunable content. A badge whose one child is an image has no
// text at all, and it is still very much a badge — checking the children
// rather than getTextContent() alone is what stops the cleanup eating it.
export function isEmptyBadge(node) {
  if (!isBadge(node)) return false
  const children = node.getChildren()
  if (!children.length) return true
  return children.every($isTextNode) && isBlankBadgeText(node.getTextContent())
}

// Take the caret with it. The badge being removed is very often the thing the
// user is standing in — they just deleted its last character — and remove()
// alone would leave the selection pointing at a detached node, which Lexical
// resolves by dropping the caret at the top of the document. selectPrevious()
// falls back to the start of the parent when there is no previous sibling, so
// a badge at the head of a paragraph behaves too.
export function pruneEmptyBadge(node) {
  const selection = $getSelection()
  const inside =
    $isRangeSelection(selection) &&
    [selection.anchor, selection.focus].some((point) => {
      const at = point.getNode()
      return at.is(node) || node.isParentOf(at)
    })
  if (inside) node.selectPrevious()
  node.remove()
}

// Every empty badge currently in the document, innermost first. Used for the
// one sweep over content that was imported before the transform existed; live
// editing never needs it, since the transform sees each badge go empty.
export function findEmptyBadges(root) {
  const found = []
  const walk = (node) => {
    if (typeof node.getChildren !== 'function') return
    for (const child of node.getChildren()) walk(child)
    if (isEmptyBadge(node)) found.push(node)
  }
  walk(root)
  return found
}
