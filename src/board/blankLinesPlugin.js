// Installs the blank-line round trip into MDXEditor. The reasoning, and the
// parts worth testing, are in blankLines.js.
//
// Two visitors, one per direction, and they are exact inverses:
//
//   export (Lexical -> mdast)  an empty paragraph gains a U+00A0 text child
//   import (mdast -> Lexical)  a paragraph of nothing but U+00A0 loses it
//
// Both run at priority 1. MDXEditor's own paragraph visitors are registered at
// the default 0, and the higher number wins the node — without it the stock
// visitor would claim every paragraph first and neither hook would ever see
// one. Nothing else in the app registers a paragraph visitor, so 1 is enough;
// this is not a number to raise casually if that changes.
//
// The pairing is what keeps the filler off the screen. It is added on the way
// to the file and removed on the way back, so the editor's document only ever
// holds genuinely empty paragraphs — see the note in blankLines.js about why
// that matters for the caret.

import { realmPlugin, addExportVisitor$, addImportVisitor$ } from '@mdxeditor/editor'
import { $createParagraphNode, $isParagraphNode } from 'lexical'

import { BLANK_PARAGRAPH_FILLER, isBlankParagraph, isEmptyParagraph } from '@/board/blankLines'

const PRIORITY = 1

// Lexical -> mdast. Writes the paragraph itself rather than delegating, since
// the whole point is to give it a child it does not have.
const exportBlankParagraph = {
  priority: PRIORITY,
  testLexicalNode: (lexicalNode) => $isParagraphNode(lexicalNode) && isEmptyParagraph(lexicalNode),
  visitLexicalNode: ({ mdastParent, actions }) => {
    actions.appendToParent(mdastParent, {
      type: 'paragraph',
      children: [{ type: 'text', value: BLANK_PARAGRAPH_FILLER }],
    })
  },
}

// mdast -> Lexical. The filler is dropped on the floor: an empty paragraph is
// exactly what the file was trying to describe.
const importBlankParagraph = {
  priority: PRIORITY,
  testNode: (mdastNode) => isBlankParagraph(mdastNode),
  visitNode: ({ lexicalParent }) => {
    lexicalParent.append($createParagraphNode())
  },
}

export const blankLinesPlugin = realmPlugin({
  init(realm) {
    realm.pubIn({
      [addExportVisitor$]: exportBlankParagraph,
      [addImportVisitor$]: importBlankParagraph,
    })
  },
})
