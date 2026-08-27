// Tests for src/lib/paths.js — the story-link filesystem-path conversion.
// Pure string functions, no fs, so these run anywhere without a workspace.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  hasUrlScheme,
  isAbsolutePath,
  storyDirOf,
  relativePath,
  toRelativePath,
  resolveLocalLink,
  isLocalMarkdownUrl,
  isStoryPath,
  titleOf,
  fromFileUrl,
  workspacePathOf,
  workspaceIdOf,
} from './paths.js'

test('hasUrlScheme recognises web and file URLs but not bare paths', () => {
  assert.equal(hasUrlScheme('https://figma.com/x'), true)
  assert.equal(hasUrlScheme('file:///C:/a/b.html'), true)
  assert.equal(hasUrlScheme('mailto:a@b.c'), true)
  assert.equal(hasUrlScheme('C:/a/b.html'), false)
  assert.equal(hasUrlScheme('../designs.png'), false)
  assert.equal(hasUrlScheme(''), false)
})

test('isAbsolutePath detects Windows, POSIX and UNC absolute paths', () => {
  assert.equal(isAbsolutePath('C:\\Users\\brian\\a.html'), true)
  assert.equal(isAbsolutePath('C:/Users/brian/a.html'), true)
  assert.equal(isAbsolutePath('/Users/brian/a.html'), true)
  assert.equal(isAbsolutePath('\\\\server\\share\\a.html'), true)
  assert.equal(isAbsolutePath('../designs.png'), false)
  assert.equal(isAbsolutePath('designs.png'), false)
  assert.equal(isAbsolutePath('https://x/y'), false)
})

test('storyDirOf returns the folder a story lives in', () => {
  assert.equal(storyDirOf('C:/repo', 'folder/sub/story.md'), 'C:/repo/folder/sub')
  assert.equal(storyDirOf('C:\\repo', 'folder\\sub\\story.md'), 'C:/repo/folder/sub')
  assert.equal(storyDirOf('C:/repo', 'story.md'), 'C:/repo')
  assert.equal(storyDirOf('', 'story.md'), '')
  assert.equal(storyDirOf('C:/repo', ''), '')
})

test('relativePath walks up from fromDir to target', () => {
  assert.equal(relativePath('C:/repo/folder/sub', 'C:/repo/designs'), '../../designs')
  assert.equal(relativePath('C:/repo/folder/sub', 'C:/repo/folder/sub/mock.html'), 'mock.html')
  assert.equal(relativePath('C:/a/b', 'C:/a/b/c'), 'c')
  assert.equal(relativePath('C:/a/b', 'C:/a'), '..')
  assert.equal(relativePath('C:/a/b', 'C:/a/b'), '.')
})

test('toRelativePath converts an absolute path to a portable relative one', () => {
  // Windows backslashes pasted on Windows.
  assert.equal(
    toRelativePath('C:\\repo\\designs\\mock.html', 'C:/repo/folder/sub'),
    '../../designs/mock.html',
  )
  // POSIX paths.
  assert.equal(toRelativePath('/repo/designs/mock.html', '/repo/folder/sub'), '../../designs/mock.html')
  // A file:// URL a peer pasted.
  assert.equal(toRelativePath('file:///C:/repo/designs/mock.html', 'C:/repo/folder/sub'), '../../designs/mock.html')
})

test('toRelativePath leaves web URLs and relative paths untouched', () => {
  assert.equal(toRelativePath('https://figma.com/x', 'C:/repo/folder'), 'https://figma.com/x')
  assert.equal(toRelativePath('../designs.png', 'C:/repo/folder'), '../designs.png')
})

test('resolveLocalLink opens a relative path as a file:// URL against the story dir', () => {
  assert.equal(resolveLocalLink('../designs/mock.html', 'C:/repo/folder/sub'), 'file:///C:/repo/folder/designs/mock.html')
  // No leading ../ — a file beside the story.
  assert.equal(resolveLocalLink('mock.html', 'C:/repo/folder/sub'), 'file:///C:/repo/folder/sub/mock.html')
})

test('resolveLocalLink passes web URLs through and opens absolute paths as file://', () => {
  assert.equal(resolveLocalLink('https://figma.com/x', 'C:/repo'), 'https://figma.com/x')
  assert.equal(resolveLocalLink('C:\\repo\\a.html', ''), 'file:///C:/repo/a.html')
  assert.equal(resolveLocalLink('/repo/a.html', ''), 'file:///repo/a.html')
})

test('a round trip: paste absolute, store relative, reopen as file://', () => {
  const storyDir = 'C:/Users/brian/threadline/projects'
  const pasted = 'C:\\Users\\brian\\threadline\\designs\\mock.html'
  const stored = toRelativePath(pasted, storyDir)
  assert.equal(stored, '../designs/mock.html')
  assert.equal(resolveLocalLink(stored, storyDir), 'file:///C:/Users/brian/threadline/designs/mock.html')
})

