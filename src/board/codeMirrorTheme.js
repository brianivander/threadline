// Syntax highlighting for the code blocks inside the case editor.
//
// MDXEditor hardcodes `cm6-theme-basic-light` into its CodeMirror block, so
// code renders as dark-on-white regardless of app theme. It can't be fixed in
// CSS: CodeMirror compiles a HighlightStyle down to generated class names
// (`.__1a2b3c`), so there is no stable selector to target a token with.
//
// So the style is redefined here — but with every colour as a `var()` rather
// than a literal. One static extension then covers both themes, because the
// variables (declared in index.css) flip with the `.dark` class on their own.
// The alternative, swapping two hardcoded styles on theme change, would mean
// remounting the editor and losing the typist's undo history and caret.
//
// MDXEditor puts `codeMirrorExtensions` FIRST in its extension array, and
// CodeMirror resolves competing highlighters by precedence, earliest first —
// so this outranks the bundled light theme.
//
// Only token colours live here. The surrounding chrome — surface, gutter,
// cursor, selection — has stable `.cm-*` class names, so it is styled in
// index.css alongside the rest of the editor rather than as a second theme
// extension competing with the bundled one over injection order.

import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

// Tags are hierarchical: styling a parent covers its children, so `comment`
// carries lineComment/blockComment/docComment, `bracket` carries brace/paren/
// square/angle, `keyword` carries self/null/atom/modifier, and the `definition`
// / `constant` / `special` modifiers ride on the tag they modify.
//
// The list still has to be TOTAL over everything cm6-theme-basic-light styles.
// CodeMirror asks each highlighter in turn and takes the first that answers, so
// a tag left unnamed here doesn't inherit the editor's colour — it falls
// through to the light theme and renders dark-on-dark. That is why the four
// coarse parents `literal`, `content`, `inserted` and `changed` are listed even
// though nothing above needs them individually.
const highlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--cm-keyword)' },
  { tag: t.name, color: 'var(--cm-name)' },
  { tag: t.propertyName, color: 'var(--cm-property)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: 'var(--cm-function)' },
  { tag: [t.typeName, t.className], color: 'var(--cm-type)' },
  { tag: t.tagName, color: 'var(--cm-keyword)' },
  { tag: t.attributeName, color: 'var(--cm-property)' },
  { tag: t.literal, color: 'var(--cm-number)' },
  { tag: t.number, color: 'var(--cm-number)' },
  { tag: [t.string, t.url], color: 'var(--cm-string)' },
  { tag: t.regexp, color: 'var(--cm-string)' },
  { tag: t.comment, color: 'var(--cm-comment)', fontStyle: 'italic' },
  { tag: t.meta, color: 'var(--cm-comment)' },
  { tag: [t.operator, t.punctuation, t.bracket], color: 'var(--cm-punctuation)' },

  // Prose tags — markdown and similar. `content` is the catch-all parent;
  // the rest add emphasis on top of it.
  { tag: t.content, color: 'var(--cm-name)' },
  { tag: t.link, color: 'var(--cm-string)', textDecoration: 'underline' },
  { tag: t.quote, color: 'var(--cm-comment)' },
  { tag: t.monospace, color: 'var(--cm-string)' },
  { tag: t.heading, color: 'var(--cm-keyword)', fontWeight: 'bold' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },

  // Diff markers, and the parser's own error tag.
  { tag: t.inserted, color: 'var(--cm-string)' },
  { tag: t.deleted, color: 'var(--cm-invalid)' },
  { tag: t.changed, color: 'var(--cm-number)' },
  { tag: t.invalid, color: 'var(--cm-invalid)' },
])

export const codeMirrorTheme = [syntaxHighlighting(highlightStyle)]
