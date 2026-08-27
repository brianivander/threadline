// Image assets pasted into a markdown editor.
//
// A pasted screenshot has to become a FILE somewhere before it can become a
// link, and where that somewhere is decides whether the document still shows
// the image after a `git clone` onto someone else's machine. The rule here:
// images live in `.threadline/img` inside the repository that owns the
// document, and the markdown links to them with a RELATIVE path (the client
// does that part — see src/board/images.js).
//
// "The repository that owns the document" and not "the workspace root",
// because a story link can open a document that lives in another repo
// entirely (see the /doc route). Writing that document's images into the
// current workspace would put the picture and the page that shows it in two
// different repos, and the link would be broken for everyone but the person
// who pasted it. The nearest ancestor holding a `.git` wins; the workspace
// root is the fallback for a workspace that isn't a repo at all.
//
// Deletion is the other half. An image the editor no longer references is
// removed on save (see useImageAssets.js), which means this module unlinks
// files — so every guard it has is about making that safe:
//
//   - only inside a `.threadline/img` directory. An image the user linked in
//     from their Desktop is referenced, never owned, and is never touched.
//   - only image extensions, the same list /raw is willing to serve.
//   - never one that something ELSE still references. Markdown gets copied
//     between documents, and the second copy must not be broken by tidying up
//     after the first.

import fs from 'node:fs/promises'
import path from 'node:path'

import { filesMatching } from './search.js'

// What can be written, and the Content-Type it is served back as. The /raw
// route reads this too, so "what Threadline will show" and "what Threadline
// will store" cannot drift apart.
export const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
}

// The managed directory, relative to the repository root that owns it. Two
// segments, so it reads the same on every platform it's joined into.
export const IMAGE_DIR = ['.threadline', 'img']

// A screenshot is a few hundred KB; a phone photo a few MB. Past this it is
// something that shouldn't be going into a git repository one paste at a time.
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

// Posix separators, so a Windows path can be compared against a stored link
// without the comparison turning into a platform question.
function toPosix(value) {
  return String(value || '').replace(/\\/g, '/')
}

// Is this path inside a `.threadline/img` directory — i.e. a file this module
// created and may therefore delete? The check is on the DIRECTORY chain rather
// than a prefix match against one known root, because the owning repo of a
// document opened from a link isn't the workspace and needn't be known here.
export function isManagedImagePath(absPath) {
  const p = toPosix(absPath)
  if (!IMAGE_TYPES[path.extname(p).toLowerCase()]) return false
  return p.toLowerCase().includes(`/${IMAGE_DIR[0]}/${IMAGE_DIR[1]}/`)
}

// The repository directory that owns `fromDir`: its nearest ancestor holding a
// `.git`, or `fallbackRoot` when there isn't one. `.git` is a directory in a
// normal clone and a FILE in a worktree or submodule, so its type isn't tested.
export async function repoRootFor(fromDir, fallbackRoot) {
  let dir = path.resolve(fromDir)
  // Walking up ends at the filesystem root, where dirname() returns its own
  // argument — that fixed point is the loop's stop condition.
  for (;;) {
    try {
      await fs.stat(path.join(dir, '.git'))
      return dir
    } catch {
      /* not here — keep climbing */
    }
    const parent = path.dirname(dir)
    if (parent === dir) return path.resolve(fallbackRoot || fromDir)
    dir = parent
  }
}

// Where a given document's images belong: `<owning repo>/.threadline/img`.
export async function imageDirFor(docPath, fallbackRoot) {
  const root = await repoRootFor(path.dirname(path.resolve(docPath)), fallbackRoot)
  return path.join(root, ...IMAGE_DIR)
}

