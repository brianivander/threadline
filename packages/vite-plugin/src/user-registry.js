// Read side of the user registry — every git identity this install has seen,
// which is what the `@` mention typeahead offers.
//
// The table is WRITTEN by electron/main.cjs on first sight of a git-config
// email (there is no login; the machine's git identity is the identity). This
// module only reads it, so a workspace opened outside Electron gets an empty
// list rather than an error.
//
// This file is what remains of a SQLite index that also cached every comment
// thread in the workspace. That cache is gone: ripgrep finds the files holding
// threads faster than the index could be kept honest (see @threadline/core's
// scanThreads), and a derived table that has to be rebuilt, invalidated and
// re-pathed alongside every mutation costs more than it saves. Nothing here
// caches anything.
//
// sql.js is WASM rather than a native addon, matching the choice in
// electron/main.cjs: no electron-rebuild step to keep in sync with Electron's
// Node ABI.

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)

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

// Every user this app has ever seen, for the `@` mention typeahead.
//
// Read-only and absence-tolerant: no database file, or a file without the
// table, both mean "nobody registered yet" — which is the truth on a fresh
// install and must not be an error.
export async function listUsers(dbPath) {
  if (!dbPath || !fs.existsSync(dbPath)) return []
  const SQL = await getSqlJs()
  const db = new SQL.Database(fs.readFileSync(dbPath))
  try {
    if (!db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").length) return []
    const emails = []
    const stmt = db.prepare('SELECT email FROM users ORDER BY email')
    try {
      while (stmt.step()) emails.push(stmt.getAsObject().email)
    } finally {
      stmt.free()
    }
    return emails
  } catch {
    // A corrupt or unreadable database must not take the typeahead down.
    return []
  } finally {
    db.close()
  }
}
