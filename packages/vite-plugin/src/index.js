// Threadline Vite plugin.
// Mounts a dev-server API at /api/threadline/* backed directly by the
// filesystem repo in @threadline/core. Stories, cases and comment threads all
// live in markdown files — no database holds any of it.
// Every request carries the workspace root to operate on via the
// `x-threadline-root` header (an absolute path); `options.defaultRoot` is
// used only when that header is absent, e.g. for a single-workspace setup.
//
// IDs are workspace-relative paths and may contain '/' (e.g.
// 'folder1/subfolder/login.md'). A caller MUST encodeURIComponent() the
// whole id before putting it in a URL path segment (so its internal '/'
// arrives as '%2F' and survives the pathname split below); getId() then
// decodeURIComponent()s it back to the real, slash-containing id.
//
// Comment threads are served under /comments — see the route block below.
// GET without a story_id walks the whole workspace, which is how the panel
// answers "every comment in this repo" and "every comment mentioning me".
//
// Comment threads are never indexed: the repo-wide lists are answered by a
// live scan, which ripgrep makes cheap (see @threadline/core's scanThreads).
// `options.dbPath` is optional and now serves one thing only — the user list
// behind the `@` mention typeahead, which the desktop app writes. Without it
// that list is empty and everything else works unchanged, so `npm run dev`
// outside Electron needs no database at all.
//
// Usage in vite.config.js:
//   import threadline from '@threadline/vite-plugin'
//   export default { plugins: [threadline({ defaultRoot: './workspace' })] }

import fs from 'node:fs/promises'
import path from 'node:path'
import * as repo from '@threadline/core/repo'
import * as users from './user-registry.js'

const MARKDOWN_FILE = /\.(md|markdown)$/i

// Past this, a "text" file is something else wearing a text extension — or a
// log nobody wants in an editor.
const MAX_TEXT_BYTES = 2 * 1024 * 1024

// What /raw is willing to serve, and the Content-Type it serves it as.
const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
}

