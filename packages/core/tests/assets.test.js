// Asset tests — where a pasted image lands, and the guards on deleting one.
//
// The placement half is about a document that lives in a DIFFERENT repository
// from the workspace, which is the case story links routinely produce. The
// deletion half is about refusing: a file outside the managed folder, a file
// that isn't an image, and a file another document still links to.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, stat, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  IMAGE_DIR,
  MAX_IMAGE_BYTES,
  assetFileName,
  deleteImage,
  imageDirFor,
  isManagedImagePath,
  repoRootFor,
  saveImage,
} from '../src/assets.js'

async function withDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'threadline-assets-'))
  try {
    // Realpath: macOS hands back /var/… for a /private/var/… temp dir, and the
    // walk up to a repo root resolves it, so comparisons would differ.
    await fn(await import('node:fs/promises').then((fs) => fs.realpath(dir)))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const PNG = Buffer.from('89504e470d0a1a0a', 'hex')

test('assetFileName is unique per paste, slugged, and keeps the extension', () => {
  const at = new Date('2026-08-27T14:32:10.500Z')
  assert.equal(assetFileName('My Screenshot.PNG', { now: at, token: 'a3f9' }), 'my-screenshot-20260827-143210-a3f9.png')
  // A clipboard image arrives named 'image.png' or not at all; the caller
  // guarantees an extension (saveImage refuses without one), so the fallback
  // that matters is a name with nothing in front of the extension.
  assert.equal(assetFileName('image.png', { now: at, token: 'a3f9' }), 'image-20260827-143210-a3f9.png')
  assert.equal(assetFileName('  .png', { now: at, token: 'a3f9' }), 'image-20260827-143210-a3f9.png')
  // Two pastes of the same image are two files — nothing is content-addressed,
  // because a shared file could not be deleted safely.
  assert.notEqual(
    assetFileName('shot.png', { now: at, token: 'aaaa' }),
    assetFileName('shot.png', { now: at, token: 'bbbb' }),
  )
})

test('isManagedImagePath: only images, only inside .threadline/img', () => {
  assert.equal(isManagedImagePath('/repo/.threadline/img/a.png'), true)
  assert.equal(isManagedImagePath('C:\\repo\\.threadline\\img\\a.png'), true)
  assert.equal(isManagedImagePath('/repo/img/a.png'), false)
  assert.equal(isManagedImagePath('/repo/.threadline/img/a.md'), false)
})

test('images land in the repo that owns the document, not the workspace', async () => {
  await withDir(async (base) => {
    const workspace = path.join(base, 'workspace')
    const other = path.join(base, 'other-repo')
    // Two separate repositories. The workspace is the one the app has open;
    // the document being edited lives in the other one, reached by a link.
    await mkdir(path.join(workspace, '.git'), { recursive: true })
    await mkdir(path.join(other, 'docs', '.git'), { recursive: true })
    await mkdir(path.join(other, '.git'), { recursive: true })
    const doc = path.join(other, 'docs', 'spec.md')
    await writeFile(doc, '# spec\n')

    assert.equal(await repoRootFor(path.dirname(doc), workspace), path.join(other, 'docs'))
    assert.equal(await imageDirFor(doc, workspace), path.join(other, 'docs', ...IMAGE_DIR))

    const written = await saveImage(workspace, { docPath: doc, name: 'shot.png', data: PNG })
    assert.equal(path.dirname(written), path.join(other, 'docs', ...IMAGE_DIR))
    assert.equal((await stat(written)).size, PNG.length)
  })
})

test('a workspace that is not a repo at all falls back to the workspace root', async () => {
  await withDir(async (base) => {
    const doc = path.join(base, 'stories', 'login.s.md')
    await mkdir(path.dirname(doc), { recursive: true })
    await writeFile(doc, '# login\n')
    assert.equal(await imageDirFor(doc, base), path.join(base, ...IMAGE_DIR))
  })
})

test('saveImage refuses a non-image, an empty file and an oversized one', async () => {
  await withDir(async (base) => {
    const doc = path.join(base, 'spec.md')
    await writeFile(doc, '# spec\n')
    await assert.rejects(() => saveImage(base, { docPath: doc, name: 'notes.txt', data: PNG }), /images only/)
    await assert.rejects(() => saveImage(base, { docPath: doc, name: 'a.png', data: Buffer.alloc(0) }), /empty/)
    await assert.rejects(
      () => saveImage(base, { docPath: doc, name: 'a.png', data: Buffer.alloc(MAX_IMAGE_BYTES + 1) }),
      /too large/,
    )
    await assert.rejects(() => saveImage(base, { name: 'a.png', data: PNG }), /docPath/)
  })
})

test('two pastes of the same image are two files', async () => {
  await withDir(async (base) => {
    const doc = path.join(base, 'spec.md')
    await writeFile(doc, '# spec\n')
    const a = await saveImage(base, { docPath: doc, name: 'shot.png', data: PNG })
    const b = await saveImage(base, { docPath: doc, name: 'shot.png', data: PNG })
    assert.notEqual(a, b)
    assert.equal((await readdir(path.join(base, ...IMAGE_DIR))).length, 2)
  })
})

test('deleteImage removes an unreferenced managed image', async () => {
  await withDir(async (base) => {
    const doc = path.join(base, 'spec.md')
    await writeFile(doc, '# spec\n')
    const file = await saveImage(base, { docPath: doc, name: 'shot.png', data: PNG })
    assert.equal(await deleteImage(base, file, { docPath: doc }), true)
    await assert.rejects(() => stat(file))
    // Deleting again is a no-op, not a fault: saving twice asks twice.
    assert.equal(await deleteImage(base, file, { docPath: doc }), false)
  })
})

test('deleteImage refuses a file it does not own', async () => {
  await withDir(async (base) => {
    const outside = path.join(base, 'holiday.png')
    await writeFile(outside, PNG)
    assert.equal(await deleteImage(base, outside, {}), false)
    assert.ok(await stat(outside), 'an image the user merely linked to is left alone')

    const notAnImage = path.join(base, ...IMAGE_DIR, 'notes.md')
    await mkdir(path.dirname(notAnImage), { recursive: true })
    await writeFile(notAnImage, 'hello')
    assert.equal(await deleteImage(base, notAnImage, {}), false)
    assert.ok(await stat(notAnImage))
  })
})

test('deleteImage keeps an image another document still links to', async () => {
  await withDir(async (base) => {
    const doc = path.join(base, 'spec.md')
    await writeFile(doc, '# spec\n')
    const file = await saveImage(base, { docPath: doc, name: 'shot.png', data: PNG })
    const name = path.basename(file)
    // A second document that copied the markdown across. Tidying up after the
    // first must not break the second.
    await writeFile(path.join(base, 'copy.md'), `![](.threadline/img/${name})\n`)

    // False either way: ripgrep finds the other document, and a machine that
    // won't run ripgrep at all treats everything as referenced — the cautious
    // reading, and the same verdict here.
    assert.equal(await deleteImage(base, file, { docPath: doc }), false)
    assert.ok(await stat(file), 'the file the other document shows is still there')
  })
})
