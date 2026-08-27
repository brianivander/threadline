// Installs the two image-resize fixes into MDXEditor. The reasoning, and the
// parts worth testing, are in imageSize.js.
//
//   1. after every editor update, a leftover inline size on an <img> is
//      removed so the size the document holds is the one on screen — which is
//      what makes Ctrl+Z on a resize visible
//   2. the scroll position is held across the drag, because letting go of a
//      resize handle otherwise jumps the editor back to the top
//
// On (2): the resize ends in an `editor.update()` while the image carries a
// Lexical NodeSelection, which has no text range for the browser to keep in
// view. Reconciling it puts the DOM selection at the start of the document and
// the browser scrolls there. Rather than fight the selection — the image is
// legitimately what's selected — the scroll position is simply restored, since
// resizing an image is not navigation and should not move the viewport.

import { useEffect } from 'react'
import { realmPlugin, addComposerChild$, rootEditor$, useCellValue } from '@mdxeditor/editor'

import { clearStaleImageSizes, findScrollContainer } from '@/board/imageSize'

// The resize handles, by the stable part of their CSS-module class name.
const RESIZE_HANDLE = '[class*="imageResizer"]'

// How long after the drag ends to keep putting the scroll position back. The
// jump doesn't happen in one go: the editor update, React's re-render of the
// image and MDXEditor's own 200ms `isResizing` timer each land separately, and
// any of them can move the viewport.
const HOLD_MS = 400

// A composer child, for the same reason commentMarksPlugin uses one: it
// renders inside the realm, so it can read `rootEditor$` and get at the
// Lexical editor underneath MDXEditor's markdown-level API.
const ImageSizeSync = () => {
  const editor = useCellValue(rootEditor$)

  useEffect(() => {
    if (!editor) return undefined

    let syncFrame = 0
    const sync = () => {
      const root = editor.getRootElement()
      if (root) clearStaleImageSizes(root.querySelectorAll('img'))
    }
    const unregister = editor.registerUpdateListener(() => {
      // A frame later, not immediately. The images are decorator nodes
      // rendered by React, and the update listener fires before React has
      // committed the new width/height attributes — clearing the inline style
      // first would show the OLD attribute for a frame.
      cancelAnimationFrame(syncFrame)
      syncFrame = requestAnimationFrame(sync)
    })

    // ---- holding the scroll position across a resize ----
    let held = null
    let holdFrame = 0

    const release = () => {
      cancelAnimationFrame(holdFrame)
      holdFrame = 0
      held = null
    }

    const hold = () => {
      if (!held) return
      const { container, top, left, until } = held
      if (Date.now() > until) return release()
      // Only correct an actual jump. Writing scrollTop unconditionally would
      // cancel any smooth scrolling the browser is doing for its own reasons.
      if (container.scrollTop !== top) container.scrollTop = top
      if (container.scrollLeft !== left) container.scrollLeft = left
      holdFrame = requestAnimationFrame(hold)
    }

    const onPointerDown = (event) => {
      if (!event.target?.closest?.(RESIZE_HANDLE)) return
      const container = findScrollContainer(editor.getRootElement(), (node) => window.getComputedStyle(node))
      if (!container) return
      held = { container, top: container.scrollTop, left: container.scrollLeft, until: 0 }
    }

    const onPointerUp = () => {
      if (!held) return
      held.until = Date.now() + HOLD_MS
      cancelAnimationFrame(holdFrame)
      holdFrame = requestAnimationFrame(hold)
    }

    // A deliberate scroll wins immediately — a fix for an unwanted jump must
    // never become a scroll lock.
    const onWheel = () => release()

    // Capture, and on the document: the resizer binds its own pointermove and
    // pointerup to the document, and the pointer leaves the handle during the
    // drag anyway.
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('pointerup', onPointerUp, true)
    document.addEventListener('wheel', onWheel, { capture: true, passive: true })

    return () => {
      cancelAnimationFrame(syncFrame)
      release()
      unregister()
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('pointerup', onPointerUp, true)
      document.removeEventListener('wheel', onWheel, true)
    }
  }, [editor])

  return null
}

export const imageSizePlugin = realmPlugin({
  init(realm) {
    realm.pubIn({ [addComposerChild$]: ImageSizeSync })
  },
})
