// Threadline filesystem repository — replaces the SQLite-backed models.js.
//
// A workspace is a plain directory tree of arbitrary depth: any folder can
// hold any number of subfolders and files. Folders ARE directories (their name
// is their id's last segment). There's no separate sort_order: folders and
// files list alphabetically by name (folders first, then files); cases keep the
// order they appear in the file (reordered by rewriting it).
//
// Every file node carries a `kind` saying what it is — the tree is the app's
// file explorer, not just its story list:
//
//   'story' — a `.s.md` file: frontmatter + `<!-- case: Name -->` delimited
//             cases + a comment section (see story-file.js). The extension is
//             the whole rule — the contents are parsed, never consulted to
//             decide what the file is.
//   'doc'   — any other markdown file: a PRD, a TRD, a README that simply
//             lives in the workspace. Read and written as plain text through
//             the /doc route; this module only lists, renames, moves, copies
//             and deletes it.
//   'page'  — an `.html`/`.htm` file, opened in the embedded browser.
//   'image' — a `.png`/`.jpg`/`.svg`/… file, likewise. A mockup sitting next to
//             the story it belongs to is part of the context this tree is for.
//
// A node's `title` is its filename with the extension taken off, for every kind
// alike, and `ext` carries that extension separately ('s.md', 'md', 'png') so
// the UI can label the row without re-parsing the name. For a story the
// filename IS the title, so this is the only honest reading; for the rest it
// keeps `notes.md` and `notes.png` telling themselves apart through the label
// rather than through a duplicated '.md' in the text. A rename puts the
// extension back — see filenameFor.
//
// Only a 'story' has cases, criticality, links or comment threads. Everything
// that mutates those re-reads the file first and finds none on the other kinds,
// so a mis-routed call comes back empty rather than rewriting the file into a
// shape it never had. A page or an image is never opened for reading at all.
//
// Comment threads live in the same markdown file, in its `<!-- comments -->`
// section — so they clone, diff and read as prose alongside the story they're
// about. They're deliberately absent from listFiles/getFile/buildTree
// payloads: fetch them with listThreads (one story) or scanThreads (the whole
// workspace, which is what answers "every comment mentioning me").
//
// IDs are POSIX-style paths relative to the workspace root ('/' separators
// regardless of OS), e.g. 'folder1/subfolder/login.s.md'. The workspace root
// itself is represented as '' / null.
//
// Every id is resolved with `resolveSafe` before touching the filesystem, so
// a caller can never read/write outside the workspace root.

import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseStoryFile, serializeStoryFile } from './story-file.js'
import * as search from './search.js'

export const CRITICALITIES = ['P1', 'P2', 'P3', 'P4']

// The tree lists EVERY file — it is the workspace's file explorer, not a
// filtered view of the parts this app happens to edit. A spreadsheet sitting
// next to a story is part of the context the tree is for, and hiding it makes
// the tree lie about what's on disk.
//
// What differs by extension is what OPENING one does, which is the `kind`.
// Every kind is decided by extension alone — nothing is read to classify it.
//
// A story is a `.s.md`. The compound extension is the whole rule: a story and
// a PRD are both markdown and both live in the same folder, so the name is the
// only place the difference can be visible in a file explorer, in a git diff,
// or in the sidebar before anything has been opened. The alternative — reading
// every markdown file in a folder to see whether it declares itself a story —
// makes the tree's answer depend on file contents nobody can see from the row.
//
// `.s.md` still ends in `.md`, so every markdown tool (GitHub, an editor's
// preview, a linter) keeps treating a story as the markdown it is.
const STORY_EXTS = ['.s.md']
const MARKDOWN_EXTS = ['.md', '.markdown']
const PAGE_EXTS = ['.html', '.htm']
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif']
const PDF_EXTS = ['.pdf']

// Files that are plain text, opened in a text editor rather than the markdown
// one — a config beside a story is worth reading without leaving the app.
//
// An explicit list rather than "anything not obviously binary": guessing wrong
// the other way means rendering a few megabytes of binary as garbage, and a
// list of extensions is a thing to extend, not a thing to debug.
const TEXT_EXTS = [
  '.txt', '.text', '.log', '.csv', '.tsv',
  '.json', '.jsonl', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.env', '.xml',
  '.css', '.scss', '.less', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.php', '.sh', '.bash', '.ps1', '.sql', '.graphql',
]

// The extensions this module knows how to open. NOT a filter on what the tree
// shows — it's what `filenameFor` treats as a deliberate extension change on
// rename, and what decides a markdown file is worth reading.
export const FILE_EXTS = [...STORY_EXTS, ...MARKDOWN_EXTS, ...PAGE_EXTS, ...IMAGE_EXTS, ...PDF_EXTS, ...TEXT_EXTS]

// What /text is allowed to read and write. HTML is in here because an .html
// file is editable source as well as a page to look at — the app edits the
// text and hands the browser the preview.
export const TEXT_OPEN_EXTS = [...TEXT_EXTS, ...PAGE_EXTS]

