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
