// The two things a tree row can do with a file that aren't editing it: put its
// path on the clipboard, and hand it to the OS file manager.
//
// Both are renderer-side seams over the Electron shell. `showItemInFolder`
// needs the main process (preload.cjs -> main.cjs), so it only exists in the
// desktop app; copying a path is plain clipboard work and runs anywhere, which
// is why the two are reported separately by `canShowInFolder()`.

const desktop = () => (typeof window !== 'undefined' ? window.threadlineDesktop : null)

export function canShowInFolder() {
  return !!desktop()?.showItemInFolder
}

// What the file manager is called here, so the menu item names the thing the
// user is about to see rather than a generic "show in folder". Falls back to
// the neutral wording when the platform isn't one of the two we can name — and
// when there is no shell at all, since the item is hidden in that case anyway.
export function revealLabel() {
  const platform = desktop()?.platform
  if (platform === 'darwin') return 'Reveal in Finder'
  if (platform === 'win32') return 'Reveal in File Explorer'
  return 'Show in file manager'
}

// Paths are held POSIX-style throughout the app (see lib/paths.js), but a path
// copied on Windows is pasted into Windows tools, which want backslashes.
export function toNativePath(absPath) {
  const p = String(absPath || '')
  return desktop()?.platform === 'win32' ? p.replace(/\//g, '\\') : p
}

export function showItemInFolder(absPath) {
  if (!absPath) return
  desktop()?.showItemInFolder?.(absPath)
}

// navigator.clipboard is available on the app's http://127.0.0.1 origin (a
// secure context), but not when the page is opened over a plain-http LAN
// address, so the old execCommand path stays as a fallback.
export async function copyText(text) {
  const value = String(text || '')
  if (!value) return false
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    try {
      const el = document.createElement('textarea')
      el.value = value
      el.style.position = 'fixed'
      el.style.opacity = '0'
      document.body.appendChild(el)
      el.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(el)
      return ok
    } catch {
      return false
    }
  }
}
