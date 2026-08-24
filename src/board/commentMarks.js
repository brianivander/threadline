// Installs comment highlighting into MDXEditor: registers Lexical's MarkNode,
// strips marks on export, and hands the underlying editor up to the host.
// The actual highlighting logic is in caseText.js, which has no MDXEditor
// dependency and is unit-tested headless.

import { useEffect } from 'react'
import { $isMarkNode, MarkNode } from '@lexical/mark'
import {
  realmPlugin,
  addLexicalNode$,
  addExportVisitor$,
  addComposerChild$,
  rootEditor$,
  useCellValue,
} from '@mdxeditor/editor'

// A MarkNode must leave no trace in the markdown: it's a viewing aid rebuilt
// from the anchors, and a highlight written into a story file would be a bug
// that compounds every time the file is saved. The visitor emits nothing of
// its own and passes its children straight to the parent.
const markExportVisitor = {
  testLexicalNode: $isMarkNode,
  visitLexicalNode: ({ lexicalNode, mdastParent, actions }) => {
    actions.visitChildren(lexicalNode, mdastParent)
  },
}

// Nothing in markdown ever produces a MarkNode, so there's no import visitor
// — highlights only ever come from applyCommentMarks.
//
// The plugin also hands the underlying Lexical editor up to the host through
// `onEditor`. MDXEditor's own ref exposes markdown-level methods only
// (setMarkdown/getMarkdown), and marks and selections are a layer below that.
// A composer child is the supported way in: it renders inside the realm, so it
// can read `rootEditor$`.
export const commentMarksPlugin = realmPlugin({
  init(realm, params) {
    const EditorBridge = () => {
      const editor = useCellValue(rootEditor$)
      useEffect(() => {
        params?.onEditor?.(editor || null)
        // Hand back null on unmount so a stale editor is never marked up.
        return () => params?.onEditor?.(null)
      }, [editor])
      return null
    }

    realm.pubIn({
      [addLexicalNode$]: MarkNode,
      [addExportVisitor$]: markExportVisitor,
      [addComposerChild$]: EditorBridge,
    })
  },
})
