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
//
// A scheme needs at least TWO characters: a one-letter one is a Windows drive
// (`C:/repo/spec.md`), and reading that as a URL is how an absolute Windows
// path ends up stored verbatim instead of being converted to the relative path
// that survives a clone onto someone else's machine.
export function hasUrlScheme(value) {
  return /^[a-z][a-z0-9+.-]+:/i.test(String(value || '').trim())
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

// A workspace-relative id ('folder/sub/spec.md') to the absolute path it names.
// The id side of the app addresses files this way; the doc editor and the
// browser both want a real path.
export function workspacePathOf(root, id) {
  if (!root || !id) return ''
  return [toPosix(root).replace(/\/+$/, ''), toPosix(id).replace(/^\/+/, '')].join('/')
}

// The inverse, for pointing the sidebar's highlight at a file the editor has
// open. Returns '' when the path is OUTSIDE the workspace — a story link can
// resolve into another repo entirely, and there is no tree row to highlight for
// one of those. Case-insensitively matched: the workspace root arrives from a
// directory dialog and a link's path from text a user typed, and on Windows
// those disagree on drive-letter case for the same folder.
export function workspaceIdOf(root, absPath) {
  const base = toPosix(root).replace(/\/+$/, '')
  const target = toPosix(absPath)
  if (!base || !target) return ''
  const prefix = `${base}/`
  if (target.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return ''
  return target.slice(prefix.length)
}

// The volume an absolute path sits on: a Windows drive ('c:'), a UNC share
// ('//server/share'), or '/' for a POSIX root. Lowercased, because a drive
// letter arrives from a directory dialog on one side and typed text on the
// other, and Windows considers those the same drive.
//
// Only the VOLUME, deliberately — not the first folder. Two POSIX paths under
// different top-level directories ('/other/x' from '/repo/folder') are
// perfectly reachable from each other, and treating those as unrelated would
// refuse relative paths that work fine.
function volumeOf(value) {
  const p = toPosix(value)
  if (/^[a-zA-Z]:/.test(p)) return p.slice(0, 2).toLowerCase()
  if (p.startsWith('//')) return `//${p.slice(2).split('/').slice(0, 2).join('/')}`.toLowerCase()
  return p.startsWith('/') ? '/' : ''
}

// Can a relative path get from one to the other at all?
function sameVolume(a, b) {
  const volume = volumeOf(a)
  return !!volume && volume === volumeOf(b)
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
  // A `file:` URL is unwrapped BEFORE the absolute-path test, not after: a peer
  // may paste the URL a `file:` link handed them rather than the raw path, and
  // tested as-is that value reads as "has a scheme, not a path" and is stored
  // verbatim — machine-specific, which is the one thing this function exists to
  // prevent.
  const raw = /^file:/i.test(s) ? fromFileUrl(s) : s
  if (!raw || !isAbsolutePath(raw) || !storyAbsDir) return value
  // Two paths on different volumes — a different drive, or a UNC share against
  // a local path — have no relative route between them. Counting levels anyway
  // yields '../../D:/x/spec.md', which is a path to nowhere on every machine
  // including this one. The absolute path is at least true here.
  if (!sameVolume(storyAbsDir, raw)) return toPosix(raw)
  return relativePath(storyAbsDir, raw)
}

const MARKDOWN_EXT = /\.(md|markdown)$/i

// The story extension (see repo.js). `.s.md` is one extension in two dots, so
// it is matched as a whole — 'login.s.md' is a story titled 'login'.
const STORY_EXT = /\.s\.md$/i

// A resolved link the markdown editor should open rather than the browser: a
// local file whose name ends in .md/.markdown. A *web* URL ending in .md is
// deliberately left to the browser — the server decides what it serves there,
// and it may not be a file at all.
export function isLocalMarkdownUrl(value) {
  const s = String(value || '').trim()
  if (!/^file:/i.test(s)) return false
  // A query or hash can trail even a local URL once it's been through the
  // address bar, and neither is part of the filename.
  return MARKDOWN_EXT.test(s.split(/[?#]/)[0])
}

// Is this path a story file? A path, a file: URL or a workspace id all answer
// the same way — the name is the whole rule.
export function isStoryPath(value) {
  return STORY_EXT.test(String(value || '').trim().split(/[?#]/)[0])
}

// A file's display name: its filename with the extension taken off, matching
// what the repo does for a tree row. Used for tabs opened by absolute path,
// where there is no node to take a title from.
export function titleOf(absPath) {
  const base = toPosix(absPath).split('/').pop() || ''
  // The compound story extension comes off whole — stripping the last dot
  // alone would title 'login.s.md' as 'login.s'. A bare '.s.md' is a hidden
  // file rather than a story with no name, so it keeps its whole name.
  if (base.length > 5 && STORY_EXT.test(base)) return base.slice(0, -5)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

// The reverse of toFileUrl: a file:// URL back to a plain filesystem path,
// percent-escapes decoded, so a workspace with spaces in its path survives the
// round trip through the URL a browser tab holds. Returns '' for anything that
// isn't a file:// URL.
export function fromFileUrl(value) {
  const s = String(value || '').trim()
  const scheme = /^file:\/\/\/?/i.exec(s)
  if (!scheme) return ''
  const rest = s.slice(scheme[0].length).split(/[?#]/)[0]
  let decoded = rest
  try {
    decoded = decodeURIComponent(rest)
  } catch {
    // A stray '%' isn't an escape sequence — keep the raw text rather than
    // failing to open a file over a character in its name.
  }
  // toFileUrl glues `file:///` to a drive-letter path as-is but eats the
  // leading slash of a POSIX one, so only the latter needs its root back.
  return /^[a-zA-Z]:/.test(decoded) ? decoded : `/${decoded}`
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

// A pasted link value as an absolute POSIX path, or '' when it isn't one.
// `file:` URLs are unwrapped, Windows backslashes are flattened, and anything
// relative or web comes back empty — the caller reads that as "nothing to
// check here, leave it alone".
export function toAbsolutePath(value) {
  const s = String(value || '').trim()
  const raw = /^file:/i.test(s) ? fromFileUrl(s) : s
  return isAbsolutePath(raw) ? toPosix(raw) : ''
}
