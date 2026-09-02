// Keeps empty badges out of the document. The reasoning — why an emptied
// `<span class="tag-blue">` survives at all, and why it can never be removed
// by hand once it does — is in badges.js, above isBlankBadgeText.
//
// A node transform rather than an update listener: a transform runs inside the
// same update that made the badge empty, so the chip never reaches the screen
// and never lands in an undo step of its own. Deleting the last character of a
// badge is one undo, not two.
//
// Registering it is only half the job. A transform sees nodes that go dirty
// AFTER it exists, and the document is imported before this composer child
// mounts — so badges already saved into the file would sit there untouched
// until something else happened to dirty them. The sweep on mount is what
// cleans those, and it is deliberately guarded by a read-only pass first: an
// editor.update() that mutates nothing still counts as a change downstream,
// and marking every document dirty on open to fix the few that need it would
// be worse than the bug.

import { useEffect } from 'react'
import { $getRoot } from 'lexical'
import { GenericHTMLNode, realmPlugin, addComposerChild$, rootEditor$, useCellValue } from '@mdxeditor/editor'

import { findEmptyBadges, isEmptyBadge, pruneEmptyBadge } from '@/board/badgeMarks'

const EmptyBadgeSweep = () => {
  const editor = useCellValue(rootEditor$)

  useEffect(() => {
    if (!editor) return undefined

    // Nested badges cascade on their own: removing the inner one dirties the
    // outer, which brings it back through here already empty.
    const unregister = editor.registerNodeTransform(GenericHTMLNode, (node) => {
      if (isEmptyBadge(node)) pruneEmptyBadge(node)
    })

    // The one pass over what was already on disk. Keys, not nodes, because the
    // read and the update are separate editor states.
    const stale = editor.getEditorState().read(() => findEmptyBadges($getRoot()).map((n) => n.getKey()))
    if (stale.length) {
      editor.update(() => {
        for (const node of findEmptyBadges($getRoot())) pruneEmptyBadge(node)
      })
    }

    return unregister
  }, [editor])

  return null
}

export const badgeMarksPlugin = realmPlugin({
  init(realm) {
    realm.pubIn({ [addComposerChild$]: EmptyBadgeSweep })
  },
})