// The extension a new file gets when nothing says otherwise. `createFile`
// writes a story, and a rename that drops the extension is a story's rename
// (its filename IS its title), so the default is the story one.
const DEFAULT_EXT = STORY_EXTS[0]

// ---- path helpers -----------------------------------------------------------

function toPosix(id) {
  return String(id || '').split(path.sep).join('/')
}

// Resolve a workspace-relative id to an absolute path, rejecting anything
// that would escape the workspace root (e.g. '../../etc/passwd').
function resolveSafe(root, id) {
  const absRoot = path.resolve(root)
  const segments = toPosix(id).split('/').filter(Boolean)
  const abs = path.resolve(absRoot, ...segments)
  if (abs !== absRoot && !abs.startsWith(absRoot + path.sep)) {
    throw new Error(`Path escapes workspace root: ${id}`)
  }
  return abs
}

function joinId(...parts) {
  return parts.filter(Boolean).map(toPosix).join('/')
}

function parentId(id) {
  const parts = toPosix(id).split('/')
  parts.pop()
  return parts.join('/')
}

// Filenames/directory names ARE titles/names, so this preserves the exact
// text a user typed (case, spaces, punctuation) instead of slugifying it —
// only stripping characters that are actually illegal in a filename (the
// Windows set, a superset of POSIX's, used everywhere for cross-platform
// safety) and trailing dots/spaces (illegal on Windows).
const ILLEGAL_FILENAME_CHARS = new RegExp('[<>:"/\\\\|?*\\x00-\\x1f]', 'g')
function sanitizeName(str) {
  const cleaned = String(str || '')
    .replace(ILLEGAL_FILENAME_CHARS, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '')
  return cleaned || 'Untitled'
}

// The trailing '.ext' of a name EXACTLY as the file spells it, or '' when it
// has none. Only the last dot counts, so 'spec v1.2.md' keeps '.md' — except
// for the compound story extension, which is one extension in two dots:
// 'login.s.md' is a story titled 'login', not a file called 'login.s'.
//
// Case matters here and is preserved: path.basename(name, ext) strips `ext`
// only on an exact match, so stripping a lowercased '.jpg' off 'photo.JPG'
// silently leaves the extension in the title. A rename reattaches this same
// text for the same reason — renaming a file is no occasion to quietly
// reletter its extension.
function rawExtOf(name) {
  const base = toPosix(name).split('/').pop() || ''
  const lower = base.toLowerCase()
  for (const ext of STORY_EXTS) {
    // `>` and not `>=`: '.s.md' as a whole filename is a hidden file, not a
    // story with no title at all.
    const at = lower.length - ext.length
    if (at > 0 && lower.endsWith(ext)) return base.slice(at)
  }
  // A leading dot is a hidden name, not an extension: ".gitignore" is a file
  // called ".gitignore", and reporting "gitignore" as its type would put a
  // GITIGNORE tag on the row and leave a rename with nothing to reattach.
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot) : ''
}

// The same, lowercased — for comparing against the extension sets, which a
// file is a member of however it happens to be spelled.
function extOf(name) {
  return rawExtOf(name).toLowerCase()
}

// What a file IS, decided by its name alone. Nothing is opened to answer this:
// a story says so in its extension, and for everything else there is either
// nothing inside to consult or opening it would be reckless.
//
// 'other' is the catch-all: a .zip, a .xlsx, a 900 MB video. It is listed in
// the tree and described here, but never read — which is the whole point of
// deciding by extension before touching the file.
//
// A file with no extension at all ('.gitignore', 'Dockerfile', 'LICENSE') is
// text: those are written to be read, and there is no extension to consult.
function fileKind(name) {
  const ext = extOf(name)
  if (STORY_EXTS.includes(ext)) return 'story'
  if (MARKDOWN_EXTS.includes(ext)) return 'doc'
  if (PAGE_EXTS.includes(ext)) return 'page'
  if (IMAGE_EXTS.includes(ext)) return 'image'
  if (PDF_EXTS.includes(ext)) return 'pdf'
  if (TEXT_EXTS.includes(ext) || ext === '') return 'text'
  return 'other'
}

// A rename carries a title; this turns it back into a filename.
//
// One rule covers both kinds. A story is titled 'Login' and the extension is
// invisible to the user, so its own '.s.md' gets appended back — renaming a
// story is no way to stop it being one. A doc or a page is listed under its
// real filename ('spec.md'), so a rename that already ends in a known extension
// is taken verbatim — including a deliberate 'spec.md' -> 'spec.html', and
// 'spec.md' -> 'spec.s.md', which is how a document becomes a story. Anything
// else keeps the extension the file already had, which is the only safe
// default: silently turning a `.html` into a `.md` would strand the file.
function filenameFor(title, currentExt) {
  const base = sanitizeName(title)
  return FILE_EXTS.includes(extOf(base)) ? base : `${base}${currentExt || DEFAULT_EXT}`
}

