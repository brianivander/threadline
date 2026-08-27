// An image opened in the editor column.
//
// The bytes come from the API's /raw route rather than a file:// URL: the
// renderer is served over http, and Electron blocks a file:// image on an http
// page. /raw serves images only, so this can't be turned into a way to read
// arbitrary files off the disk.
//
// Read-only, deliberately. This is for looking at the mockup next to the story
// that describes it — the thing the tree exists to keep together.

import { useState } from 'react'

export default function ImagePanel({ filePath, title }) {
  // Reset per file: a broken path must not leave the next image showing an
  // error, and a fixed one must not stay broken.
  const [failed, setFailed] = useState(false)
  const src = filePath ? `/api/threadline/raw?path=${encodeURIComponent(filePath)}` : ''

  if (!filePath) return null

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {failed ? (
          <p className="text-muted-foreground text-[13px] italic">
            This image couldn’t be loaded. It may have been moved or renamed since the tab was opened.
          </p>
        ) : (
          <img
            // Keyed on the path so switching tabs swaps the element rather than
            // reusing one that still holds the previous image's failed state.
            key={filePath}
            src={src}
            alt={title || 'Image'}
            // Fits the column without being blown up past its real size — a
            // 32px icon stretched across the panel tells you nothing.
            className="max-h-full max-w-full object-contain"
            onError={() => setFailed(true)}
          />
        )}
      </div>
      <p className="text-muted-foreground shrink-0 truncate border-t px-4 py-1.5 font-mono text-[11px]">{filePath}</p>
    </div>
  )
}
