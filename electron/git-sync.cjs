// Workspace sync: the git half of the sidebar footer's Sync button.
//
// Deliberately free of any `electron` import so it can be required and tested
// under plain `node --test` — main.cjs wraps these two functions in IPC
// handlers and does nothing else.
//
// git runs as a child process here with no shell and no TTY — see
// CREDENTIAL_ARGS and gitEnv() below for why that shapes every call, and
// GIT_TIMEOUT_MS as the backstop when something stalls anyway.
//
// execFile, never execFileSync: a network round-trip on Electron's main
// process would freeze the window.

const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)

const GIT_TIMEOUT_MS = 30_000

// Credentials must resolve without anyone being asked, or not at all.
//
// A machine typically has several credential helpers configured, tried in
// order — on Windows commonly a GUI one (`manager`) ahead of a stored-file one
// (`store`). Spawned from Electron's main process, the GUI helper does not
// return: no output, no error, just a stall until the timeout below kills it,
// and the helper that *would* have worked never gets its turn.
//
// credential.interactive=false makes any such helper decline immediately
// instead of stalling, so git falls through to one that can answer from disk.
// Combined with GIT_TERMINAL_PROMPT=0 (which stops the same stall on a text
// prompt against a TTY that isn't there), the outcome is always one of: an
// already-saved credential works, or sync fails in seconds with 'auth-failed'.
// Never a hang.
//
// The cost is that Threadline can't perform a first-time sign-in — deliberate:
// signing in is GitHub Desktop's job, and this app only reports when it needs
// doing.
const CREDENTIAL_ARGS = ['-c', 'credential.interactive=false']

function gitEnv() {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0' }
}

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', [...CREDENTIAL_ARGS, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    env: gitEnv(),
  })
  return stdout.trim()
}

// Same call, but a non-zero exit is an answer rather than an error — used for
// the probes where "this failed" is the information we're after.
async function gitOk(cwd, args) {
  try {
    return await git(cwd, args)
  } catch {
    return null
  }
}

// Why sync can't run, in the order the user has to fix things: no point
// reporting a missing upstream when git itself isn't installed. Every reason
// here is resolved outside this app, so each one names what to go and do.
async function describeWorkspace(root) {
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { state: 'no-workspace' }
  }
  if ((await gitOk(root, ['--version'])) === null) return { state: 'no-git' }
  if ((await gitOk(root, ['rev-parse', '--git-dir'])) === null) return { state: 'not-a-repo' }

  const email = await gitOk(root, ['config', 'user.email'])
  const name = await gitOk(root, ['config', 'user.name'])
  if (!email || !name) return { state: 'no-identity' }

  if (!(await gitOk(root, ['remote']))) return { state: 'no-remote' }

  const upstream = await gitOk(root, ['rev-parse', '--abbrev-ref', '@{u}'])
  if (!upstream) return { state: 'no-upstream' }

  const branch = await gitOk(root, ['branch', '--show-current'])
  const counts = await gitOk(root, ['rev-list', '--left-right', '--count', '@{u}...HEAD'])
  const [behind, ahead] = (counts || '0\t0').split(/\s+/).map((n) => Number(n) || 0)
  const dirty = (await gitOk(root, ['status', '--porcelain'])) || ''

  return {
    state: 'ready',
    branch,
    upstream,
    ahead,
    behind,
    dirty: dirty ? dirty.split('\n').filter(Boolean).length : 0,
  }
}

// Mechanical, deliberately — no AI call. Names the files actually staged,
// which is the part anyone reading an auto-sync commit wants to know.
function buildCommitMessage(files) {
  const names = files.map((f) => path.basename(f))
  if (names.length <= 3) return `sync: ${names.join(', ')}`
  return `sync: ${names.slice(0, 3).join(', ')}, +${names.length - 3} more`
}

// `err` matters as much as its text: a command killed by the timeout above
// exits on a signal and never says "timed out" anywhere, so matching on words
// alone reported every hung push as a generic failure.
function classifyFailure(text, err) {
  if (err && (err.killed || err.signal)) return 'timeout'
  if (/could not read Username|Authentication failed|terminal prompts disabled|denied/i.test(text)) {
    return 'auth-failed'
  }
  if (/timed out|ETIMEDOUT/i.test(text)) return 'timeout'
  return 'push-failed'
}

// pull --ff-only, never a plain pull: a background button that silently
// authors merge commits produces history nobody can account for. If the
// branches have genuinely diverged this stops and says so.
async function syncWorkspace(root) {
  const status = await describeWorkspace(root)
  if (status.state !== 'ready') return { ok: false, reason: status.state, status }

  try {
    await git(root, ['pull', '--ff-only'])
  } catch (err) {
    const text = `${err.stderr || err.message || ''}`
    const reason = /would be overwritten|local changes/i.test(text) ? 'dirty-conflict' : 'diverged'
    return { ok: false, reason, detail: text.trim(), status: await describeWorkspace(root) }
  }

  try {
    await git(root, ['add', '-A'])
    const staged = await gitOk(root, ['diff', '--cached', '--name-only'])
    const files = staged ? staged.split('\n').filter(Boolean) : []
    if (files.length) await git(root, ['commit', '-m', buildCommitMessage(files)])

    // Nothing new locally and nothing already waiting — the pull was the whole
    // sync, so skip the push rather than reporting a no-op as work done.
    const pending = await describeWorkspace(root)
    if (pending.ahead > 0) await git(root, ['push'])

    return { ok: true, committed: files.length, pushed: pending.ahead, status: await describeWorkspace(root) }
  } catch (err) {
    const text = `${err.stderr || err.message || ''}`
    return {
      ok: false,
      reason: classifyFailure(text, err),
      detail: text.trim(),
      status: await describeWorkspace(root),
    }
  }
}

module.exports = { describeWorkspace, syncWorkspace, buildCommitMessage, classifyFailure }
