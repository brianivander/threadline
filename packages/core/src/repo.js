// Threadline filesystem repository — replaces the SQLite-backed models.js.
//
// A workspace is a plain directory tree of arbitrary depth: any folder can
// hold any number of subfolders and `.md` files. Folders ARE directories
// (their name is their id's last segment); files ARE markdown files (see
// story-file.js for the on-disk format — frontmatter + `<!-- case: Name -->`
// delimited cases). There's no separate sort_order: folders and files list
// alphabetically by name (folders first, then files); cases keep the order
// they appear in the file (reordered by rewriting it).
//
// Comment threads live in the same markdown file, in its `<!-- comments -->`
// section — so they clone, diff and read as prose alongside the story they're
// about. They're deliberately absent from listFiles/getFile/buildTree
// payloads: fetch them with listThreads (one story) or scanThreads (the whole
// workspace, which is what answers "every comment mentioning me").
//
// IDs are POSIX-style paths relative to the workspace root ('/' separators
// regardless of OS), e.g. 'folder1/subfolder/login.md'. The workspace root
// itself is represented as '' / null.
//
// Every id is resolved with `resolveSafe` before touching the filesystem, so
// a caller can never read/write outside the workspace root.

import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseStoryFile, serializeStoryFile } from './story-file.js'

export const CRITICALITIES = ['P1', 'P2', 'P3', 'P4']

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

async function pathExists(p) {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

// Find a directory/file name under `parentAbs` that doesn't collide with an
// existing entry, appending ' (2)', ' (3)', ... as needed.
async function uniqueName(parentAbs, base, { isFile = false } = {}) {
  const candidateName = (n) => (isFile ? `${base}${n ? ` (${n + 1})` : ''}.md` : `${base}${n ? ` (${n + 1})` : ''}`)
  let n = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = candidateName(n)
    if (!(await pathExists(path.join(parentAbs, candidate)))) return candidate
    n += 1
  }
}

async function listDirs(absDir) {
  try {
    const entries = await fs.readdir(absDir, { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

async function listMdFiles(absDir) {
  try {
    const entries = await fs.readdir(absDir, { withFileTypes: true })
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
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

// Read + parse one file into the shape callers expect: metadata fields
// spread alongside a `cases` array (each case has an ephemeral `id`, valid
// only until the file's cases are next mutated — same lifetime assumption
// the UI already makes between a tree fetch and the next single action).
async function readFile_(root, id) {
  const abs = resolveSafe(root, id)
  const raw = await fs.readFile(abs, 'utf8').catch(() => null)
  if (raw === null) return null
  const { frontmatter, cases, threads } = parseStoryFile(raw)
  const { criticality, links, ...rest } = frontmatter
  const title = path.basename(abs, '.md')
  return {
    id: toPosix(id),
    parent_id: parentId(id),
    title,
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

// Tree/list payloads carry metadata only. `cases` are re-attached by
// buildTree where they're needed; `threads` never travel with a file — they're
// fetched through listThreads/scanThreads, so a workspace with a busy comment
// history doesn't bloat every tree fetch.
function stripDetail(file) {
  const { cases, threads, ...meta } = file
  return meta
}

export async function listFiles(root, parentId_) {
  const abs = parentId_ ? resolveSafe(root, parentId_) : path.resolve(root)
  const names = await listMdFiles(abs)
  const files = await Promise.all(names.map((name) => readFile_(root, joinId(parentId_, name))))
  return files.filter(Boolean).map(stripDetail)
}

export async function getFile(root, id) {
  const file = await readFile_(root, id)
  return file ? stripDetail(file) : null
}

export async function createFile(root, data) {
  const parentAbs = data?.parent_id ? resolveSafe(root, data.parent_id) : path.resolve(root)
  await fs.mkdir(parentAbs, { recursive: true })
  const base = sanitizeName(data?.title || 'Untitled file')
  const filename = await uniqueName(parentAbs, base, { isFile: true })
  const id = joinId(data?.parent_id, filename)
  await writeFile_(root, id, {
    criticality: data?.criticality || 'P1',
    links: data?.links || [],
    cases: [],
  })
  return getFile(root, id)
}

export async function updateFile(root, id, data) {
  const existing = await readFile_(root, id)
  if (!existing) return null
  const merged = { ...existing, ...data }
  let finalId = toPosix(id)

  // Title changes rename the file (filename IS the title).
  if (data?.title !== undefined && data.title !== existing.title) {
    const abs = resolveSafe(root, id)
    const parentAbs = path.dirname(abs)
    const base = sanitizeName(data.title)
    const filename = await uniqueName(parentAbs, base, { isFile: true })
    const newId = joinId(existing.parent_id, filename)
    await writeFile_(root, id, merged) // write new content under the OLD path first
    await fs.rename(abs, resolveSafe(root, newId))
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

// Walk every `.md` file in the workspace and collect its threads. This is what
// answers "all comments in this repo" and rebuilds the SQLite index; it reads
// each file once, so it's cheap enough to run on app start and after a write.
export async function scanThreads(root) {
  const out = []
  async function walk(parentId_) {
    const names = await listMdFiles(parentId_ ? resolveSafe(root, parentId_) : path.resolve(root))
    for (const name of names) {
      const file = await readFile_(root, joinId(parentId_, name))
      if (!file) continue
      for (const t of file.threads || []) out.push(enrichThread(t, file))
    }
    for (const dir of await listDirs(parentId_ ? resolveSafe(root, parentId_) : path.resolve(root))) {
      await walk(joinId(parentId_, dir))
    }
  }
  await walk(null)
  return out
}

// ---- move (drag a folder/file into a different parent) -----------------------

export async function moveNode(root, nodeType, id, newParentId) {
  const abs = resolveSafe(root, id)
  const newParentAbs = newParentId ? resolveSafe(root, newParentId) : path.resolve(root)
  await fs.mkdir(newParentAbs, { recursive: true })

  if (nodeType === 'file') {
    const filename = await uniqueName(newParentAbs, path.basename(abs, '.md'), { isFile: true })
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
    const base = path.basename(abs, '.md')
    const filename = await uniqueName(parentAbs, `${base} (copy)`, { isFile: true })
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
// `children`, files carry `cases`.
async function buildChildren(root, parentId_) {
  const folders = await listFolders(root, parentId_)
  const folderNodes = await Promise.all(
    folders.map(async (folder) => ({ ...folder, type: 'folder', children: await buildChildren(root, folder.id) })),
  )

  const files = await listFiles(root, parentId_)
  const fileNodes = await Promise.all(
    files.map(async (file) => ({ ...file, type: 'file', cases: await listCases(root, file.id) })),
  )

  return [...folderNodes, ...fileNodes]
}

export async function buildTree(root) {
  return buildChildren(root, null)
}
