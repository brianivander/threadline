// Filesystem-path helpers for story links.
//
// A link's `url` can be a web URL (https://…), a `file:///…` URL, an absolute
// filesystem path (C:\Users\… or /Users/…), or a path RELATIVE to the story
// file's own folder (e.g. ../../designs/mockup.html). Relative paths are what
// gets stored: the repo is shared across machines whose absolute paths differ,
// so a link must survive a `git clone` onto a teammate's machine untouched.
//
// The conversion only ever happens in the one place that knows both halves of
// the equation — the story file's absolute directory and the raw pasted value.
// Everything here is pure text: the renderer has no Node `path` module, so
// normalization is done by hand and kept deliberately small.

// A link with an explicit scheme — http(s), file, or any other `proto:` —
// is treated as a URL and left alone. Everything else is a filesystem path.
export function hasUrlScheme(value) {
  return /^[a-z][a-z0-9+.-]*:/i.test(String(value || '').trim())
}

// An absolute filesystem path: a Windows drive letter (C:\ or C:/), a UNC
// share (\\server\share), or a POSIX root (/Users/…). Used to decide whether a
// pasted value should be converted to a relative path before saving.
export function isAbsolutePath(value) {
  const s = String(value || '').trim()
  if (!s) return false
  return /^[a-zA-Z]:[\\/]/.test(s) || /^[\\/]{2}/.test(s) || s.startsWith('/')
}

// Normalize a path to POSIX separators ('/'), collapsing any backslashes a
// Windows copy-paste brings in. The stored link is always forward-slash so it
// reads the same on every OS.
export function toPosix(value) {
  return String(value || '').replace(/\\/g, '/')
}

// The absolute directory a story file lives in, from the workspace root (an
// absolute path) and the story's workspace-relative id ('folder/sub/story.md').
// Returns '' when either input is missing so callers can bail out early.
export function storyDirOf(root, storyId) {
  if (!root || !storyId) return ''
  const dir = toPosix(storyId).split('/').slice(0, -1).join('/')
  return [toPosix(root).replace(/\/+$/, ''), dir].filter(Boolean).join('/')
}

// Relative path from `fromDir` (absolute, POSIX-normalized) to `target`
// (absolute, POSIX-normalized). Returns '../..'-style segments joined with '/',
// or '.' when they're the same directory. Pure string work — no fs access, no
// `..` resolution beyond the literal level count — which is all path.relative
// does anyway without needing the filesystem.
export function relativePath(fromDir, target) {
  const from = toPosix(fromDir).replace(/\/+$/, '').split('/').filter(Boolean)
  const to = toPosix(target).split('/').filter(Boolean)
  // Chop the shared prefix.
  let i = 0
  while (i < from.length && i < to.length && from[i] === to[i]) i += 1
  const ups = from.length - i
  const downs = to.slice(i)
  const parts = [...Array(ups).fill('..'), ...downs]
  return parts.length ? parts.join('/') : '.'
}

// Convert a pasted absolute filesystem path into a path relative to the story
// file's directory, so it can be stored portably. Returns the original string
// unchanged when it isn't an absolute path (a web URL or an already-relative
// path) so callers can treat this as a pass-through normalization.
export function toRelativePath(value, storyAbsDir) {
  const s = String(value || '').trim()
  if (!s || !isAbsolutePath(s) || !storyAbsDir) return value
  // Drop a file:// scheme if present, for peers that paste the URL a `file:`
  // link gave them instead of the raw path.
  const raw = s.replace(/^file:\/\/\//i, '').replace(/^file:\/\//i, '')
  return relativePath(storyAbsDir, raw)
}

// Build a file:// URL from an absolute POSIX path. `file:///C:/…` on Windows
// (drive letter), `file:///Users/…` on POSIX — both carry the leading slash of
// `file:///` and the path's own root slash/drive letter.
function toFileUrl(absPath) {
  const p = toPosix(absPath)
  return p.startsWith('/') ? `file://${p}` : `file:///${p}`
}

// Turn a stored link value into something the embedded browser can open:
// web/file URLs pass through, absolute paths become file:// URLs, and relative
// paths are resolved against the story's directory.
export function resolveLocalLink(value, storyAbsDir) {
  const s = String(value || '').trim()
  if (!s) return value
  if (hasUrlScheme(s)) return s
  if (isAbsolutePath(s)) return toFileUrl(s)
  if (!storyAbsDir) return s
  // Resolve the '../../..' chain against the story directory segment-by-
  // segment: split the base into its folders, then apply each link segment —
  // '..' pops one folder, '.'/'' are skipped, anything else descends. The
  // drive letter (C:) stays glued to its first segment throughout.
  const base = toPosix(storyAbsDir).replace(/\/+$/, '')
  const stack = base.split('/').filter(Boolean)
  for (const part of toPosix(s).split('/')) {
    if (part === '..') stack.pop()
    else if (part !== '.' && part !== '') stack.push(part)
  }
  return toFileUrl(stack.join('/'))
}