async function pathExists(p) {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

// Find a directory/file name under `parentAbs` that doesn't collide with an
// existing entry, appending ' (2)', ' (3)', ... as needed. `base` never
// includes the extension: the counter has to land before it ('spec (2).md',
// not 'spec.md (2)'), so the two are only glued together here.
async function uniqueName(parentAbs, base, { ext = '' } = {}) {
  const candidateName = (n) => `${base}${n ? ` (${n + 1})` : ''}${ext}`
  let n = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = candidateName(n)
    if (!(await pathExists(path.join(parentAbs, candidate)))) return candidate
    n += 1
  }
}

// Run `fn` over `items` at most `limit` at a time. Plain Promise.all over a
// directory listing fans out one operation per entry, and a folder with a
// thousand subdirectories then opens a thousand files at once — which on
// Windows, with a virus scanner inspecting each one, is slower than doing them
// in batches and can stall the process outright.
const FS_CONCURRENCY = 12

async function mapLimit(items, fn, limit = FS_CONCURRENCY) {
  const out = new Array(items.length)
  let next = 0
  const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

// Directories the tree never shows. A dotted name is NOT enough to qualify:
// `.claude`, `.github` and `.opencode` hold real, editable content and the
// tree is the app's file explorer. `.git` is the one exception — it's git's
// own database, not authored content, and nothing in it is worth browsing.
const HIDDEN_DIRS = ['.git']

function isHiddenDir(name) {
  return HIDDEN_DIRS.includes(name.toLowerCase())
}

async function listDirs(absDir) {
  try {
    const entries = await fs.readdir(absDir, { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory() && !isHiddenDir(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

// Does this folder hold anything the tree would show? Answered without
// listing the folder's contents into memory, because it's asked once per
// visible folder purely to decide whether to draw an expand arrow.
async function hasVisibleChildren(absDir) {
  try {
    const entries = await fs.readdir(absDir, { withFileTypes: true })
    return entries.some((e) => (e.isDirectory() ? !isHiddenDir(e.name) : e.isFile()))
  } catch {
    return false
  }
}

// `exts` null lists every file; otherwise only those extensions. Dotfiles are
// listed either way — `.gitignore` and `.env.example` are files a file explorer
// shows, and the tree already shows dot folders.
async function listFilesWithExt(absDir, exts) {
  try {
    const entries = await fs.readdir(absDir, { withFileTypes: true })
    return entries
      .filter((e) => e.isFile() && (!exts || exts.includes(extOf(e.name))))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

// Everything in one folder — the tree hides no files.
function listWorkspaceFiles(absDir) {
  return listFilesWithExt(absDir, null)
}

// Stories only — the thread scan reads story files, and nothing else has a
// comment section to find.
function listStoryFiles(absDir) {
  return listFilesWithExt(absDir, STORY_EXTS)
}

// ---- folders ------------------------------------------------------------------

export async function listFolders(root, parentId_) {
  const abs = parentId_ ? resolveSafe(root, parentId_) : path.resolve(root)
  const names = await listDirs(abs)
  return names.map((name) => ({ id: joinId(parentId_, name), parent_id: toPosix(parentId_ || ''), name }))
}

export async function getFolder(root, id) {
  const abs = resolveSafe(root, id)
  if (!(await pathExists(abs))) return null
  return { id: toPosix(id), parent_id: parentId(id), name: path.basename(abs) }
}

export async function createFolder(root, data) {
  const parentAbs = data?.parent_id ? resolveSafe(root, data.parent_id) : path.resolve(root)
  await fs.mkdir(parentAbs, { recursive: true })
  const base = sanitizeName(data?.name || 'Untitled folder')
  const name = await uniqueName(parentAbs, base)
  await fs.mkdir(path.join(parentAbs, name), { recursive: true })
  return { id: joinId(data?.parent_id, name), parent_id: toPosix(data?.parent_id || ''), name }
}

export async function updateFolder(root, id, data) {
  const existing = await getFolder(root, id)
  if (!existing) return null
  if (!data?.name || data.name === existing.name) return existing
  const abs = resolveSafe(root, id)
  const parentAbs = path.dirname(abs)
  const newName = await uniqueName(parentAbs, sanitizeName(data.name))
  const newAbs = path.join(parentAbs, newName)
  await fs.rename(abs, newAbs)
  return { id: joinId(existing.parent_id, newName), parent_id: existing.parent_id, name: newName }
}

export async function deleteFolder(root, id) {
  const abs = resolveSafe(root, id)
  await fs.rm(abs, { recursive: true, force: true })
}

// ---- files ------------------------------------------------------------------

// A link is `{url, tag, color}`. Frontmatter written before tags existed holds
// bare URL strings, so those are widened here rather than migrated on disk —
// the file is only rewritten when the user next edits it. Fields are picked one
// by one so a hand-added key in the file doesn't travel to the UI as if it were
// part of the shape.
function normalizeLinks(links) {
  if (!Array.isArray(links)) return []
  return links
    .map((l) =>
      typeof l === 'string'
        ? { url: l.trim(), tag: '', color: '' }
        : { url: String(l?.url || '').trim(), tag: String(l?.tag || ''), color: String(l?.color || '') },
    )
    .filter((l) => l.url)
}

// The inverse: drop tag/color when unset so an untagged link stays a one-field
// map instead of carrying empty strings around.
function serializeLinks(links) {
  return normalizeLinks(links).map(({ url, tag, color }) => ({
    url,
    ...(tag ? { tag } : {}),
    ...(color ? { color } : {}),
  }))
}

// A file the tree lists but this module never parses: an HTML page, an image,
// or a markdown file that isn't a story. `cases`/`threads` are present and
// empty rather than absent, so every caller that reaches for them gets "none"
// and not a crash.
function plainFileNode(root, id, kind) {
  const abs = resolveSafe(root, id)
  const ext = rawExtOf(abs)
  return {
    id: toPosix(id),
    parent_id: parentId(id),
    kind,
    ext: ext.replace(/^\./, '').toLowerCase(),
    title: path.basename(abs, ext),
    cases: [],
    threads: [],
  }
}

// Read + parse one file into the shape callers expect: metadata fields
// spread alongside a `cases` array (each case has an ephemeral `id`, valid
// only until the file's cases are next mutated — same lifetime assumption
// the UI already makes between a tree fetch and the next single action).
//
// Only a story is parsed. A page or an image isn't opened at all, and a plain
// `.md` is described without being interpreted: the story fields it would
// otherwise be given (a default 'P1' criticality, an implicit "Case 1" holding
// its entire text) are fictions, and the tree would then offer to edit a README
// as though it had cases.
async function readFile_(root, id) {
  const abs = resolveSafe(root, id)
  const kind = fileKind(id)
  if (kind !== 'story') return (await pathExists(abs)) ? plainFileNode(root, id, kind) : null

  const raw = await fs.readFile(abs, 'utf8').catch(() => null)
  if (raw === null) return null

  const { frontmatter, cases, threads } = parseStoryFile(raw)
  const { criticality, links, ...rest } = frontmatter
  // The filename IS the title, so the extension is presentation, not content.
  const ext = rawExtOf(abs)
  return {
    id: toPosix(id),
    parent_id: parentId(id),
    kind: 'story',
    ext: ext.replace(/^\./, '').toLowerCase(),
    title: path.basename(abs, ext),
    criticality: criticality || 'P1',
    links: normalizeLinks(links),
    _extra: rest,
    cases: cases.map((c, i) => ({ id: `${toPosix(id)}::${i}`, story_id: toPosix(id), name: c.name, body: c.body })),
    threads,
  }
}

async function writeFile_(root, id, file) {
  const abs = resolveSafe(root, id)
  const frontmatter = {
    criticality: file.criticality || 'P1',
    links: serializeLinks(file.links),
    ...(file._extra || {}),
  }
  const content = serializeStoryFile({
    frontmatter,
    cases: (file.cases || []).map((c) => ({ name: c.name, body: c.body || '' })),
    threads: file.threads || [],
  })
  await fs.writeFile(abs, content, 'utf8')
}

// Tree/list payloads carry metadata only. Neither `cases` nor `threads` travel
// with a file: cases are fetched per open story through listCases, threads
// through listThreads/scanThreads. A workspace with many stories or a busy
// comment history doesn't bloat every tree fetch.
function stripDetail(file) {
  const { cases, threads, ...meta } = file
  return meta
}

export async function listFiles(root, parentId_) {
  const abs = parentId_ ? resolveSafe(root, parentId_) : path.resolve(root)
  const names = await listWorkspaceFiles(abs)
  const files = await mapLimit(names, (name) => readFile_(root, joinId(parentId_, name)))
  return files.filter(Boolean).map(stripDetail)
}

export async function getFile(root, id) {
  const file = await readFile_(root, id)
  return file ? stripDetail(file) : null
}

// `kind` picks what gets created: a story (the default — a `.s.md` with
// frontmatter and no cases yet) or a 'doc', a plain `.md` written empty. Both
// are markdown on disk; only the extension and the initial content differ, and
// everything downstream classifies the result by extension alone.
export async function createFile(root, data) {
  const parentAbs = data?.parent_id ? resolveSafe(root, data.parent_id) : path.resolve(root)
  await fs.mkdir(parentAbs, { recursive: true })
  const doc = data?.kind === 'doc'
  const base = sanitizeName(data?.title || (doc ? 'Untitled' : 'Untitled file'))
  const ext = doc ? MARKDOWN_EXTS[0] : DEFAULT_EXT
  const filename = await uniqueName(parentAbs, base, { ext })
  const id = joinId(data?.parent_id, filename)
  if (doc) await fs.writeFile(resolveSafe(root, id), '', 'utf8')
  else
    await writeFile_(root, id, {
      criticality: data?.criticality || 'P1',
      links: data?.links || [],
      cases: [],
    })
  return getFile(root, id)
}

// The id a rename would move this file to — the new filename, made unique
// against its own folder. Nothing is moved here; the caller decides when.
async function renamedIdOf(root, id, existing, title) {
  const abs = resolveSafe(root, id)
  const desired = filenameFor(title, rawExtOf(id))
  const ext = rawExtOf(desired)
  const base = desired.slice(0, desired.length - ext.length)
  const filename = await uniqueName(path.dirname(abs), base, { ext })
  return joinId(existing.parent_id, filename)
}

export async function updateFile(root, id, data) {
  const existing = await readFile_(root, id)
  if (!existing) return null
  const renaming = data?.title !== undefined && data.title !== existing.title

  // A doc or a page has no story structure to merge into, and writeFile_ would
  // re-serialize it AS a story — flattening a hand-written PRD into a
  // frontmatter block and an implicit case, or overwriting an HTML file with
  // markdown. Renaming is the only edit this route makes to one; its text is
  // edited through the /doc route (markdown) or not at all (HTML).
  if (existing.kind !== 'story') {
    if (!renaming) return getFile(root, id)
    const newId = await renamedIdOf(root, id, existing, data.title)
    await fs.rename(resolveSafe(root, id), resolveSafe(root, newId))
    return getFile(root, newId)
  }

  const merged = { ...existing, ...data }
  let finalId = toPosix(id)

  // Title changes rename the file (filename IS the title).
  if (renaming) {
    const newId = await renamedIdOf(root, id, existing, data.title)
    await writeFile_(root, id, merged) // write new content under the OLD path first
    await fs.rename(resolveSafe(root, id), resolveSafe(root, newId))
    finalId = newId
  } else {
    await writeFile_(root, id, merged)
  }

  return getFile(root, finalId)
}

export async function deleteFile(root, id) {
  const abs = resolveSafe(root, id)
  await fs.rm(abs, { force: true })
}

// ---- cases --------------------------------------------------------------------

function parseCaseId(id) {
  const idx = id.lastIndexOf('::')
  if (idx === -1) throw new Error(`Malformed case id: ${id}`)
  return { storyId: id.slice(0, idx), index: Number(id.slice(idx + 2)) }
}

function nextCaseName(existingNames, count) {
  let n = count + 1
  while (existingNames.has(`Case ${n}`)) n += 1
  return `Case ${n}`
}

export async function listCases(root, storyId) {
  if (!storyId) return []
  const file = await readFile_(root, storyId)
  return file ? file.cases : []
}

export async function getCase(root, id) {
  const { storyId, index } = parseCaseId(id)
  const file = await readFile_(root, storyId)
  return file?.cases?.[index] || null
}

export async function createCase(root, data) {
  if (!data?.story_id) throw new Error('createCase requires story_id')
  const file = await readFile_(root, data.story_id)
  if (!file) throw new Error(`File not found: ${data.story_id}`)
  const existingNames = new Set(file.cases.map((c) => c.name).filter(Boolean))
  const name = data.name || nextCaseName(existingNames, file.cases.length)
  const cases = [...file.cases, { name, body: data.body || '' }]
  await writeFile_(root, data.story_id, { ...file, cases })
  const index = cases.length - 1
  return { id: `${toPosix(data.story_id)}::${index}`, story_id: toPosix(data.story_id), name, body: data.body || '' }
}

export async function updateCase(root, id, data) {
  const { storyId, index } = parseCaseId(id)
  const file = await readFile_(root, storyId)
  if (!file || !file.cases[index]) return null
  const cases = file.cases.map((c, i) => (i === index ? { ...c, ...data } : c))
  await writeFile_(root, storyId, { ...file, cases })
  return { id, story_id: toPosix(storyId), name: cases[index].name, body: cases[index].body }
}

export async function deleteCase(root, id) {
  const { storyId, index } = parseCaseId(id)
  const file = await readFile_(root, storyId)
  if (!file) return
  const cases = file.cases.filter((_, i) => i !== index)
  await writeFile_(root, storyId, { ...file, cases })
}

// Rewrite a file's cases into `orderedIds` order (case tab drag & drop — the
// only reordering this repo supports; folders/files are always listed
// alphabetically).
export async function reorderCases(root, storyId, orderedIds) {
  const file = await readFile_(root, storyId)
  if (!file) return
  const byId = new Map(file.cases.map((c) => [c.id, c]))
  const cases = orderedIds.map((id) => byId.get(id)).filter(Boolean)
  await writeFile_(root, storyId, { ...file, cases })
}

// ---- comment threads ----------------------------------------------------------
//
// Threads live in the story file's `<!-- comments -->` section (see
// story-file.js), which makes the markdown the single source of truth: a
// thread survives a git clone, and anything reading the file as prose sees
// what was commented on and what was said. The SQLite index the app keeps for
// cross-story queries is derived from these files and can always be rebuilt by
// rescanning, so the two can never disagree for long.
//
// Every mutation goes through mutateThreads(), which re-reads the file
// immediately before writing. The story panel autosaves a case body on a
// 500ms debounce, so a comment written from the same window would otherwise
// be clobbered by an in-flight case save (or vice versa) — both paths do a
// full-file read-modify-write, and the re-read keeps that window as small as
// the filesystem allows.

// A mention is a bare `@someone@corp.test` in a comment body — plain text, so
// it stays readable to a human and to an AI, and matchable for the "For You"
// filter without a parallel data structure.
const MENTION_RE = /@([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g

const RESOLVED_NOTE = '_Marked as resolved._'
const REOPENED_NOTE = '_Reopened._'

function newThreadId() {
  return `t_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

function nowIso() {
  return new Date().toISOString()
}

export function extractMentions(text) {
  const found = new Set()
  for (const m of String(text || '').matchAll(MENTION_RE)) found.add(m[1].toLowerCase())
  return [...found]
}

// Flatten one parsed thread into the row shape the panel and the SQLite index
// both consume. `author` is whoever opened the thread, not whoever last
// replied — it's the field that decides who may delete it.
function enrichThread(thread, file) {
  const comments = thread.comments || []
  const mentions = new Set()
  for (const c of comments) for (const email of extractMentions(c.body)) mentions.add(email)
  return {
    id: thread.id,
    story_id: file.id,
    story_title: file.title,
    case_name: thread.caseName || '',
    status: thread.status,
    anchor: thread.anchor,
    comments,
    author: comments[0]?.author || '',
    mentions: [...mentions],
    created_at: comments[0]?.at || '',
    updated_at: comments[comments.length - 1]?.at || '',
    reply_count: Math.max(0, comments.length - 1),
  }
}

// Re-read, apply `fn` to the thread array, write back. `fn` returns the new
// array, or throws to abort the write.
async function mutateThreads(root, storyId, fn) {
  const file = await readFile_(root, storyId)
  if (!file) throw new Error(`File not found: ${storyId}`)
  const threads = fn(file.threads || [], file)
  await writeFile_(root, storyId, { ...file, threads })
  return { file, threads }
}

function findThread(threads, threadId) {
  const index = threads.findIndex((t) => t.id === threadId)
  if (index === -1) throw new Error(`Thread not found: ${threadId}`)
  return index
}

export async function listThreads(root, storyId) {
  if (!storyId) return []
  const file = await readFile_(root, storyId)
  if (!file) return []
  return (file.threads || []).map((t) => enrichThread(t, file))
}

// `anchor` is a text-quote selector ({ quote, prefix, suffix }) or null for a
// story-level comment — the panel's "+ New" button, which highlights nothing.
export async function createThread(root, data) {
  if (!data?.story_id) throw new Error('createThread requires story_id')
  if (!data?.author) throw new Error('createThread requires author')
  if (!String(data?.body || '').trim()) throw new Error('createThread requires a non-empty body')

  const id = newThreadId()
  const thread = {
    id,
    caseName: data.case_name || '',
    status: 'open',
    anchor: data.anchor?.quote
      ? {
          quote: data.anchor.quote,
          prefix: data.anchor.prefix || '',
          suffix: data.anchor.suffix || '',
          // Which occurrence of the quote this was — the resolver's last-resort
          // tiebreaker when the quote and its context both repeat identically.
          ...(Number(data.anchor.nth) > 0 ? { nth: Number(data.anchor.nth) } : {}),
        }
      : null,
    comments: [{ author: data.author, at: data.at || nowIso(), body: String(data.body).trim() }],
  }
  const { file, threads } = await mutateThreads(root, data.story_id, (existing) => [...existing, thread])
  return enrichThread(threads[threads.length - 1], file)
}

export async function addReply(root, storyId, threadId, data) {
  if (!data?.author) throw new Error('addReply requires author')
  if (!String(data?.body || '').trim()) throw new Error('addReply requires a non-empty body')

  let updated = null
  const { file } = await mutateThreads(root, storyId, (threads) => {
    const index = findThread(threads, threadId)
    updated = {
      ...threads[index],
      comments: [
        ...threads[index].comments,
        { author: data.author, at: data.at || nowIso(), body: String(data.body).trim() },
      ],
    }
    return threads.map((t, i) => (i === index ? updated : t))
  })
  return enrichThread(updated, file)
}

// Resolving appends a note as a final comment rather than only flipping a
// flag, so the file reads as a conversation that reached an end — the same way
// the panel shows it, and the way an AI reading the markdown will see it.
export async function setThreadStatus(root, storyId, threadId, data) {
  const status = data?.status === 'resolved' ? 'resolved' : 'open'
  if (!data?.author) throw new Error('setThreadStatus requires author')

  let updated = null
  const { file } = await mutateThreads(root, storyId, (threads) => {
    const index = findThread(threads, threadId)
    const thread = threads[index]
    if (thread.status === status) {
      updated = thread
      return threads
    }
    updated = {
      ...thread,
      status,
      comments: [
        ...thread.comments,
        { author: data.author, at: data.at || nowIso(), body: status === 'resolved' ? RESOLVED_NOTE : REOPENED_NOTE },
      ],
    }
    return threads.map((t, i) => (i === index ? updated : t))
  })
  return enrichThread(updated, file)
}

// Only the person who opened a thread can delete it; anyone can resolve one.
// Enforced here rather than in the UI so the rule holds for every caller —
// it's a trusted-team convention, not a security boundary (identity is just
// whatever git is configured with).
export async function deleteThread(root, storyId, threadId, data) {
  await mutateThreads(root, storyId, (threads) => {
    const index = findThread(threads, threadId)
    const author = threads[index].comments?.[0]?.author || ''
    if (!data?.requester || data.requester !== author) {
      throw new Error(`Only the thread author (${author || 'unknown'}) can delete this thread`)
    }
    return threads.filter((_, i) => i !== index)
  })
}

// Every comment thread in the workspace — what answers "all comments in this
// repo" and "everything that mentions me".
//
// The candidate files are found with ripgrep rather than by walking: a thread
// is written as a one-line `<!-- thread ... -->` marker (see story-file.js), so
// a file with no such line cannot hold a comment and never needs opening. On a
// repository carrying a node_modules directory that is the difference between
// reading ~1,450 markdown files and reading the handful that actually have
// comments in them.
//
// The pattern only has to be a filter — anything it lets through is parsed
// properly afterwards by parseStoryFile, which is the authority on what counts.
const THREAD_LINE = '<!--[ \t]*thread[ \t]'

export async function scanThreads(root) {
  const matches = await search.filesMatching(root, THREAD_LINE, {
    globs: STORY_EXTS.map((ext) => `*${ext}`),
  })
  const ids = matches ?? (await allStoryFilesByWalk(root))

  const files = await mapLimit(ids, (id) => readFile_(root, id))
  const out = []
  for (const file of files) {
    if (!file) continue
    for (const t of file.threads || []) out.push(enrichThread(t, file))
  }
  return out
}

// The pre-ripgrep behaviour, kept for a machine that won't run the bundled
// binary. Reads every directory in the workspace to find the stories in it.
async function allStoryFilesByWalk(root) {
  const ids = []
  async function walk(parentId_) {
    const abs = parentId_ ? resolveSafe(root, parentId_) : path.resolve(root)
    for (const name of await listStoryFiles(abs)) ids.push(joinId(parentId_, name))
    for (const dir of await listDirs(abs)) await walk(joinId(parentId_, dir))
  }
  await walk(null)
  return ids
}

// ---- move (drag a folder/file into a different parent) -----------------------

export async function moveNode(root, nodeType, id, newParentId) {
  const abs = resolveSafe(root, id)
  const newParentAbs = newParentId ? resolveSafe(root, newParentId) : path.resolve(root)
  await fs.mkdir(newParentAbs, { recursive: true })

  if (nodeType === 'file') {
    const ext = rawExtOf(abs)
    const filename = await uniqueName(newParentAbs, path.basename(abs, ext), { ext })
    const newId = joinId(newParentId, filename)
    await fs.rename(abs, resolveSafe(root, newId))
    return getFile(root, newId)
  }
  if (nodeType === 'folder') {
    const name = await uniqueName(newParentAbs, path.basename(abs))
    const newId = joinId(newParentId, name)
    await fs.rename(abs, resolveSafe(root, newId))
    return getFolder(root, newId)
  }
  throw new Error(`moveNode: unsupported nodeType ${nodeType}`)
}

// ---- duplicate (recursive filesystem copy) ------------------------------------

export async function duplicateNode(root, nodeType, id) {
  const abs = resolveSafe(root, id)
  const parentAbs = path.dirname(abs)
  const pid = parentId(id)

  if (nodeType === 'file') {
    const ext = rawExtOf(abs)
    const filename = await uniqueName(parentAbs, `${path.basename(abs, ext)} (copy)`, { ext })
    const newId = joinId(pid, filename)
    await fs.copyFile(abs, resolveSafe(root, newId))
    return getFile(root, newId)
  }
  if (nodeType === 'folder') {
    const base = path.basename(abs)
    const name = await uniqueName(parentAbs, `${base} (copy)`)
    const newId = joinId(pid, name)
    await fs.cp(abs, resolveSafe(root, newId), { recursive: true })
    return getFolder(root, newId)
  }
  throw new Error(`duplicateNode: unsupported nodeType ${nodeType}`)
}

// ---- tree builder ---------------------------------------------------------------

// Recurse to arbitrary depth. Each node's `children` array holds subfolders
// first (alphabetical), then files (alphabetical) — folders carry their own
// `children`, files carry a `kind`.
//
// Cases deliberately do NOT travel with the tree. Only the open story's cases
// are ever read, so attaching them here meant parsing every story file in the
// workspace a second time to serve one file's worth — the dominant cost of a
// tree fetch in a large repo. The client fetches them per selection through
// listCases instead.
async function buildChildren(root, parentId_) {
  const folders = await listFolders(root, parentId_)
  const folderNodes = await mapLimit(folders, async (folder) => ({
    ...folder,
    type: 'folder',
    children: await buildChildren(root, folder.id),
  }))

  const files = await listFiles(root, parentId_)
  const fileNodes = files.map((file) => ({ ...file, type: 'file' }))

  return [...folderNodes, ...fileNodes]
}

export async function buildTree(root) {
  return buildChildren(root, null)
}

// ---- search ------------------------------------------------------------------

// How many results are worth reading properly. Ranking happens on paths alone
// (free); only the winners are opened to learn their `kind`, which is what the
// result row's glyph and the click's destination need.
const SEARCH_LIMIT = 50

// Rank a candidate path against a lowercased query. Lower is better; null means
// no match at all.
//
// A hit in the filename beats a hit anywhere else in the path, because someone
// typing 'login' wants Login.md and not the eleven files inside a folder that
// happens to be called Login. Within each group, an earlier match beats a later
// one and a shorter path beats a longer one — so the file itself outranks its
// deeply nested namesake.
function searchRank(id, query) {
  const lower = id.toLowerCase()
  const slash = lower.lastIndexOf('/')
  const base = slash === -1 ? lower : lower.slice(slash + 1)

  const inBase = base.indexOf(query)
  if (inBase !== -1) return inBase + lower.length / 1000
  const inPath = lower.indexOf(query)
  if (inPath !== -1) return 1000 + inPath + lower.length / 1000
  return null
}

// Everything the tree would show, as ids, for a workspace ripgrep can't search.
// Deliberately the slow path: it exists so the search box still answers on a
// machine that won't run the bundled binary, not because it's a good idea.
async function allWorkspaceFilesByWalk(root, cap = 20000) {
  const out = []
  async function walk(parentId_) {
    if (out.length >= cap) return
    const abs = parentId_ ? resolveSafe(root, parentId_) : path.resolve(root)
    for (const name of await listWorkspaceFiles(abs)) out.push(joinId(parentId_, name))
    for (const dir of await listDirs(abs)) {
      if (out.length >= cap) return
      await walk(joinId(parentId_, dir))
    }
  }
  await walk(null)
  return out
}

// Files whose path matches `query`, best first, described the way a tree node
// is — so the sidebar can render a result row and open it with the same code
// that handles a row in the tree.
//
// Matching is on the path, not on content: this answers "where is the file I
// mean", which is the question a collapsed tree creates. Content search is a
// different feature and would want its own result shape (line numbers, an
// excerpt), so it isn't smuggled in here.
export async function searchFiles(root, query, { limit = SEARCH_LIMIT } = {}) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return []

  // No extension filter: the tree lists every file, so search has to find every
  // file. What can't be opened still needs to be findable — a user looking for
  // 'budget.xlsx' wants to be told where it is.
  const ids = (await search.allFiles(root)) ?? (await allWorkspaceFilesByWalk(root))

  const ranked = []
  for (const id of ids) {
    const rank = searchRank(id, q)
    if (rank !== null) ranked.push([rank, id])
  }
  ranked.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]))

  // Only now is anything opened — `kind` can't be known from a path, and
  // reading every candidate to rank it would defeat the point.
  const winners = ranked.slice(0, limit).map(([, id]) => id)
  const nodes = await mapLimit(winners, (id) => readFile_(root, id))
  return nodes.filter(Boolean).map((file) => ({ ...stripDetail(file), type: 'file' }))
}

// ---- one level (what the app actually fetches) --------------------------------

// The folders directly under `parentId_` (alphabetical) followed by its files
// (alphabetical) — one level, no descent. A folder's contents are read when
// the user expands it and not before, which is the difference between opening
// a large repository instantly and walking every directory in it first.
//
// A folder carries `has_children` instead of its children: the sidebar only
// needs to know whether to draw an expand arrow, and that costs one directory
// read rather than a recursive descent.
export async function listChildren(root, parentId_) {
  const folders = await listFolders(root, parentId_)
  const folderNodes = await mapLimit(folders, async (folder) => ({
    ...folder,
    type: 'folder',
    has_children: await hasVisibleChildren(resolveSafe(root, folder.id)),
  }))

  const files = await listFiles(root, parentId_)
  const fileNodes = files.map((file) => ({ ...file, type: 'file' }))

  return [...folderNodes, ...fileNodes]
}
