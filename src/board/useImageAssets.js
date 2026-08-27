// Pasted images, for the markdown editors.
//
// Two halves, and they meet in the markdown itself:
//
//   upload  — a pasted or dropped image becomes a file in `.threadline/img`
//             inside the repo that owns the document, and the editor stores a
//             RELATIVE link to it. Relative because that's the form that
//             survives a clone onto someone else's machine, and the form
//             GitHub and VS Code render too.
//   preview — the renderer is served over http, so an <img> can't load a
//             file:// URL (Electron blocks it, rightly). The stored relative
//             link is resolved back to an absolute path and shown through the
//             API's /raw route — the same one the image tab uses.
//
// And the tidy-up. Images removed from a document are deleted when the
// document is SAVED, and images pasted but never saved are deleted when the
// user discards. Both go through `settle`, which is called by useManualSave
// once an edit has settled one way or the other.
//
// Deliberately NOT on unmount. Unsaved text is backed up to localStorage and
// offered back after a crash or a reopen (see drafts.js); deleting the images
// out from under a draft would hand the user their words back with holes where
// the pictures were. A crash therefore leaves the occasional orphan file, and
// that is the right trade: an unreferenced file wastes a few hundred KB, a
// missing one breaks a page. Nothing here sweeps for orphans — a job that
// hunts the workspace for "unused" images is a job that eventually deletes
// something that wasn't.

import { useCallback, useEffect, useRef, useState } from 'react'

import { isManagedImagePath, resolveImagePath, unusedImages } from '@/board/images'
import { relativePath, toPosix } from '@/lib/paths'

const API = '/api/threadline'

// Extensions the API will store, by clipboard MIME type — a screenshot arrives
// as a File whose `name` may be empty or meaningless, and the type is the only
// thing that reliably says what it is.
const EXT_BY_TYPE = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/avif': '.avif',
}

// The name to store the image under. A dragged file keeps its own name (it
// usually means something); a clipboard image gets a generic one plus the
// extension its MIME type implies. The server makes it unique either way.
function nameFor(file) {
  const raw = String(file?.name || '')
  const ext = EXT_BY_TYPE[String(file?.type || '').toLowerCase()] || ''
  if (raw && /\.[a-z0-9]+$/i.test(raw)) return raw
  if (!ext) return ''
  return `${raw || 'pasted'}${ext}`
}

// A File's bytes as base64, which is how they travel to the API. Chunked
// because String.fromCharCode(...bytes) on a multi-megabyte image blows the
// argument limit and takes the tab with it.
async function toBase64(file) {
  const buffer = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < buffer.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, buffer.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

export function useImageAssets({ docPath, docDir, root }) {
  // Images written during this editing session. Held in a ref rather than
  // state because nothing renders from it — it exists so that pasting an image
  // and then deleting it again before saving doesn't leave the file behind.
  const pastedRef = useRef([])
  const [error, setError] = useState('')

  // A different document is a different session; the previous one's pastes are
  // either saved into it or already swept.
  useEffect(() => {
    pastedRef.current = []
    setError('')
  }, [docPath])

  const headers = useCallback(() => {
    const h = { 'Content-Type': 'application/json' }
    if (root) h['x-threadline-root'] = encodeURIComponent(root)
    return h
  }, [root])

  // Returns the link to store: relative to the document, posix-separated.
  const upload = useCallback(
    async (file) => {
      if (!docPath || !docDir) throw new Error('This document has no folder to store images in.')
      const name = nameFor(file)
      if (!name) throw new Error(`Can’t paste a ${file?.type || 'file'} here — images only.`)
      setError('')
      try {
        const res = await fetch(`${API}/asset`, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ docPath, name, dataBase64: await toBase64(file) }),
        })
        const payload = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(payload.error || `Couldn’t save the image: ${res.status}`)
        const abs = toPosix(payload.data.path)
        pastedRef.current.push(abs)
        return relativePath(docDir, abs)
      } catch (err) {
        // The editor's paste path has nowhere to show a rejection, so the
        // message is surfaced through the panel instead of being lost.
        setError(String(err?.message || err))
        throw err
      }
    },
    [docPath, docDir, headers],
  )

  // The stored link, as something an <img> on an http page can actually load.
  // A remote image passes straight through — it is referenced, not stored.
  const preview = useCallback(
    async (src) => {
      const abs = resolveImagePath(src, docDir)
      if (!abs) return src
      return `${API}/raw?path=${encodeURIComponent(abs)}`
    },
    [docDir],
  )

  // Called once an edit has settled: after a successful save (`previous` is
  // what was on disk, `text` what now is) and after a discard (both are the
  // unchanged file). Anything managed that neither the new text nor anything
  // else references goes.
  //
  // Fire-and-forget, and failures are swallowed: this is tidying up after a
  // save that has already succeeded, and it must never be the reason a user is
  // told their save went wrong. The server re-checks every guard anyway.
  const settle = useCallback(
    ({ previous, text }) => {
      if (!docDir) return
      const gone = unusedImages({
        before: previous,
        after: text,
        pasted: pastedRef.current,
        docDir,
      })
      pastedRef.current = pastedRef.current.filter((p) => !gone.some((g) => g.toLowerCase() === p.toLowerCase()))
      for (const file of gone) {
        if (!isManagedImagePath(file)) continue
        fetch(
          `${API}/asset?path=${encodeURIComponent(file)}&doc_path=${encodeURIComponent(docPath || '')}`,
          { method: 'DELETE', headers: headers() },
        ).catch(() => {})
      }
    },
    [docDir, docPath, headers],
  )

  return { upload, preview, settle, error }
}