test('isLocalMarkdownUrl matches local .md files only, never a web URL', () => {
  assert.equal(isLocalMarkdownUrl('file:///C:/repo/spec.md'), true)
  assert.equal(isLocalMarkdownUrl('file:///Users/b/notes.markdown'), true)
  assert.equal(isLocalMarkdownUrl('file:///C:/repo/mock.html'), false)
  // A server decides what it serves at a .md path — that stays a web page.
  assert.equal(isLocalMarkdownUrl('https://example.com/README.md'), false)
  assert.equal(isLocalMarkdownUrl(''), false)
})

test('isStoryPath matches the story extension, in any of the forms a path arrives in', () => {
  assert.equal(isStoryPath('folder/login.s.md'), true)
  assert.equal(isStoryPath('C:\\repo\\Login.S.MD'), true)
  assert.equal(isStoryPath('file:///C:/repo/login.s.md?v=2'), true)
  assert.equal(isStoryPath('folder/prd.md'), false)
  assert.equal(isStoryPath('folder/notes.s.markdown'), false)
  assert.equal(isStoryPath(''), false)
})

test('titleOf takes the whole extension off, including the compound story one', () => {
  assert.equal(titleOf('C:/repo/User can log in.s.md'), 'User can log in')
  assert.equal(titleOf('C:\\repo\\PRD.md'), 'PRD')
  assert.equal(titleOf('C:/repo/spec v1.2.md'), 'spec v1.2')
  assert.equal(titleOf('C:/repo/Dockerfile'), 'Dockerfile')
  // A dotfile's leading dot is a name, not an extension. A bare '.s.md' has no
  // title in front of the story extension, so it isn't one — it falls back to
  // the ordinary rule (the same answer the repo gives it).
  assert.equal(titleOf('C:/repo/.gitignore'), '.gitignore')
  assert.equal(titleOf('C:/repo/.s.md'), '.s')
  assert.equal(titleOf(''), '')
})

test('fromFileUrl reverses toFileUrl, decoding escapes', () => {
  assert.equal(fromFileUrl('file:///C:/repo/spec.md'), 'C:/repo/spec.md')
  assert.equal(fromFileUrl('file:///repo/spec.md'), '/repo/spec.md')
  assert.equal(fromFileUrl('file:///C:/01%20Passion/spec.md'), 'C:/01 Passion/spec.md')
  // A literal '%' in a filename isn't an escape sequence; keep it verbatim.
  assert.equal(fromFileUrl('file:///C:/a%/b.md'), 'C:/a%/b.md')
  assert.equal(fromFileUrl('https://example.com/x.md'), '')
})

test('a markdown link survives the whole round trip into a doc tab', () => {
  const storyDir = 'C:/Users/brian/01 Passion/projects'
  const stored = toRelativePath('C:\\Users\\brian\\01 Passion\\docs\\prd.md', storyDir)
  assert.equal(stored, '../docs/prd.md')
  const url = resolveLocalLink(stored, storyDir)
  assert.equal(isLocalMarkdownUrl(url), true)
  assert.equal(fromFileUrl(url), 'C:/Users/brian/01 Passion/docs/prd.md')
})


test('workspacePathOf joins a workspace root and a relative id', () => {
  assert.equal(workspacePathOf('C:/repo', 'folder/sub/spec.md'), 'C:/repo/folder/sub/spec.md')
  assert.equal(workspacePathOf('C:\\repo\\', 'folder\\spec.md'), 'C:/repo/folder/spec.md')
  assert.equal(workspacePathOf('/repo', 'spec.md'), '/repo/spec.md')
  assert.equal(workspacePathOf('', 'spec.md'), '')
  assert.equal(workspacePathOf('C:/repo', ''), '')
})

test('workspaceIdOf recovers the id, and reports nothing for a path outside the workspace', () => {
  assert.equal(workspaceIdOf('C:/repo', 'C:/repo/folder/spec.md'), 'folder/spec.md')
  assert.equal(workspaceIdOf('C:/repo/', 'C:\\repo\\spec.md'), 'spec.md')
  // A story link can resolve into a different repo entirely — no row to point at.
  assert.equal(workspaceIdOf('C:/repo', 'C:/other/spec.md'), '')
  // A sibling whose name merely starts the same way is not inside it.
  assert.equal(workspaceIdOf('C:/repo', 'C:/repo-archive/spec.md'), '')
  // The root itself is not a file in the tree.
  assert.equal(workspaceIdOf('C:/repo', 'C:/repo'), '')
  // A directory dialog and a hand-typed link disagree on drive-letter case.
  assert.equal(workspaceIdOf('C:/repo', 'c:/repo/spec.md'), 'spec.md')
})

test('workspacePathOf and workspaceIdOf round-trip', () => {
  const id = 'folder/sub/A spec.md'
  assert.equal(workspaceIdOf('C:/repo', workspacePathOf('C:/repo', id)), id)
})
