// Electron shell for this app. Starts its own server in-process, loads it into
// a BrowserWindow, and closes the server when the window closes — one command
// (`npm start`) does both.
//
// Loading an http URL (never file://) is mandatory: <ThreadlinePanel> calls the
// Threadline REST API at the relative path /api/threadline, so a static file
// load would resolve those to file:///api/threadline and 404 every board
// request. Unpackaged that server is Vite itself; packaged there is no Vite, so
// startProdServer() serves the built dist/ with the same API mounted on it.
//
// CommonJS deliberately, not ESM: Electron's main process can't `import` the
// 'electron' module itself (its exports are computed dynamically depending on
// process.type, which trips up Node's ESM/CJS interop with a
// "Cannot read properties of undefined (reading 'exports')" crash before any
// of our code runs, default import or named). `vite`, being ESM-first, is
// loaded with a dynamic import() instead of require('vite') — the latter
// works but hits Vite's deprecated, warning-emitting CJS compat shim.

const { app, BrowserWindow, nativeTheme, session, ipcMain, dialog } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')
const { describeWorkspace, syncWorkspace, listGitHubAccounts, probeAccountAccess, authorForAccount } = require('./git-sync.cjs')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const DIST_DIR = path.join(PROJECT_ROOT, 'dist')
const EMBED_PARTITION = 'persist:embeds'

// Trusted-team identity: no login, just whatever git already knows the
// machine as. One SQLite file every install upserts into on first sight of an
// email — see getOrCreateUserEmail(). When a workspace directory is provided,
// the db lives inside it (threadline.db alongside the project's files); the
// fallback (packaged: userData, dev: sibling of PROJECT_ROOT) only covers the
// case where no workspace has been chosen yet.
let userDbPath = null
function getUserDbPath(workspaceDir) {
  if (workspaceDir) return path.join(workspaceDir, 'threadline.db')
  if (!userDbPath) {
    userDbPath = app.isPackaged
      ? path.join(app.getPath('userData'), 'threadline.db')
      : path.resolve(PROJECT_ROOT, '..', 'threadline.db')
  }
  return userDbPath
}

// A stock desktop Chrome UA — Electron's real UA gets OAuth sign-in (Google,
// etc.) refused outright, which would defeat the entire point of the embed
// panel keeping its own logged-in session.
const EMBED_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

let viteServer = null
let prodServer = null
let mainWindow = null

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
}

async function startVite() {
  const { createServer } = await import('vite')
  viteServer = await createServer({
    root: PROJECT_ROOT,
    server: { open: false },
  })
  await viteServer.listen()
  const url = viteServer.resolvedUrls?.local?.[0]
  if (!url) throw new Error('Vite started but reported no local URL')
  return url
}

