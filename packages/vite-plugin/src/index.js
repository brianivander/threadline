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
// `options.dbPath` is optional. Given one, the plugin also maintains a SQLite
// index of comment threads (see thread-index.js) so those repo-wide lists come
// from one query instead of re-reading every file, and serves the user list
// for the `@` mention typeahead. Without it the index routes fall back to a
// live filesystem scan — same answers, just slower — so `npm run dev` outside
// Electron needs no database at all.
//
// Usage in vite.config.js:
//   import threadline from '@threadline/vite-plugin'
//   export default { plugins: [threadline({ defaultRoot: './workspace' })] }

import path from 'node:path'
import * as repo from '@threadline/core/repo'
import * as index from './thread-index.js'

export default function threadlineVitePlugin(options = {}) {
  const dbPath = options.dbPath || null

  // Roots whose index has been built in this process. A workspace is fully
  // reindexed once per run, then kept current per-story by the mutation
  // routes — so an edit made outside the app (a `git pull`, another editor)
  // is picked up on the next app start.
  const indexedRoots = new Set()

  async function ensureIndexed(root) {
    if (!dbPath || indexedRoots.has(root)) return
    indexedRoots.add(root)
    try {
      await index.reindexWorkspace(dbPath, root, await repo.scanThreads(root))
    } catch (err) {
      // A broken index must never take the API down with it — the markdown is
      // the source of truth, and every indexed read can fall back to a scan.
      indexedRoots.delete(root)
      console.error('[threadline] thread index build failed:', err)
    }
  }

  // Keep one story's rows current after a thread mutation. Best-effort for the
  // same reason: the write to markdown already succeeded.
  async function reindexStory(root, storyId) {
    if (!dbPath || !storyId) return
    try {
      await index.reindexStory(dbPath, root, storyId, await repo.listThreads(root, storyId))
    } catch (err) {
      console.error('[threadline] thread reindex failed:', err)
    }
  }

  // A story is gone from that path — deleted, renamed, or moved away.
  async function dropStoryFromIndex(root, storyId) {
    if (!dbPath || !storyId) return
    try {
      await index.removeStory(dbPath, root, storyId)
    } catch (err) {
      console.error('[threadline] thread index cleanup failed:', err)
    }
  }

  // Too many stories re-pathed at once to track individually (a folder rename,
  // delete or move). Forget the root so the next repo-wide read rebuilds it
  // from the files.
  function invalidateIndex(root) {
    indexedRoots.delete(root)
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

    // ---- tree (full hierarchy) ----
    if (parts[0] === 'tree' && method === 'GET') {
      return json(res, 200, { data: await repo.buildTree(root) })
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
      // Renaming a folder re-paths every story under it.
      invalidateIndex(root)
      return json(res, 200, { data: updated })
    }
    if (parts[0] === 'folders' && parts[1] && method === 'DELETE') {
      await repo.deleteFolder(root, getId(parts, 1))
      // Anything inside it is gone with it, stories included.
      invalidateIndex(root)
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
      // A title change renames the file, and the id IS the path — so the
      // indexed rows have to move with it, keeping the new story title.
      if (updated.id !== previousId) await dropStoryFromIndex(root, previousId)
      await reindexStory(root, updated.id)
      return json(res, 200, { data: updated })
    }
    if (parts[0] === 'files' && parts[1] && method === 'DELETE') {
      const storyId = getId(parts, 1)
      await repo.deleteFile(root, storyId)
      await dropStoryFromIndex(root, storyId)
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
      // Served from the index when there is one, and from a live scan
      // otherwise — the filters are applied the same way either way.
      const mentions = q.get('mentions')
      const status = q.get('status')
      await ensureIndexed(root)
      if (dbPath && indexedRoots.has(root)) {
        return json(res, 200, { data: await index.queryThreads(dbPath, root, { mentions, status }) })
      }
      let data = await repo.scanThreads(root)
      if (mentions) data = data.filter((t) => t.mentions.includes(String(mentions).toLowerCase()))
      if (status) data = data.filter((t) => t.status === status)
      return json(res, 200, { data: data.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))) })
    }
    if (parts[0] === 'comments' && method === 'POST' && !parts[1]) {
      const created = await repo.createThread(root, await readBody(req))
      await reindexStory(root, created.story_id)
      return json(res, 201, { data: created })
    }
    if (parts[0] === 'comments' && parts[1] && parts[2] === 'replies' && method === 'POST') {
      const body = await readBody(req)
      const updated = await repo.addReply(root, body.story_id, getId(parts, 1), body)
      await reindexStory(root, updated.story_id)
      return json(res, 201, { data: updated })
    }
    if (parts[0] === 'comments' && parts[1] && !parts[2] && method === 'PUT') {
      const body = await readBody(req)
      const updated = await repo.setThreadStatus(root, body.story_id, getId(parts, 1), body)
      await reindexStory(root, updated.story_id)
      return json(res, 200, { data: updated })
    }
    if (parts[0] === 'comments' && parts[1] && !parts[2] && method === 'DELETE') {
      // Query params, not a body: DELETE bodies aren't reliably forwarded.
      const storyId = q.get('story_id')
      await repo.deleteThread(root, storyId, getId(parts, 1), { requester: q.get('requester') })
      await reindexStory(root, storyId)
      return json(res, 200, { ok: true })
    }

    // ---- users (the `@` mention typeahead) ----
    // Every user this install has seen, from the same threadline.db that
    // electron/main.cjs registers the current git identity into.
    if (parts[0] === 'users' && method === 'GET') {
      return json(res, 200, { data: dbPath ? await index.listUsers(dbPath) : [] })
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
      // Moving a story re-paths just that one; moving a folder re-paths
      // everything under it, so the whole index is rebuilt.
      if (body.nodeType === 'file') {
        await dropStoryFromIndex(root, body.id)
        await reindexStory(root, moved.id)
      } else {
        invalidateIndex(root)
      }
      return json(res, 200, { data: moved })
    }

    // ---- duplicate (recursive filesystem copy of a folder or file) ----
    if (parts[0] === 'duplicate' && method === 'POST') {
      const body = await readBody(req)
      const created = await repo.duplicateNode(root, body.nodeType, body.id)
      // A copy carries the original's comment threads, so the copy's rows are
      // new — same thread ids, different story path.
      if (body.nodeType === 'file') await reindexStory(root, created.id)
      else invalidateIndex(root)
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