// The stored filename for a pasted image.
//
// Unique per paste, deliberately — NOT a content hash. Hashing would let two
// documents share one file, and the moment they do, removing the image from
// one document can't delete anything without breaking the other. One file per
// paste keeps every image owned by exactly one reference, which is what makes
// the cleanup on save safe.
//
// `now` and `token` are injected so the name is a pure function under test.
export function assetFileName(originalName, { now = new Date(), token = '' } = {}) {
  const name = String(originalName || '')
  // basename() strips the extension case-sensitively, so it has to be handed
  // the extension as written — 'Shot.PNG' would otherwise keep its '.PNG' in
  // the slug and end up named 'shot-png-….png'.
  const rawExt = path.extname(name)
  const ext = rawExt.toLowerCase()
  const base = path.basename(name, rawExt)
  // Clipboard images arrive named 'image.png' or with no name at all, so the
  // slug is a courtesy for the cases where the name means something (a dragged
  // file) rather than something to rely on.
  const slug =
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'image'
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-')
  return `${slug}-${stamp}-${token}${ext}`
}

// Write a pasted image and hand back its absolute path. `data` is the raw
// bytes; the caller has already decoded whatever transport it arrived in.
export async function saveImage(fallbackRoot, { docPath, name, data }) {
  if (!docPath) throw new Error('asset requires a docPath')
  const ext = path.extname(String(name || '')).toLowerCase()
  if (!IMAGE_TYPES[ext]) throw new Error('asset stores images only')
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data || '')
  if (!bytes.length) throw new Error('asset is empty')
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(`This image is ${Math.round(bytes.length / 1024 / 1024)} MB — too large to store in the repo.`)
  }

  const dir = await imageDirFor(docPath, fallbackRoot)
  await fs.mkdir(dir, { recursive: true })
  // Randomness lives here rather than in assetFileName so that function stays
  // pure; a collision would only mean overwriting the image written in the
  // same second, so the retry loop is short and its exhaustion is an error
  // rather than a silent overwrite.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const token = Math.random().toString(36).slice(2, 8)
    const file = path.join(dir, assetFileName(name, { token }))
    try {
      // 'wx' — create, never truncate. The whole point of a unique name is
      // that it isn't already something else's image.
      await fs.writeFile(file, bytes, { flag: 'wx' })
      return file
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
  }
  throw new Error('Could not find a free filename for this image')
}

// Escape a string for use as a ripgrep regex — a filename is matched
// literally, and '.' before the extension is the character that makes that
// matter.
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Is any file OTHER than `exceptDoc` still linking to this image? Markdown
// only: the reference we care about is a link in a document, and searching
// binaries for a filename would be a slow way to find nothing.
//
// A null answer from ripgrep means it couldn't run at all. That is treated as
// "yes, referenced" — the cautious reading. Failing to tidy up leaves a file
// nobody sees; deleting on a failed check breaks a page somebody does.
export async function isReferencedElsewhere(searchRoot, absPath, { exceptDoc } = {}) {
  const name = path.basename(absPath)
  const hits = await filesMatching(searchRoot, escapeRegex(name), {
    globs: ['*.md', '*.markdown'],
    max: 20,
  })
  if (hits === null) return true
  const except = exceptDoc ? toPosix(path.resolve(exceptDoc)).toLowerCase() : ''
  return hits.some((id) => {
    const abs = toPosix(path.resolve(searchRoot, id)).toLowerCase()
    return abs !== except
  })
}

// Delete an image this module created, if it is safe to. Returns true when the
// file is gone, false when a guard declined — never throws for a file that
// simply isn't there, because deleting an image twice (a save after a save)
// is a no-op and not a fault.
export async function deleteImage(fallbackRoot, absPath, { docPath } = {}) {
  if (!isManagedImagePath(absPath)) return false
  const searchRoot = docPath
    ? await repoRootFor(path.dirname(path.resolve(docPath)), fallbackRoot)
    : path.resolve(fallbackRoot)
  if (await isReferencedElsewhere(searchRoot, absPath, { exceptDoc: docPath })) return false
  try {
    await fs.unlink(absPath)
    return true
  } catch (err) {
    if (err.code === 'ENOENT') return false
    throw err
  }
}
