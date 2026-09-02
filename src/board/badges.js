// Inline BADGES — a run of text carrying one of the palette colours as a
// background, the way a Notion "tag" or a Jira label reads.
//
// Stored in the markdown as `<span class="tag-purple">text</span>`, and that
// choice is the load-bearing one here:
//
//   - A badge is a FORMAT, not a container. It wraps inline content, so it
//     stacks with everything else: a link inside a badge, a badge inside a
//     link, a badge on a bullet, bold inside a badge. Anything modelled as a
//     leaf node carrying its own `url` could not — the badge and the URL are
//     separate things that happen to sit on the same words.
//   - MDXEditor already round-trips inline HTML as a GenericHTMLNode (`span`
//     is in its own htmlTags list), so there is no custom Lexical node, no
//     export visitor, and — the part that matters — no nested editor island.
//     A nested editor is its own selection context, which is exactly what
//     stops commenting from working inside a table cell today (see
//     CaseEditor.jsx). A badge must not inherit that.
//   - `span` and not `mark`: comment highlights are already `<mark>` (see the
//     CSS in index.css), and a badge has to be able to overlap a comment
//     without the two fighting over the same selector.
//
// The colour travels as a palette KEY in the class name, never a literal, so
// the story file stays readable and the actual colours stay in index.css —
// the same contract linkTags.js describes for the link chips.

// Relative rather than the usual `@/` alias: that alias is a Vite resolution,
// and this module is imported directly by `node --test`.
import { TAG_COLORS } from './linkTags.js'

const KEYS = new Set(TAG_COLORS)

// The element badges are written as, and the class prefix that marks a span as
// one of ours. A span with any other class is somebody else's HTML and is left
// alone.
export const BADGE_TAG = 'span'
const PREFIX = 'tag-'

// A palette key -> the class that carries it. An unknown key yields '', which
// callers read as "not a badge" rather than writing a class nothing styles.
export function badgeClass(color) {
  return KEYS.has(color) ? `${PREFIX}${color}` : ''
}

// The inverse, tolerant of a class attribute that carries more than ours: a
// span the user pasted in from elsewhere may well have other classes on it,
// and finding our key among them is enough to treat it as a badge.
export function badgeColor(className) {
  for (const token of String(className || '').trim().split(/\s+/)) {
    if (!token.startsWith(PREFIX)) continue
    const color = token.slice(PREFIX.length)
    if (KEYS.has(color)) return color
  }
  return ''
}

// Swapping the colour of an existing badge has to preserve whatever else was
// on the attribute, so this replaces our token in place instead of rewriting
// the whole value. A class with no badge token yet gets one appended.
export function withBadgeClass(className, color) {
  const next = badgeClass(color)
  const tokens = String(className || '').trim().split(/\s+/).filter(Boolean)
  const at = tokens.findIndex((t) => t.startsWith(PREFIX) && KEYS.has(t.slice(PREFIX.length)))
  if (at === -1) {
    if (next) tokens.push(next)
  } else if (next) {
    tokens[at] = next
  } else {
    tokens.splice(at, 1)
  }
  return tokens.join(' ')
}

// Whether a badge's text amounts to nothing, and so whether the badge has
// stopped being a badge. Deleting the words inside a span does NOT delete the
// span — Lexical keeps an empty inline element (GenericHTMLNode does not
// override canBeEmpty), and what is left is a coloured chip with no text: it
// paints its own padding, holds no characters for the caret to backspace over,
// and gets written to the file as `<span class="tag-blue"></span>` so it comes
// back on every reload. Undeletable, in other words. Pruning them is
// badgeMarksPlugin.js; deciding what counts as empty is here.
//
// Whitespace counts as empty. A badge wrapping a single space is the same
// stuck chip by another name — it reads as a bug on screen rather than as a
// badged space — and losing that space is the smaller of the two harms.
export function isBlankBadgeText(text) {
  return !String(text ?? '').trim()
}