// The packaged stand-in for the dev server: the built dist/ as static files,
// with @threadline/vite-plugin's own /api/threadline middleware in front of
// them, so the renderer sees exactly the same origin-relative API it does in
// development and there is only one implementation of that API to maintain.
// Port 0 — the OS picks a free one, so two copies of the app can't collide.
async function startProdServer() {
  const http = require('node:http')
  const { default: threadline } = await import('@threadline/vite-plugin')

  // configureServer() only ever calls server.middlewares.use(), so a stub with
  // that one method is all the plugin needs to hand over its handler.
  const middlewares = []
  await threadline().configureServer({
    middlewares: { use: (fn) => middlewares.push(fn) },
  })

  prodServer = http.createServer((req, res) => {
    const runFrom = (i) =>
      i < middlewares.length ? middlewares[i](req, res, () => runFrom(i + 1)) : serveStatic(req, res)
    runFrom(0)
  })

  await new Promise((resolve, reject) => {
    prodServer.once('error', reject)
    prodServer.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${prodServer.address().port}/`
}

function serveStatic(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost')
  const requested = path.join(DIST_DIR, decodeURIComponent(pathname))
  // index.html for the app root and for anything that isn't a real file inside
  // dist/ — that both keeps a client-side route working across a reload and
  // makes a crafted path unable to read outside the build.
  const isFile = requested.startsWith(DIST_DIR) && fs.existsSync(requested) && fs.statSync(requested).isFile()
  const file = isFile ? requested : path.join(DIST_DIR, 'index.html')
  res.setHeader('Content-Type', MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream')
  fs.createReadStream(file).pipe(res)
}

// Embedded pages (Figma, Google Docs/Sheets, ...) get their own persistent
// partition, isolated from the app's own session, with framing restrictions
// stripped so pages that refuse to be framed (the entire reason this app
// exists instead of an <iframe>) still load inside <webview>.
function setupEmbedSession() {
  const embedSession = session.fromPartition(EMBED_PARTITION)
  embedSession.setUserAgent(EMBED_USER_AGENT)
  embedSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders }
    for (const key of Object.keys(responseHeaders)) {
      if (/^x-frame-options$/i.test(key) || /^content-security-policy$/i.test(key)) {
        delete responseHeaders[key]
      }
    }
    callback({ responseHeaders })
  })
}

// The workspace folder (a plain directory of projects/features/stories) is
// chosen at runtime, never hardcoded — App.jsx calls this via preload.cjs's
// chooseWorkspace() when the user clicks the sidebar's open-folder button.
// Registered once: createWindow() can run again on macOS 'activate', and
// ipcMain.handle throws if the same channel is registered twice.
let workspaceHandlersReady = false
function setupWorkspaceHandlers() {
  if (workspaceHandlersReady) return
  workspaceHandlersReady = true
  ipcMain.handle('threadline:choose-workspace', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || !result.filePaths.length) return null
    return result.filePaths[0]
  })
}

// Resolve the git email for a given directory: `git config user.email` walks
// from that directory up to the repo root, then falls back to global config.
// The workspace folder is what matters (each person's identity lives in the
// repo they're working in), not Threadline's own checkout — so cwd is the
// selected workspace, not PROJECT_ROOT. No email configured -> null.
function getGitUserEmail(workspaceDir) {
  try {
    const email = execFileSync('git', ['config', 'user.email'], {
      cwd: workspaceDir || PROJECT_ROOT,
      encoding: 'utf8',
    }).trim()
    return email || null
  } catch {
    return null
  }
}

// Sidebar footer's Sync button. The git work itself lives in git-sync.cjs so
// it can be tested without Electron; this is only the IPC seam, and it never
// lets an exception cross it — the renderer gets a reason string instead.
let syncHandlersReady = false
function setupSyncHandlers() {
  if (syncHandlersReady) return
  syncHandlersReady = true
  ipcMain.handle('threadline:git-status', async (_e, root) => {
    try {
      return await describeWorkspace(root)
    } catch (err) {
      console.error('Failed to read workspace git status:', err)
      return { state: 'no-git' }
    }
  })
  ipcMain.handle('threadline:sync', async (_e, root, opts) => {
    try {
      const result = await syncWorkspace(root, opts || {})
      // git's stderr, verbatim, in the terminal running the app — a failure
      // should never need a debugging session to identify.
      if (!result.ok) console.error(`Sync failed (${result.reason}):`, result.detail || '(no output)')
      return result
    } catch (err) {
      console.error('Workspace sync failed:', err)
      return { ok: false, reason: 'push-failed', detail: `${err.message || err}` }
    }
  })
}

// The nearest git repo root walking up from a folder — e.g. the `requirements`
// subfolder resolves to the `10 Gruntable Books` repo root. Used as the key so
// every subfolder of the same repo shares one chosen account, not per-folder.
function repoRootOf(workspaceDir) {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: workspaceDir || PROJECT_ROOT,
      encoding: 'utf8',
    }).trim()
    return root || workspaceDir
  } catch {
    return workspaceDir
  }
}

// A workspace's chosen push account, keyed on its repo root so every subfolder
// of the same repo shares the one answer. Stored in the same threadline.db as
// the user registry.
async function readWorkspaceAccount(workspaceDir) {
  const key = repoRootOf(workspaceDir)
  const table = 'CREATE TABLE IF NOT EXISTS workspace_accounts (workspace_root TEXT PRIMARY KEY NOT NULL, username TEXT NOT NULL, created_at TEXT NOT NULL)'
  const SQL = await getSqlJs()
  const dbPath = getUserDbPath(workspaceDir)
  const db = fs.existsSync(dbPath) ? new SQL.Database(fs.readFileSync(dbPath)) : new SQL.Database()
  let username = null
  try {
    db.run(table)
    const stmt = db.prepare('SELECT username FROM workspace_accounts WHERE workspace_root = ?')
    stmt.bind([key])
    if (stmt.step()) username = stmt.getAsObject().username
    stmt.free()
  } finally {
    db.close()
  }
  return username
}

async function writeWorkspaceAccount(workspaceDir, username) {
  const key = repoRootOf(workspaceDir)
  const table = 'CREATE TABLE IF NOT EXISTS workspace_accounts (workspace_root TEXT PRIMARY KEY NOT NULL, username TEXT NOT NULL, created_at TEXT NOT NULL)'
  const SQL = await getSqlJs()
  const dbPath = getUserDbPath(workspaceDir)
  const db = fs.existsSync(dbPath) ? new SQL.Database(fs.readFileSync(dbPath)) : new SQL.Database()
  db.run(table)
  db.run('INSERT OR REPLACE INTO workspace_accounts (workspace_root, username, created_at) VALUES (?, ?, ?)', [
    key,
    username,
    new Date().toISOString(),
  ])
  fs.writeFileSync(dbPath, Buffer.from(db.export()))
  db.close()
  return username
}

// When the user picks an account, make that account the commit author too — so
// the person who authored the commit and the account that pushed it are the
// same. Runs git config for the workspace (scope: local to that repo).
async function setWorkspaceAuthor(workspaceDir, username) {
  const author = authorForAccount(username)
  execFileSync('git', ['config', 'user.name', author.name], { cwd: workspaceDir })
  execFileSync('git', ['config', 'user.email', author.email], { cwd: workspaceDir })
  return author
}

let accountHandlersReady = false
function setupAccountHandlers() {
  if (accountHandlersReady) return
  accountHandlersReady = true
  // The GitHub accounts saved on this machine (from the `store` credential
  // helper's file) — read directly so the renderer can offer a picker without
  // ever asking git to guess.
  ipcMain.handle('threadline:list-github-accounts', async () => {
    try {
      return listGitHubAccounts()
    } catch (err) {
      console.error('Failed to list GitHub accounts:', err)
      return []
    }
  })
  ipcMain.handle('threadline:get-workspace-account', async (_e, workspaceDir) => {
    try {
      return await readWorkspaceAccount(workspaceDir)
    } catch (err) {
      console.error('Failed to read workspace account:', err)
      return null
    }
  })
  ipcMain.handle('threadline:set-workspace-account', async (_e, workspaceDir, username) => {
    try {
      const author = await setWorkspaceAuthor(workspaceDir, username)
      const saved = await writeWorkspaceAccount(workspaceDir, username)
      return { username: saved, author }
    } catch (err) {
      console.error('Failed to save workspace account:', err)
      return null
    }
  })
  // Which saved accounts can actually reach this workspace's remote. Called
  // before the picker is shown so the user only ever chooses from accounts that
  // will work — no guessing, no failed push to discover it.
  ipcMain.handle('threadline:validate-accounts', async (_e, workspaceDir) => {
    try {
      const status = await describeWorkspace(workspaceDir)
      if (status.state !== 'ready' || !status.remote) return []
      const accounts = listGitHubAccounts()
      const result = []
      for (const a of accounts) {
        const canAccess = await probeAccountAccess(workspaceDir, status.remote, a.username)
        result.push({ username: a.username, canAccess })
      }
      return result
    } catch (err) {
      console.error('Failed to validate accounts:', err)
      return []
    }
  })
}

// sql.js is WASM, not a native addon — picked specifically so this doesn't
// need an electron-rebuild step (better-sqlite3 would need one to match
// Electron's Node ABI).
let sqlJsPromise = null
function getSqlJs() {
  if (!sqlJsPromise) {
    const initSqlJs = require('sql.js')
    sqlJsPromise = initSqlJs({
      locateFile: (file) => path.join(path.dirname(require.resolve('sql.js')), file),
    })
  }
  return sqlJsPromise
}

async function getOrCreateUserEmail(workspaceDir) {
  const email = getGitUserEmail(workspaceDir)
  if (!email) return null

  const SQL = await getSqlJs()
  const dbPath = getUserDbPath(workspaceDir)
  const db = fs.existsSync(dbPath) ? new SQL.Database(fs.readFileSync(dbPath)) : new SQL.Database()
  db.run(
    'CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL)',
  )

  const lookup = db.prepare('SELECT id FROM users WHERE email = ?')
  lookup.bind([email])
  const alreadyRegistered = lookup.step()
  lookup.free()

  if (!alreadyRegistered) {
    const insert = db.prepare('INSERT INTO users (email, created_at) VALUES (?, ?)')
    insert.run([email, new Date().toISOString()])
    insert.free()
    fs.writeFileSync(dbPath, Buffer.from(db.export()))
  }

  db.close()
  return email
}

let userHandlerReady = false
function setupUserHandler() {
  if (userHandlerReady) return
  userHandlerReady = true
  ipcMain.handle('threadline:get-user', async (_e, workspaceDir) => {
    try {
      return await getOrCreateUserEmail(workspaceDir)
    } catch (err) {
      console.error('Failed to resolve current user:', err)
      return null
    }
  })
}

async function createWindow() {
  // Pages loaded in the embedded browser stay light whatever Windows is set
  // to, so switching Threadline to dark re-themes its own chrome — tab strip
  // and address bar — without inverting the site inside it. Safe to force
  // app-wide: Threadline's own theme is driven by a class on <html> and reads
  // no colour preference from the OS, so this reaches only the <webview>.
  nativeTheme.themeSource = 'light'

  setupEmbedSession()
  const url = app.isPackaged ? await startProdServer() : await startVite()

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    webPreferences: {
      webviewTag: true,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  setupWorkspaceHandlers()
  setupUserHandler()
  setupSyncHandlers()
  setupAccountHandlers()

  // Google's "Continue with Google" flow opens its sign-in as a popup, not a
  // same-window navigation. <webview allowpopups> only stops it being blocked;
  // it still needs somewhere to render, so open it as a real BrowserWindow on
  // the same embed partition (so it shares the session that gets signed in).
  mainWindow.webContents.on('did-attach-webview', (_event, webContents) => {
    webContents.setWindowOpenHandler(() => ({
      action: 'allow',
      outlivesOpener: false,
      overrideBrowserWindowOptions: {
        webPreferences: { partition: EMBED_PARTITION },
      },
    }))
  })

  await mainWindow.loadURL(url)
}

async function stopServer() {
  if (viteServer) {
    const server = viteServer
    viteServer = null
    await server.close()
  }
  if (prodServer) {
    const server = prodServer
    prodServer = null
    await new Promise((resolve) => server.close(resolve))
  }
}

app.whenReady().then(createWindow)

app.on('window-all-closed', async () => {
  await stopServer()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  stopServer()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
