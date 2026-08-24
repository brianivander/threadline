// SQLite index of comment threads — a DERIVED cache, never a second source of
// truth. Every thread lives in its story's markdown file (see
// @threadline/core's story-file.js); this table only mirrors what a full
// workspace scan would find, so any disagreement is fixed by reindexing rather
// than reconciled.
//
// What it buys over scanning the files each time:
//   - the repo-wide lists ("All stories", "For You") answer from one query
//     instead of reading every `.md` in the workspace on each filter change
//   - each row carries a `preview`, so the panel renders a thread list without
//     opening the files behind it
//   - it survives workspace switches, so reopening a workspace is instant
//
// The story currently open in the editor is deliberately NOT served from here
// — the panel reads that one straight from the API, because the editor needs
// anchors that match the file on disk exactly.
//
// sql.js is WASM rather than a native addon, matching the choice in
// electron/main.cjs: no electron-rebuild step to keep in sync with Electron's
// Node ABI. It loads the whole database into memory, so every mutation is a
// read-modify-write of the file. Writes are therefore serialized through a
// promise chain (see `withDb`) — two overlapping writes would otherwise each
// save a snapshot taken before the other, and the last one would silently win.

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)

const PREVIEW_LENGTH = 240

let sqlJsPromise = null
function getSqlJs() {
  if (!sqlJsPromise) {
    const initSqlJs = require_('sql.js')
    sqlJsPromise = initSqlJs({
      locateFile: (file) => path.join(path.dirname(require_.resolve('sql.js')), file),
    })
  }
  return sqlJsPromise
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS comment_threads (
  workspace_root TEXT NOT NULL,
  thread_id      TEXT NOT NULL,
  story_id       TEXT NOT NULL,
  story_title    TEXT,
  case_name      TEXT,
  status         TEXT,
  quote          TEXT,
  author         TEXT,
  mentions       TEXT,
  preview        TEXT,
  created_at     TEXT,
  updated_at     TEXT,
  reply_count    INTEGER,
  -- story_id is part of the key, not just a column: duplicating a story copies
  -- its comment threads verbatim, ids included, so a thread id is unique only
  -- within one file. Keyed on the thread alone, the copy's rows would replace
  -- the original's and the original's comments would vanish from every
  -- repo-wide list.
  PRIMARY KEY (workspace_root, story_id, thread_id)
);
CREATE INDEX IF NOT EXISTS idx_threads_root_story ON comment_threads (workspace_root, story_id);
CREATE INDEX IF NOT EXISTS idx_threads_root_status ON comment_threads (workspace_root, status);
`

// Writes are queued so a read-modify-write of the file can't interleave with
// another one.
let queue = Promise.resolve()

async function withDb(dbPath, fn, { write = false } = {}) {
  const run = async () => {
    const SQL = await getSqlJs()
    const db = fs.existsSync(dbPath) ? new SQL.Database(fs.readFileSync(dbPath)) : new SQL.Database()
    try {
      db.run(SCHEMA)
      const result = fn(db)
      if (write) {
        fs.mkdirSync(path.dirname(dbPath), { recursive: true })
        fs.writeFileSync(dbPath, Buffer.from(db.export()))
      }
      return result
    } finally {
      db.close()
    }
  }
  // Reads join the same queue: a read that overlapped a write would otherwise
  // open the file mid-replacement.
  const next = queue.then(run, run)
  queue = next.catch(() => {})
  return next
}

// Mentions are stored comma-delimited AND comma-wrapped (',a@x.test,b@y.test,')
// so an exact-address match is a plain LIKE '%,addr,%' — no risk of
// 'an@x.test' matching 'jan@x.test'.
function packMentions(mentions) {
  const list = (mentions || []).map((m) => String(m).toLowerCase()).filter(Boolean)
  return list.length ? `,${list.join(',')},` : ''
}

function unpackMentions(packed) {
  return String(packed || '')
    .split(',')
    .filter(Boolean)
}

function previewOf(thread) {
  const first = thread.comments?.[0]?.body || ''
  const flat = first.replace(/\s+/g, ' ').trim()
  return flat.length > PREVIEW_LENGTH ? `${flat.slice(0, PREVIEW_LENGTH - 1)}…` : flat
}

function insertRows(db, root, threads) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO comment_threads
      (workspace_root, thread_id, story_id, story_title, case_name, status, quote,
       author, mentions, preview, created_at, updated_at, reply_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  try {
    for (const t of threads) {
      stmt.run([
        root,
        t.id,
        t.story_id,
        t.story_title || '',
        t.case_name || '',
        t.status || 'open',
        t.anchor?.quote || '',
        t.author || '',
        packMentions(t.mentions),
        previewOf(t),
        t.created_at || '',
        t.updated_at || '',
        t.reply_count || 0,
      ])
    }
  } finally {
    stmt.free()
  }
}

// Replace the rows for one story. Called after every thread mutation: only the
// file that changed is re-read, so this stays cheap on a large workspace.
export async function reindexStory(dbPath, root, storyId, threads) {
  return withDb(
    dbPath,
    (db) => {
      db.run('DELETE FROM comment_threads WHERE workspace_root = ? AND story_id = ?', [root, storyId])
      insertRows(db, root, threads)
    },
    { write: true },
  )
}

// Replace every row for a workspace — run when a workspace is opened, and as
// the repair path whenever the index might have drifted from the files (an
// edit made outside the app, a `git pull`).
export async function reindexWorkspace(dbPath, root, threads) {
  return withDb(
    dbPath,
    (db) => {
      db.run('DELETE FROM comment_threads WHERE workspace_root = ?', [root])
      insertRows(db, root, threads)
    },
    { write: true },
  )
}

export async function removeStory(dbPath, root, storyId) {
  return withDb(
    dbPath,
    (db) => db.run('DELETE FROM comment_threads WHERE workspace_root = ? AND story_id = ?', [root, storyId]),
    { write: true },
  )
}

// `mentions` filters to threads mentioning one address — the "For You" tab.
// `status` and `storyId` are the two panel dropdowns.
export async function queryThreads(dbPath, root, { mentions, status, storyId } = {}) {
  return withDb(dbPath, (db) => {
    const where = ['workspace_root = ?']
    const params = [root]
    if (storyId) {
      where.push('story_id = ?')
      params.push(storyId)
    }
    if (status) {
      where.push('status = ?')
      params.push(status)
    }
    if (mentions) {
      where.push('mentions LIKE ?')
      params.push(`%,${String(mentions).toLowerCase()},%`)
    }
    const stmt = db.prepare(`
      SELECT thread_id, story_id, story_title, case_name, status, quote, author,
             mentions, preview, created_at, updated_at, reply_count
        FROM comment_threads
       WHERE ${where.join(' AND ')}
       ORDER BY updated_at DESC, thread_id DESC
    `)
    const rows = []
    try {
      stmt.bind(params)
      while (stmt.step()) {
        const r = stmt.getAsObject()
        rows.push({
          id: r.thread_id,
          story_id: r.story_id,
          story_title: r.story_title,
          case_name: r.case_name,
          status: r.status,
          quote: r.quote,
          author: r.author,
          mentions: unpackMentions(r.mentions),
          preview: r.preview,
          created_at: r.created_at,
          updated_at: r.updated_at,
          reply_count: r.reply_count,
        })
      }
    } finally {
      stmt.free()
    }
    return rows
  })
}

// Every user this app has ever seen, for the `@` mention typeahead. The table
// is populated by electron/main.cjs on first sight of a git-config email.
export async function listUsers(dbPath) {
  return withDb(dbPath, (db) => {
    const emails = []
    if (!db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").length) return emails
    const stmt = db.prepare('SELECT email FROM users ORDER BY email')
    try {
      while (stmt.step()) emails.push(stmt.getAsObject().email)
    } finally {
      stmt.free()
    }
    return emails
  })
}
