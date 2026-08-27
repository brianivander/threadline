// Reading images back out of a markdown document.
//
// The editor stores a pasted image as a link relative to the document that
// shows it (`.threadline/img/shot-….png`, or `../../.threadline/img/…` from a
// story a few folders down), because that is the form that survives a clone
// onto a teammate's machine and renders on GitHub and in VS Code too. Nothing
// records which images a document uses — the DOCUMENT is that record, and this
// module reads it.
//
// Which is what makes cleaning up possible. "Delete the images this document
// no longer shows" is answered by comparing the links in the text before an
// edit with the links in the text after it — no sidecar index to go stale, no
// bookkeeping to get out of step with a file someone edited in another editor.
//
// Everything here is pure string work over markdown and paths, so it is all
// directly testable — see images.test.js.

// Relative, not the '@/' alias: these functions are covered by node's test
// runner, which has no Vite alias to resolve.
import { fromFileUrl, resolveLocalLink, toPosix } from '../lib/paths.js'

// The extensions the API will store and serve. Kept in step with
// @threadline/core's assets.js by hand: the renderer can't import from core.
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif)$/i

// The managed directory, as it appears inside a path.
const MANAGED_DIR = '/.threadline/img/'

// Both shapes MDXEditor writes. A plain image is `![alt](src "title")`; one
// that has been resized is serialized as raw `<img … src="…" />` HTML instead
// (see its LexicalImageVisitor), so a document can hold either — and reading
// only the first would quietly stop tracking an image the moment someone
// dragged its corner.
//
// The markdown form also accepts the angle-bracket variant `![](<a b.png>)`,
// which is how a path with a space in it is written.
const MD_IMAGE = /!\[[^\]]*\]\(\s*(?:<([^>]*)>|([^)\s]+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g
const HTML_IMAGE = /<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi

// Every image source in the document, in the order they appear, duplicates
// included — a caller comparing two documents wants what is actually there,
// not a tidied set.
export function imageSourcesIn(markdown) {
  const text = String(markdown || '')
  const out = []
  for (const re of [MD_IMAGE, HTML_IMAGE]) {
    // The regexes are module-level and global, so lastIndex has to be reset
    // rather than inherited from whoever called this last.
    re.lastIndex = 0
    let match
    while ((match = re.exec(text)) !== null) {
      const src = match[1] ?? match[2] ?? match[3] ?? ''
      if (src) out.push(src.trim())
    }
  }
  return out
}

// A source as written in the document, to the absolute path it names. Returns
// '' for anything that isn't a local file — a remote image is referenced, not
// owned, and nothing here should ever act on it.
export function resolveImagePath(src, docDir) {
  const resolved = resolveLocalLink(src, docDir)
  return fromFileUrl(resolved)
}

// Is this a file the app itself wrote, and may therefore delete? Mirrors
// isManagedImagePath in @threadline/core/assets.js — the server enforces this
// again on the delete route, because a guard that only exists on the client is
// not a guard.
export function isManagedImagePath(absPath) {
  const p = toPosix(absPath)
  return IMAGE_EXT.test(p) && p.toLowerCase().includes(MANAGED_DIR)
}

// Every managed image a document references, as absolute paths, deduplicated.
export function managedImagesIn(markdown, docDir) {
  const seen = new Set()
  for (const src of imageSourcesIn(markdown)) {
    const abs = resolveImagePath(src, docDir)
    if (abs && isManagedImagePath(abs)) seen.add(toPosix(abs))
  }
  return [...seen]
}

// The images that should be deleted after an edit settles.
//
// `before` is the document as it was on disk, `after` as it is now, and
// `pasted` the images added during this editing session — which matters
// because an image pasted and then removed again before saving never appears
// in either document, and would otherwise be left behind with nothing pointing
// at it. On a discard, `after` is simply the unchanged `before`, and what
// falls out is exactly the pasted-then-abandoned set.
//
// Case-insensitive on Windows only in the sense that comparison is done on the
// lowercased path: a link typed with a different drive-letter case names the
// same file, and treating it as a different one would delete an image the
// document is still showing.
export function unusedImages({ before, after, pasted = [], docDir }) {
  const kept = new Set(managedImagesIn(after, docDir).map((p) => p.toLowerCase()))
  const candidates = new Set([
    ...managedImagesIn(before, docDir),
    ...pasted.filter((p) => isManagedImagePath(p)).map((p) => toPosix(p)),
  ])
  return [...candidates].filter((p) => !kept.has(p.toLowerCase()))
}