export default function threadlineVitePlugin(options = {}) {
  const explicitDbPath = options.dbPath || null

  // The only thing still kept in SQLite is the user registry behind the `@`
  // mention typeahead, which the desktop app writes on first sight of a git
  // identity. Comment threads are no longer indexed at all — see the comments
  // route below.
  function resolveDbPath(root) {
    return explicitDbPath || path.join(root, 'threadline.db')
  }

  function resolveRoot(req) {
    const header = req.headers['x-threadline-root']
    const root = header ? decodeURIComponent(String(header)) : options.defaultRoot
    if (!root) throw new Error('No workspace root set: pass an x-threadline-root header or a defaultRoot option')
    return path.resolve(root)
  }

  function json(res, status, body) {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(body))
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = ''
      req.on('data', (chunk) => (data += chunk))
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {})
        } catch (err) {
          reject(err)
        }
      })
      req.on('error', reject)
    })
  }

  function getId(parts, index) {
    return parts[index] ? decodeURIComponent(parts[index]) : null
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost')
    const base = '/api/threadline'
    if (!url.pathname.startsWith(base)) return null

    const root = resolveRoot(req)
    const parts = url.pathname.slice(base.length).split('/').filter(Boolean)
    const q = url.searchParams
    const method = req.method

    // ---- tree (one level per request) ----
    // `parent_id` absent means the workspace root. The client asks for a
    // folder's children when the user expands it — see listChildren.
    if (parts[0] === 'tree' && method === 'GET') {
      return json(res, 200, { data: await repo.listChildren(root, q.get('parent_id') || null) })
    }

    // ---- search (filename, whole workspace) ----
    // The tree opens collapsed, so this is how a file that isn't on screen
    // gets found. Backed by ripgrep's file listing, which honours .gitignore —
    // so results never offer to open something out of node_modules.
    if (parts[0] === 'search' && method === 'GET') {
      return json(res, 200, { data: await repo.searchFiles(root, q.get('q') || '') })
    }

    // ---- folders ----
    if (parts[0] === 'folders' && method === 'GET' && !parts[1]) {
      return json(res, 200, { data: await repo.listFolders(root, q.get('parent_id') || null) })
    }
    if (parts[0] === 'folders' && method === 'POST') {
      const created = await repo.createFolder(root, await readBody(req))
      return json(res, 201, { data: created })
    }
    if (parts[0] === 'folders' && parts[1] && method === 'GET') {
      const found = await repo.getFolder(root, getId(parts, 1))
      return found ? json(res, 200, { data: found }) : json(res, 404, { error: 'Not found' })
    }
    if (parts[0] === 'folders' && parts[1] && method === 'PUT') {
      const updated = await repo.updateFolder(root, getId(parts, 1), await readBody(req))
      if (!updated) return json(res, 404, { error: 'Not found' })
      return json(res, 200, { data: updated })
    }
    if (parts[0] === 'folders' && parts[1] && method === 'DELETE') {
      await repo.deleteFolder(root, getId(parts, 1))
      return json(res, 200, { ok: true })
    }

    // ---- files ----
    if (parts[0] === 'files' && method === 'GET' && !parts[1]) {
      return json(res, 200, { data: await repo.listFiles(root, q.get('parent_id') || null) })
    }
    if (parts[0] === 'files' && method === 'POST') {
      const created = await repo.createFile(root, await readBody(req))
      return json(res, 201, { data: created })
    }
    if (parts[0] === 'files' && parts[1] && method === 'GET') {
      const found = await repo.getFile(root, getId(parts, 1))
      return found ? json(res, 200, { data: found }) : json(res, 404, { error: 'Not found' })
    }
    if (parts[0] === 'files' && parts[1] && method === 'PUT') {
      const previousId = getId(parts, 1)
      const updated = await repo.updateFile(root, previousId, await readBody(req))
      if (!updated) return json(res, 404, { error: 'Not found' })
      return json(res, 200, { data: updated })
    }
    if (parts[0] === 'files' && parts[1] && method === 'DELETE') {
      await repo.deleteFile(root, getId(parts, 1))
      return json(res, 200, { ok: true })
    }

    // ---- cases ----
    if (parts[0] === 'cases' && method === 'GET' && !parts[1]) {
      return json(res, 200, { data: await repo.listCases(root, q.get('story_id') || null) })
    }
    if (parts[0] === 'cases' && method === 'POST') {
      const created = await repo.createCase(root, await readBody(req))
      return json(res, 201, { data: created })
    }
    if (parts[0] === 'cases' && parts[1] && method === 'GET') {
      const found = await repo.getCase(root, getId(parts, 1))
      return found ? json(res, 200, { data: found }) : json(res, 404, { error: 'Not found' })
    }
    if (parts[0] === 'cases' && parts[1] && method === 'PUT') {
      const updated = await repo.updateCase(root, getId(parts, 1), await readBody(req))
      if (!updated) return json(res, 404, { error: 'Not found' })
      return json(res, 200, { data: updated })
    }
    if (parts[0] === 'cases' && parts[1] && method === 'DELETE') {
      await repo.deleteCase(root, getId(parts, 1))
      return json(res, 200, { ok: true })
    }

    // ---- comment threads ----
    // Stored in the story file's `<!-- comments -->` section. `story_id` is
    // always explicit (query for reads/deletes, body for writes) because a
    // thread id alone would mean scanning the workspace to find its file —
    // and every caller already knows which story it's looking at.
    if (parts[0] === 'comments' && method === 'GET' && !parts[1]) {
      const storyId = q.get('story_id')
      // A story_id always reads the files directly: this is the story open in
      // the editor, and its anchors have to match the markdown exactly.
      if (storyId) return json(res, 200, { data: await repo.listThreads(root, storyId) })

      // No story_id: the repo-wide lists behind "All stories" and "For You".
      //
      // Scanned live, every time. This used to be served from a SQLite index
      // because the scan meant walking the whole workspace and reading every
      // markdown file in it; ripgrep now finds the files that actually hold
      // threads in a fraction of a second (see repo.scanThreads), so the index
      // bought nothing and cost the usual price of a cache — going stale
      // whenever a file changed outside the app, and needing to be rebuilt,
      // invalidated and re-pathed alongside every mutation.
      const mentions = q.get('mentions')
      const status = q.get('status')
      let data = await repo.scanThreads(root)
      if (mentions) data = data.filter((t) => t.mentions.includes(String(mentions).toLowerCase()))
      if (status) data = data.filter((t) => t.status === status)
      return json(res, 200, { data: data.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))) })
    }
    if (parts[0] === 'comments' && method === 'POST' && !parts[1]) {
      const created = await repo.createThread(root, await readBody(req))
      return json(res, 201, { data: created })
    }
    if (parts[0] === 'comments' && parts[1] && parts[2] === 'replies' && method === 'POST') {
      const body = await readBody(req)
      const updated = await repo.addReply(root, body.story_id, getId(parts, 1), body)
      return json(res, 201, { data: updated })
    }
    if (parts[0] === 'comments' && parts[1] && !parts[2] && method === 'PUT') {
      const body = await readBody(req)
      const updated = await repo.setThreadStatus(root, body.story_id, getId(parts, 1), body)
      return json(res, 200, { data: updated })
    }
    if (parts[0] === 'comments' && parts[1] && !parts[2] && method === 'DELETE') {
      // Query params, not a body: DELETE bodies aren't reliably forwarded.
      const storyId = q.get('story_id')
      await repo.deleteThread(root, storyId, getId(parts, 1), { requester: q.get('requester') })
      return json(res, 200, { ok: true })
    }

    // ---- doc (a markdown file opened from a story link) ----
    // Addressed by absolute filesystem path, NOT by a workspace-relative id.
    // A story link is stored relative to the story file and may well resolve
    // outside the workspace (../../designs/spec.md), so it has no id, no row
    // in the tree, and the root-escape guard the routes above rely on doesn't
    // apply to it. The extension check IS the access rule here: this reads and
    // writes markdown and nothing else. That is the same reach the app already
    // has — it is the desktop shell's own backend, bound to localhost, opening
    // a path the user typed into a link themselves.
    if (parts[0] === 'doc' && method === 'GET') {
      const file = q.get('path')
      if (!file) throw new Error('doc requires a path')
      if (!MARKDOWN_FILE.test(file)) throw new Error('doc requires a .md or .markdown file')
      return json(res, 200, { data: { path: file, markdown: await fs.readFile(file, 'utf8') } })
    }
    if (parts[0] === 'doc' && method === 'PUT') {
      const body = await readBody(req)
      if (!body.path) throw new Error('doc requires a path')
      if (!MARKDOWN_FILE.test(body.path)) throw new Error('doc requires a .md or .markdown file')
      await fs.writeFile(body.path, String(body.markdown ?? ''), 'utf8')
      return json(res, 200, { ok: true })
    }

    // ---- text (a plain-text file opened in a tab) ----
    // Addressed by absolute path like /doc, and restricted to the extensions
    // core says are text (TEXT_OPEN_EXTS, which includes .html — an HTML file
    // is editable source as well as a page to look at). A file with no
    // extension is text too: '.gitignore' and 'Dockerfile' are written to be
    // read, and there is nothing to consult.
    //
    // Size-capped, because "is this text" is answered by extension and an
    // extension can lie. A 200 MB log is not something to load into an editor
    // even when it really is text.
    if (parts[0] === 'text' && (method === 'GET' || method === 'PUT')) {
      const body = method === 'PUT' ? await readBody(req) : null
      const file = method === 'PUT' ? body.path : q.get('path')
      if (!file) throw new Error('text requires a path')
      const ext = path.extname(file).toLowerCase()
      if (ext !== '' && !repo.TEXT_OPEN_EXTS.includes(ext)) {
        throw new Error('text serves plain-text files only')
      }
      if (method === 'PUT') {
        await fs.writeFile(file, String(body.text ?? ''), 'utf8')
        return json(res, 200, { ok: true })
      }
      const { size } = await fs.stat(file)
      if (size > MAX_TEXT_BYTES) {
        return json(res, 413, {
          error: `This file is ${Math.round(size / 1024 / 1024)} MB — too large to open here.`,
        })
      }
      return json(res, 200, { data: { path: file, text: await fs.readFile(file, 'utf8') } })
    }

    // ---- raw (a file's bytes, for an image shown in a tab) ----
    // Addressed by absolute path like /doc, for the same reason: an image may
    // be linked from a story and live outside the workspace entirely.
    //
    // This exists because the renderer is served over http, so an <img> cannot
    // load a file:// URL — Electron blocks it, and rightly. Images only: this
    // is not a general "read any file off the disk" endpoint.
    if (parts[0] === 'raw' && method === 'GET') {
      const file = q.get('path')
      if (!file) throw new Error('raw requires a path')
      const type = IMAGE_TYPES[path.extname(file).toLowerCase()]
      if (!type) throw new Error('raw serves images only')
      const bytes = await fs.readFile(file)
      res.statusCode = 200
      res.setHeader('Content-Type', type)
      // The path IS the identity and the bytes change when the file does, so
      // this must not be cached across an edit.
      res.setHeader('Cache-Control', 'no-store')
      return res.end(bytes)
    }

    // ---- users (the `@` mention typeahead) ----
    // Every user this install has seen, from the same threadline.db that
    // electron/main.cjs registers the current git identity into.
    if (parts[0] === 'users' && method === 'GET') {
      return json(res, 200, { data: await users.listUsers(resolveDbPath(root)) })
    }

    // ---- reorder (case tab drag & drop — the only reordering the filesystem
    // backend supports; projects/features/stories always list alphabetically) ----
    if (parts[0] === 'reorder' && method === 'POST') {
      const body = await readBody(req)
      await repo.reorderCases(root, body.storyId, body.orderedIds)
      return json(res, 200, { ok: true })
    }

    // ---- move (drag a folder/file into a different parent) ----
    if (parts[0] === 'move' && method === 'POST') {
      const body = await readBody(req)
      const moved = await repo.moveNode(root, body.nodeType, body.id, body.newParentId)
      return json(res, 200, { data: moved })
    }

    // ---- duplicate (recursive filesystem copy of a folder or file) ----
    if (parts[0] === 'duplicate' && method === 'POST') {
      const body = await readBody(req)
      const created = await repo.duplicateNode(root, body.nodeType, body.id)
      return json(res, 200, { data: created })
    }

    return json(res, 404, { error: 'Unknown threadline route' })
  }

  // The repo signals rejected input by throwing. Classify by message so a
  // caller can tell "you asked for something that isn't there" and "you aren't
  // allowed to do that" apart from a genuine server fault — the comment panel
  // shows the author-only delete rule to the user, so it must not arrive as a
  // 500.
  function statusForError(message) {
    if (/not found/i.test(message)) return 404
    // A doc route reading a link that points at a file which has since been
    // moved or deleted — the panel says so, rather than reporting a fault.
    if (/^ENOENT/.test(message)) return 404
    if (/^EACCES|^EPERM/.test(message)) return 403
    if (/^only the thread author/i.test(message)) return 403
    if (/requires|non-empty/i.test(message)) return 400
    if (/escapes workspace root/i.test(message)) return 400
    return 500
  }

  async function middleware(req, res, next) {
    const url = new URL(req.url, 'http://localhost')
    if (!url.pathname.startsWith('/api/threadline')) return next()
    try {
      await handle(req, res)
    } catch (err) {
      const message = String(err.message || err)
      const status = statusForError(message)
      // A rejected request is the client's business, not a server incident —
      // only log the ones that really are ours.
      if (status >= 500) console.error('[threadline] API error:', err)
      return json(res, status, { error: message })
    }
  }

  return {
    name: 'threadline',
    async configureServer(server) {
      server.middlewares.use(middleware)
    },
    async configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}
