// Tests for src/board/images.js — finding the images a markdown document
// references, and working out which of them nothing points at any more.
//
// This is the logic that decides what gets DELETED off disk, so the cases that
// matter most are the ones where it must decline: a remote image, an image the
// user linked in from somewhere else, an image still referenced by the text.
// Pure strings, no fs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { imageSourcesIn, isManagedImagePath, managedImagesIn, unusedImages, resolveImagePath } from './images.js'

const DIR = 'C:/repo/stories'

test('imageSourcesIn reads both shapes MDXEditor writes', () => {
  const md = [
    '![a shot](../.threadline/img/a.png)',
    '![](../.threadline/img/b.png "with a title")',
    '![spaces](<../.threadline/img/two words.png>)',
    '<img width="200" alt="resized" src="../.threadline/img/c.png" />',
    "<img src='../.threadline/img/d.png'>",
  ].join('\n\n')
  assert.deepEqual(imageSourcesIn(md).sort(), [
    '../.threadline/img/a.png',
    '../.threadline/img/b.png',
    '../.threadline/img/c.png',
    '../.threadline/img/d.png',
    '../.threadline/img/two words.png',
  ])
})

test('imageSourcesIn ignores links, which are not images', () => {
  assert.deepEqual(imageSourcesIn('[a doc](../spec.md) and [another](x.png)'), [])
})

test('imageSourcesIn is reusable — the global regexes do not carry lastIndex over', () => {
  const md = '![](../.threadline/img/a.png)'
  assert.deepEqual(imageSourcesIn(md), imageSourcesIn(md))
})

test('resolveImagePath resolves a relative link against the document folder', () => {
  assert.equal(
    resolveImagePath('../.threadline/img/a.png', DIR),
    'C:/repo/.threadline/img/a.png',
  )
})

test('resolveImagePath returns nothing for a remote image', () => {
  assert.equal(resolveImagePath('https://example.com/a.png', DIR), '')
})

test('isManagedImagePath accepts only images inside .threadline/img', () => {
  assert.equal(isManagedImagePath('C:/repo/.threadline/img/a.png'), true)
  assert.equal(isManagedImagePath('C:/repo/.threadline/img/a.PNG'), true)
  // An image the user linked in from elsewhere — referenced, never owned.
  assert.equal(isManagedImagePath('C:/Users/me/Desktop/a.png'), false)
  // The right folder, but not something /raw would ever serve.
  assert.equal(isManagedImagePath('C:/repo/.threadline/img/notes.md'), false)
  assert.equal(isManagedImagePath(''), false)
})

test('managedImagesIn returns absolute paths, deduplicated, managed only', () => {
  const md = [
    '![](../.threadline/img/a.png)',
    '![again](../.threadline/img/a.png)',
    '![remote](https://example.com/b.png)',
    '![elsewhere](../../Desktop/c.png)',
  ].join('\n\n')
  assert.deepEqual(managedImagesIn(md, DIR), ['C:/repo/.threadline/img/a.png'])
})

test('unusedImages: an image removed from the text is unused', () => {
  const before = '![](../.threadline/img/a.png)\n\n![](../.threadline/img/b.png)'
  const after = '![](../.threadline/img/a.png)'
  assert.deepEqual(unusedImages({ before, after, docDir: DIR }), ['C:/repo/.threadline/img/b.png'])
})

test('unusedImages: an image still in the text is kept', () => {
  const text = '![](../.threadline/img/a.png)'
  assert.deepEqual(unusedImages({ before: text, after: text, docDir: DIR }), [])
})

test('unusedImages: pasted then removed before saving is unused, pasted and kept is not', () => {
  const pasted = ['C:/repo/.threadline/img/new.png', 'C:/repo/.threadline/img/kept.png']
  assert.deepEqual(
    unusedImages({
      before: '',
      after: '![](../.threadline/img/kept.png)',
      pasted,
      docDir: DIR,
    }),
    ['C:/repo/.threadline/img/new.png'],
  )
})

test('unusedImages: a discard leaves everything pasted this session unused', () => {
  const onDisk = '![](../.threadline/img/a.png)'
  assert.deepEqual(
    unusedImages({
      before: onDisk,
      after: onDisk,
      pasted: ['C:/repo/.threadline/img/new.png'],
      docDir: DIR,
    }),
    ['C:/repo/.threadline/img/new.png'],
  )
})

test('unusedImages never offers an image the app does not own', () => {
  const before = '![](../../Desktop/mine.png)\n\n![](https://example.com/b.png)'
  assert.deepEqual(
    unusedImages({ before, after: '', pasted: ['C:/Users/me/Desktop/mine.png'], docDir: DIR }),
    [],
  )
})

test('unusedImages matches paths case-insensitively — a drive letter in either case is one file', () => {
  assert.deepEqual(
    unusedImages({
      before: '',
      after: '![](../.threadline/img/a.png)',
      pasted: ['c:/repo/.threadline/IMG/a.png'.replace('IMG', 'img')],
      docDir: DIR,
    }),
    [],
  )
})
