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
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)

const GIT_TIMEOUT_MS = 30_000

// The file the `store` credential helper reads and writes. Pulled out so the
// account-lister below can find every saved GitHub username without spawning
// git (which, on a multi-account machine, is exactly the thing that guesses
// wrong). Plain text: "https://<user>:<token>@github.com", one per line.
function credentialStorePath() {
  return path.join(os.homedir(), '.git-credentials')
}

// Every GitHub username saved in the `store` helper's file, deduplicated and
// ordered as written. This is the complete list Threadline can authenticate as
// — deliberately read directly rather than via `git credential fill`, so the
// answer is certain even when the helper chain itself is ambiguous.
function listGitHubAccounts() {
  const file = credentialStorePath()
  let raw = ''
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const users = []
  const seen = new Set()
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^https:\/\/([^:]+):[^@]+@github\.com\/?$/)
    if (!m) continue
    const username = decodeURIComponent(m[1])
    if (seen.has(username)) continue
    seen.add(username)
    users.push({ username })
  }
  return users
}

// Which username the remote URL already names, if any — e.g.
// "https://brianivander@github.com/..." -> "brianivander". Null when the URL
// is bare ("https://github.com/...").
function remoteUserFromUrl(url) {
  const m = String(url || '').match(/^https:\/\/([^@/]+)@github\.com\//)
  return m ? decodeURIComponent(m[1]) : null
}

// Can this saved account see the repo at `remote`? Runs `git ls-remote` forced
// onto that exact account (store helper + credential.username), so a
// multi-account machine can't let git guess a different one. A zero exit means
// the account can reach the repo; GitHub reports inaccessible repos as
// "Repository not found", which surfaces here as `false`.
//
// The remote is probed WITHOUT any username baked into its URL: a URL like
// "https://briangruntable@github.com/..." would make git ALWAYS authenticate
// as briangruntable regardless of credential.username, so every account would
// wrongly report access. Stripping the username lets each account be tested
// honestly.
//
// Note: this proves *access* (the account can read/fetch), which is what
// filters out the "wrong account" case. A collaborator who can read but not
// push is a rarer, separate case — the push itself will still say so.
function bareRemoteUrl(remote) {
  return String(remote || '').replace(/^https:\/\/[^@/]+@github\.com\//, 'https://github.com/')
}

async function probeAccountAccess(root, remote, username) {
  try {
    await execFileAsync(
      'git',
      ['-c', 'credential.helper=store', '-c', `credential.username=${username}`, ...CREDENTIAL_ARGS, 'ls-remote', '--heads', bareRemoteUrl(remote)],
      { cwd: root, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, env: gitEnv() },
    )
    return true
  } catch {
    return false
  }
}

// The commit-author parts git wants for a given GitHub account. We write the
// username as the name and GitHub's noreply address as the email — that pairing
// is exactly what makes GitHub attribute a commit to this account, with no API
// call and no guess about which of the account's real emails is intended.
function authorForAccount(username) {
  return {
    name: username,
    email: `${username}@users.noreply.github.com`,
  }
}

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

async function git(cwd, args, { pushUser } = {}) {
  // When an account is chosen, force the `store` helper (which can answer from
  // disk, matching the exact username) and name the account — so a
  // multi-account machine can't have git guess the wrong token.
  const pre =
    pushUser == null ? CREDENTIAL_ARGS : ['-c', 'credential.helper=store', '-c', `credential.username=${pushUser}`]
  const { stdout } = await execFileAsync('git', [...pre, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    env: gitEnv(),
  })
  return stdout.trim()
}

// Same call, but a non-zero exit is an answer rather than an error — used for
// the probes where "this failed" is the information we're after.
async function gitOk(cwd, args, opts) {
  try {
    return await git(cwd, args, opts)
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

  const remote = await gitOk(root, ['config', '--get', 'remote.origin.url'])

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
    remote: remote || null,
    remoteUser: remoteUserFromUrl(remote),
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
  // "Repository not found" from GitHub is almost never a missing repo — it is
  // GitHub hiding "this account has no access to this (private/org) repo". The
  // fix is choosing a different account, not chasing a URL.
  if (/repository.*not found/i.test(text)) return 'wrong-account'
  if (/timed out|ETIMEDOUT/i.test(text)) return 'timeout'
  return 'push-failed'
}

// Sync in three tiers, escalating only when the gentler step fails:
//   1. pull --ff-only — fast-forward when we're simply behind; no history is
//      rewritten and no commits are added.
//   2. pull --rebase — the branches diverged, so replay our local commits on
//      top of the remote's instead of refusing. Safe: when a genuine conflict
//      exists (same lines changed), rebase stops cleanly and reports it, it
//      never guesses.
//   3. Stop and report — a real conflict or a dirty tree is handed back to the
//      user (resolve in GitHub Desktop), never silently merged away.
//
// `pushUser` (optional) names the GitHub account to authenticate the push as.
// When set, the push uses the `store` helper keyed on that exact username, so
// a machine with several saved accounts pushes with the one the user chose
// rather than whichever git happens to find first.
async function syncWorkspace(root, { pushUser } = {}) {
  const status = await describeWorkspace(root)
  if (status.state !== 'ready') return { ok: false, reason: status.state, status }

  try {
    await git(root, ['pull', '--ff-only'])
  } catch (err) {
    // First pull failed. Try rebase, which handles the diverged case — unless
    // the failure was a dirty tree (uncommitted changes), which rebase also
    // can't help and would only make worse.
    const text = `${err.stderr || err.message || ''}`
    if (/would be overwritten|local changes/i.test(text)) {
      return { ok: false, reason: 'dirty-conflict', detail: text.trim(), status: await describeWorkspace(root) }
    }
    try {
      await git(root, ['pull', '--rebase'])
    } catch (rebaseErr) {
      const rebaseText = `${rebaseErr.stderr || rebaseErr.message || ''}`
      // A rebase conflict stops mid-way; abort so the working tree isn't left
      // half-rebased for the next attempt to trip over.
      await gitOk(root, ['rebase', '--abort'])
      if (/CONFLICT|conflict|would be overwritten/i.test(rebaseText)) {
        return { ok: false, reason: 'diverged', detail: rebaseText.trim(), status: await describeWorkspace(root) }
      }
      return { ok: false, reason: classifyFailure(rebaseText, rebaseErr), detail: rebaseText.trim(), status: await describeWorkspace(root) }
    }
  }

  try {
    await git(root, ['add', '-A'])
    const staged = await gitOk(root, ['diff', '--cached', '--name-only'])
    const files = staged ? staged.split('\n').filter(Boolean) : []
    if (files.length) await git(root, ['commit', '-m', buildCommitMessage(files)])

    // Nothing new locally and nothing already waiting — the pull was the whole
    // sync, so skip the push rather than reporting a no-op as work done.
    const pending = await describeWorkspace(root)
    if (pending.ahead > 0) await git(root, ['push'], { pushUser })

    return { ok: true, committed: files.length, pushed: pending.ahead, status: await describeWorkspace(root) }
  } catch (err) {
    const text = `${err.stderr || err.message || ''}`
    // Loud, right here, every failure: git's own words in the process console,
    // so a sync that didn't work is never left to a tooltip to explain.
    console.error('[threadline sync]', text.trim() || err)
    return {
      ok: false,
      reason: classifyFailure(text, err),
      detail: text.trim(),
      status: await describeWorkspace(root),
    }
  }
}

module.exports = {
  describeWorkspace,
  syncWorkspace,
  buildCommitMessage,
  classifyFailure,
  listGitHubAccounts,
  remoteUserFromUrl,
  bareRemoteUrl,
  probeAccountAccess,
  authorForAccount,
}
