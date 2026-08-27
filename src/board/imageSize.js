// Undoing an image resize.
//
// MDXEditor writes an image's size to the DOM twice, and only one of them is
// part of the document:
//
//   - while you drag a corner, its resizer sets `style.width` / `style.height`
//     straight onto the <img> and never takes them off again
//   - when you let go, the size lands on the editor's own image node, which is
//     rendered back as the <img>'s `width` / `height` ATTRIBUTES
//
// Undo reverses the second one — the node goes back to its old size, the
// markdown that gets saved goes back with it — and cannot reverse the first,
// because the editor never knew about it. An inline style beats an attribute,
// so the stale one is the one you see: the document says the image is its
// original size while the picture stays as big as you dragged it.
//
// The fix is to make the attribute the only thing that decides. After every
// editor update, an inline size that disagrees with the attribute is removed.
//
// The same drag has a second problem, and it's in here too: letting go of the
// handle jumps the editor back to the top of the document. Resizing an image
// isn't navigation, so the fix is simply to hold the scroll position across
// it — see keepScroll below.
//
// Kept free of any MDXEditor import so it can be tested headlessly — see
// imageSize.test.js, and imageSizePlugin.js for the half that isn't testable
// that way.

// One axis of one image. `expected` is what the attribute implies the inline
// style would have to be to be saying the same thing.
function clearIfStale(img, axis) {
  const inline = img.style.getPropertyValue(axis)
  if (!inline) return false
  const attr = img.getAttribute(axis)
  // No attribute means the node carries no size of its own — the image is back
  // to its natural size and any inline value is left over from a drag.
  if (attr && inline === `${attr}px`) return false
  img.style.removeProperty(axis)
  return true
}

// Strip leftover inline sizes from a list of <img> elements, and report how
// many were actually changed.
//
// Deliberately a no-op when the two agree, which is the case immediately after
// a resize: the drag's inline value and the attribute the node just produced
// say the same thing, and removing one to re-apply the other would redraw the
// image at the end of every drag for no reason.
export function clearStaleImageSizes(images) {
  let cleared = 0
  for (const img of images || []) {
    // Both axes, always — an image resized from a corner has two stale values
    // and reverting only one would leave it stretched.
    const w = clearIfStale(img, 'width')
    const h = clearIfStale(img, 'height')
    if (w || h) cleared += 1
  }
  return cleared
}

// The element that actually scrolls above `el` — the editor's content sits
// inside a resizable panel, so the scroller is an ancestor rather than the
// contenteditable or the window. `getStyle` is injected so this is testable
// without a DOM.
export function findScrollContainer(el, getStyle) {
  let node = el?.parentElement || null
  while (node) {
    const overflow = getStyle(node)?.overflowY || ''
    // A scrollable overflow is not enough on its own: the panels set
    // `overflow: hidden` on wrappers that never scroll, and `auto` on ones
    // that only scroll when the content is tall enough to need it.
    if (/(auto|scroll|overlay)/.test(overflow) && node.scrollHeight > node.clientHeight) return node
    node = node.parentElement
  }
  return null
}
