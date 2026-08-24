// Exercises git-sync.cjs against throwaway repos created under os.tmpdir() —
// a bare repo standing in for the remote and one or two clones of it, so push
// and pull are real operations and never touch a repo anyone cares about.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const { describeWorkspace, syncWorkspace, buildCommitMessage, classifyFailure, listGitHubAccounts, remoteUserFromUrl } = require('./git-sync.cjs')

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

// A remote plus `clones` working copies of it, each with an identity set and
// tracking master, so describeWorkspace() reports 'ready' for them.
function makeRepos(clones = 1) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadline-sync-'))
  const remote = path.join(dir, 'remote.git')
  fs.mkdirSync(remote)
  git(dir, ['init', '--bare', '-q', remote])

  const made = []
  for (let i = 0; i < clones; i++) {
    const work = path.join(dir, `work${i}`)
    git(dir, ['clone', '-q', remote, work])
    git(work, ['config', 'user.email', `dev${i}@nanovest.io`])
    git(work, ['config', 'user.name', `Dev ${i}`])
    if (i === 0) {
      fs.writeFileSync(path.join(work, 'story1.md'), 'first\n')
      git(work, ['add', '-A'])
      git(work, ['commit', '-qm', 'init'])
      git(work, ['push', '-q', '-u', 'origin', 'HEAD:refs/heads/master'])
    } else {
      git(work, ['fetch', '-q'])
      git(work, ['checkout', '-q', '-B', 'master', '--track', 'origin/master'])
    }
    made.push(work)
  }
  return { dir, remote, clones: made }
}

test('buildCommitMessage names files, and abbreviates past three', () => {
  assert.equal(buildCommitMessage(['a/story1.md']), 'sync: story1.md')
  assert.equal(buildCommitMessage(['a/s1.md', 'b/s2.md', 's3.md']), 'sync: s1.md, s2.md, s3.md')
  assert.equal(
    buildCommitMessage(['s1.md', 's2.md', 's3.md', 's4.md', 's5.md']),
    'sync: s1.md, s2.md, s3.md, +2 more',
  )
})

test('classifyFailure separates auth and timeout from generic failure', () => {
  assert.equal(classifyFailure('fatal: could not read Username for https://github.com'), 'auth-failed')
  assert.equal(classifyFailure('terminal prompts disabled'), 'auth-failed')
  assert.equal(classifyFailure('Connection timed out'), 'timeout')
  assert.equal(classifyFailure('some other explosion'), 'push-failed')
})

// A command killed by the timeout says nothing about time anywhere in its
// output — it reports a signal. Classifying on text alone showed every hung
// push as a generic failure, which sent a real diagnosis down the wrong path.
test('classifyFailure recognises a timeout kill by signal, not wording', () => {
  const killed = { killed: true, signal: 'SIGTERM', message: 'Command failed: git push' }
  assert.equal(classifyFailure(`${killed.message}`, killed), 'timeout')
  assert.equal(classifyFailure('', { signal: 'SIGTERM' }), 'timeout')
  // A genuine non-zero exit is still classified on its text.
  assert.equal(classifyFailure('Authentication failed', { code: 128 }), 'auth-failed')
})

test("classifyFailure treats 'Repository not found' as wrong-account, not a missing repo", () => {
  const githubHide =
    'fatal: Cannot prompt because user interactivity has been disabled.\nremote: Repository not found.\nfatal: repository https://github.com/org/repo.git/ not found'
  assert.equal(classifyFailure(githubHide), 'wrong-account')
})

test('remoteUserFromUrl extracts the username from a username-in-url remote', () => {
  assert.equal(remoteUserFromUrl('https://briangruntable@github.com/gruntable/books.git'), 'briangruntable')
  assert.equal(remoteUserFromUrl('https://github.com/gruntable/books.git'), null)
  assert.equal(remoteUserFromUrl(null), null)
})

test('describeWorkspace reports each unmet prerequisite', async () => {
  assert.equal((await describeWorkspace(null)).state, 'no-workspace')
  assert.equal((await describeWorkspace('/definitely/not/a/real/path')).state, 'no-workspace')

  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'threadline-plain-'))
  assert.equal((await describeWorkspace(plain)).state, 'not-a-repo')

  // A repo with no identity configured. core.askPass/credential settings are
  // irrelevant here; only user.email and user.name are being probed.
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'threadline-noident-'))
  git(bare, ['init', '-q'])
  git(bare, ['config', '--local', 'user.email', ''])
  git(bare, ['config', '--local', 'user.name', ''])
  const noIdent = await describeWorkspace(bare)
  // Falls back to the machine's global identity when the local one is blank,
  // so accept either: what matters is it never claims 'ready' with no remote.
  assert.ok(['no-identity', 'no-remote'].includes(noIdent.state), `got ${noIdent.state}`)
})

