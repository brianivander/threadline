// Blank lines that survive a save.
//
// Markdown has no way to say "leave a gap here". CommonMark treats ANY run of
// blank lines as one paragraph break, so a body typed as
//
//     asdfasdf
//
//
//     asdfasdf
//
// serializes with the gap intact but parses back with it gone — `a\n\n\n\nb`
// and `a\n\nb` produce the identical tree. The spacing isn't lost by a bug in
// the editor; it's lost because the FORMAT cannot hold it. Anything that wants
// deliberate vertical space in a .md file has to write a paragraph that is not
// empty but looks it.
//
// So an empty paragraph is stored as one holding a single NO-BREAK SPACE
// (U+00A0). That is the least invasive filler available:
//
//   - It survives the round trip, which a plain space does not: a line of
//     ordinary whitespace IS a blank line to the parser.
//   - It renders as nothing, in this editor and in every other markdown
//     renderer the file may reach, so the gap looks the same everywhere.
//   - It is one invisible character rather than visible markup. `&#x20;` also
//     round-trips, but gets escaped to `\&#x20;` depending on where it sits,
//     and that form renders as the literal text "&#x20;" — visible junk in a
//     published page.
//
// The character exists ONLY on disk. blankLinesPlugin.js converts in both
// directions at the mdast boundary, so the document in the editor holds truly
// empty paragraphs: the caret never lands after a hidden character, and typing
// into a blank line does not leave one stranded at the start of the text.

// U+00A0, written as an escape rather than pasted. A literal would be
// indistinguishable from a plain space to anyone reading this file, and an
// editor or formatter could silently swap it for one.
export const BLANK_PARAGRAPH_FILLER = '\u00A0'

// Is this mdast paragraph one of our placeholders — a paragraph whose entire
// content is filler? Whitespace around the filler counts as part of it: a
// formatter may reflow the line, and the intent ("this paragraph is blank") is
// unchanged by that.
//
// A paragraph holding filler AND real text is left alone. The user typed a
// no-break space on purpose there — between a number and its unit, say — and
// silently emptying that paragraph would delete their content.
export function isBlankParagraph(mdastNode) {
  if (mdastNode?.type !== 'paragraph') return false
  const children = mdastNode.children || []
  if (!children.length) return false
  if (!children.every((child) => child?.type === 'text')) return false
  const text = children.map((child) => child.value || '').join('')
  // `\s` matches U+00A0, so this is "nothing but whitespace, and not empty".
  return text.length > 0 && text.replace(/\s/g, '') === ''
}

// Is this Lexical paragraph empty — nothing in it at all? Only these become
// filler on the way out. A paragraph containing so much as a space is content
// and is written as the user left it.
export function isEmptyParagraph(lexicalNode) {
  return (lexicalNode?.getChildrenSize?.() ?? -1) === 0
}
