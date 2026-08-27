// Ripgrep-backed workspace search.
//
// Threadline asks two whole-workspace questions: "which files hold comment
// threads" (the repo-wide comment lists behind All stories and For You) and
// "which files match what the user typed" (the sidebar's search box). Both used
// to be answered by walking every directory in Node and reading every markdown
// file — which on a repository carrying a node_modules directory means ~9,000
// directory reads and ~1,450 file reads to find the ~25 files that are actually
// stories.
//
// ripgrep answers the same questions in under a fifth of a second on that same
// repository, and it honours .gitignore — so node_modules, dist and build
// output are skipped without this module keeping a list of things to ignore.
//
// The binary is bundled (@vscode/ripgrep, the same one VS Code searches with)
// rather than taken from the machine: Windows ships no grep, and an app that
// only works where the user happens to have installed ripgrep isn't shippable.
//
// Nothing here throws for an absent or unrunnable binary — a locked-down
// machine may refuse to execute it. `isAvailable()` reports that, and every
// caller keeps its filesystem-walk fallback for exactly that case.

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

// Flags every search shares.
//
//   --hidden          dot folders hold real content ('.github', '.claude'), and
//                     the tree shows them, so search has to see them too.
//   --glob !.git      the one directory nobody browses: git's own database.
//   --no-require-git  honour .gitignore even when the workspace isn't a git
//                     repo. Without it, a non-repo workspace searches
//                     node_modules and the speed is gone.
//   --no-messages     an unreadable directory is not worth an error stream.
//   --path-separator  rg prints '\' on Windows; ids here are posix paths.
const COMMON_ARGS = ['--hidden', '--glob', '!.git', '--no-require-git', '--no-messages', '--path-separator', '/']

// Guards against a pathological pattern or a runaway directory hanging a
// request. ripgrep finishes the whole of a 663 MB repository in ~200ms, so
// anything near this bound has gone wrong rather than gone slowly.
const TIMEOUT_MS = 20000

// Beyond this, the caller is being asked to render a list nobody reads. rg is
// stopped rather than the output truncated afterwards.
const DEFAULT_MAX = 2000

let cachedPath
let unavailable = false

// The bundled binary's absolute path, or null if the package isn't resolvable.
// Looked up through createRequire because @vscode/ripgrep is CommonJS.
//
// THREADLINE_DISABLE_RIPGREP forces every caller onto its filesystem-walk
// fallback. That path is the one that runs on a machine which won't execute the
// binary, so it needs to be reachable deliberately — both to test it and to
// give a user whose antivirus objects something to set.
function rgPath() {
  if (cachedPath !== undefined) return cachedPath
  if (process.env.THREADLINE_DISABLE_RIPGREP) {
    cachedPath = null
    return cachedPath
  }
  try {
    const require_ = createRequire(import.meta.url)
    cachedPath = require_('@vscode/ripgrep').rgPath || null
  } catch {
    cachedPath = null
  }
  return cachedPath
}

// False once a run has failed to start, so a machine that refuses to execute
// the binary isn't asked again on every keystroke.
export function isAvailable() {
  return !unavailable && !!rgPath()
}

// Run ripgrep and hand back its stdout lines. Resolves to null — never throws —
// when the binary can't run, which is the signal for a caller to fall back.
function run(args, { cwd, maxLines = DEFAULT_MAX }) {
  const bin = rgPath()
  if (!bin || unavailable) return Promise.resolve(null)

  return new Promise((resolve) => {
    let child
    try {
      child = spawn(bin, [...COMMON_ARGS, ...args], { cwd, windowsHide: true })
    } catch {
      unavailable = true
      resolve(null)
      return
    }

    const lines = []
    let buffer = ''
    let done = false

    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      resolve(value)
    }

    const timer = setTimeout(() => finish(lines), TIMEOUT_MS)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      const parts = buffer.split('\n')
      buffer = parts.pop() || ''
      for (const line of parts) {
        if (line) lines.push(line)
        // Enough: stop reading rather than trimming a huge list later.
        if (lines.length >= maxLines) return finish(lines)
      }
    })

    // Exit code 1 means "no matches", which is an answer, not a failure.
    child.on('error', () => {
      unavailable = true
      finish(null)
    })
    child.on('close', () => {
      if (buffer && lines.length < maxLines) lines.push(buffer)
      finish(lines)
    })
  })
}

// rg is given '.' as its search path, so it prints './a/b.md' — or 'a/b.md' on
// some platforms. Ids are workspace-relative posix paths with neither prefix.
function toId(line) {
  return line.replace(/^\.\//, '').replace(/^\//, '')
}

// Every file whose CONTENT matches `pattern`, as workspace-relative ids.
// `globs` narrows by filename (e.g. ['*.md']) so a regex meant for markdown
// isn't run over binaries.
export async function filesMatching(root, pattern, { globs = [], max = DEFAULT_MAX } = {}) {
  const args = ['--files-with-matches', '--regexp', pattern]
  for (const glob of globs) args.push('--glob', glob)
  args.push('.')
  const lines = await run(args, { cwd: root, maxLines: max })
  return lines === null ? null : lines.map(toId)
}

// Every file ripgrep would search, as workspace-relative ids — i.e. the
// workspace minus whatever .gitignore excludes. This is the corpus the
// filename search filters, and it's why that search doesn't offer to open
// something out of node_modules.
export async function allFiles(root, { globs = [], max = DEFAULT_MAX } = {}) {
  const args = ['--files']
  for (const glob of globs) args.push('--glob', glob)
  const lines = await run(args, { cwd: root, maxLines: max })
  return lines === null ? null : lines.map(toId)
}