test('describeWorkspace reports ready, and counts unpushed commits', async () => {
  const { clones } = makeRepos(1)
  const work = clones[0]

  const clean = await describeWorkspace(work)
  assert.equal(clean.state, 'ready')
  assert.equal(clean.ahead, 0)
  assert.equal(clean.behind, 0)
  assert.equal(clean.dirty, 0)

  fs.writeFileSync(path.join(work, 'story2.md'), 'draft\n')
  assert.equal((await describeWorkspace(work)).dirty, 1)

  git(work, ['add', '-A'])
  git(work, ['commit', '-qm', 'local work'])
  assert.equal((await describeWorkspace(work)).ahead, 1)
})

test('syncWorkspace commits everything and pushes it', async () => {
  const { clones } = makeRepos(1)
  const work = clones[0]

  fs.writeFileSync(path.join(work, 'story2.md'), 'b\n')
  fs.writeFileSync(path.join(work, 'story3.md'), 'c\n')

  const result = await syncWorkspace(work)
  assert.equal(result.ok, true, `sync failed: ${result.reason} ${result.detail || ''}`)
  assert.equal(result.committed, 2)
  assert.match(git(work, ['log', '-1', '--format=%s']), /^sync: story2\.md, story3\.md$/)

  // The push actually landed: nothing left ahead, and the remote has it.
  assert.equal(result.status.ahead, 0)
  assert.equal((await describeWorkspace(work)).ahead, 0)
})

test('syncWorkspace pulls a teammate’s work down', async () => {
  const { clones } = makeRepos(2)
  const [mine, theirs] = clones

  fs.writeFileSync(path.join(theirs, 'their-story.md'), 'theirs\n')
  git(theirs, ['add', '-A'])
  git(theirs, ['commit', '-qm', 'their work'])
  git(theirs, ['push', '-q'])

  const result = await syncWorkspace(mine)
  assert.equal(result.ok, true, `sync failed: ${result.reason} ${result.detail || ''}`)
  assert.equal(result.committed, 0, 'nothing of mine to commit')
  assert.ok(fs.existsSync(path.join(mine, 'their-story.md')), 'their file should have arrived')
})

// The guarantee that actually matters for the footer: an unreachable or
// unauthenticated remote must surface an error quickly, never leave the button
// spinning until the 30s timeout. A credential helper that stalls instead of
// declining is what made this necessary.
test('syncWorkspace fails fast on an unreachable remote rather than hanging', async () => {
  const { clones } = makeRepos(1)
  const work = clones[0]
  // Port 1 is never listening, so this is a connection failure with no DNS or
  // network round-trip to wait on.
  git(work, ['remote', 'set-url', 'origin', 'https://someone@127.0.0.1:1/nope.git'])
  fs.writeFileSync(path.join(work, 'story9.md'), 'x\n')

  const started = Date.now()
  const result = await syncWorkspace(work)
  const elapsed = Date.now() - started

  assert.equal(result.ok, false)
  assert.ok(elapsed < 20_000, `took ${elapsed}ms — should fail fast, not stall to the timeout`)
  assert.ok(result.detail, 'the failure must carry git’s own output for diagnosis')
})

test('syncWorkspace resolves diverged history by rebasing', async () => {
  const { clones } = makeRepos(2)
  const [mine, theirs] = clones

  // They commit and push; I commit something different on top of the old tip.
  fs.writeFileSync(path.join(theirs, 'theirs.md'), 'theirs\n')
  git(theirs, ['add', '-A'])
  git(theirs, ['commit', '-qm', 'theirs'])
  git(theirs, ['push', '-q'])

  fs.writeFileSync(path.join(mine, 'mine.md'), 'mine\n')
  git(mine, ['add', '-A'])
  git(mine, ['commit', '-qm', 'mine'])

  const result = await syncWorkspace(mine)
  assert.equal(result.ok, true, `sync failed: ${result.reason} ${result.detail || ''}`)
  // The two histories are now one line: my commit rebased on top of theirs.
  assert.ok(fs.existsSync(path.join(mine, 'theirs.md')), 'their file should have arrived')
  assert.ok(fs.existsSync(path.join(mine, 'mine.md')), 'my file should still be there')
})

test('syncWorkspace stops on a genuine conflict rather than guessing', async () => {
  const { clones } = makeRepos(2)
  const [mine, theirs] = clones

  // Both edit the SAME file's SAME line differently — a genuine conflict that
  // rebase cannot resolve without a human deciding.
  fs.writeFileSync(path.join(theirs, 'shared.md'), 'theirs version\n')
  git(theirs, ['add', '-A'])
  git(theirs, ['commit', '-qm', 'theirs'])
  git(theirs, ['push', '-q'])

  fs.writeFileSync(path.join(mine, 'shared.md'), 'mine version\n')
  git(mine, ['add', '-A'])
  git(mine, ['commit', '-qm', 'mine'])

  const result = await syncWorkspace(mine)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'diverged')
  // It aborted the doomed rebase and left my commit intact.
  assert.equal(git(mine, ['log', '-1', '--format=%s']), 'mine')
})
