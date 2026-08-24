// Repo tests — CRUD over a generic, arbitrary-depth folder/file tree, case
// handling within a file, tree building, moving nodes, and duplication.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CRITICALITIES } from '../src/index.js'
import {
  listFolders, getFolder, createFolder, updateFolder, deleteFolder,
  listFiles, getFile, createFile, updateFile, deleteFile,
  listCases, getCase, createCase, updateCase, deleteCase,
  buildTree, moveNode, duplicateNode, reorderCases,
} from '../src/repo.js'

async function withWorkspace(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'threadline-repo-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('CRITICALITIES are P1..P4', () => {
  assert.deepEqual(CRITICALITIES, ['P1', 'P2', 'P3', 'P4'])
})

test('folders: dirs are ids, name text is preserved exactly, alphabetical listing, rename, delete', async () => {
  await withWorkspace(async (root) => {
    const p1 = await createFolder(root, { name: 'My App' })
    const p2 = await createFolder(root, { name: 'Another' })
    assert.equal(p1.id, 'My App', 'the directory name preserves case and spaces, not a slug')
    assert.equal(p2.id, 'Another')

    const unnamed = await createFolder(root, {})
    assert.equal(unnamed.name, 'Untitled folder')

    assert.deepEqual((await listFolders(root, null)).map((f) => f.id), ['Another', 'My App', 'Untitled folder'])

    const renamed = await updateFolder(root, p1.id, { name: 'Renamed App' })
    assert.equal(renamed.id, 'Renamed App')
    assert.equal(await getFolder(root, p1.id), null, 'old id no longer resolves')
    assert.equal(await updateFolder(root, 'nope', { name: 'x' }), null, 'update of a missing folder returns null')

    await deleteFolder(root, p2.id)
    assert.equal(await getFolder(root, p2.id), null)
    assert.equal((await listFolders(root, null)).length, 2)
  })
})

test('folders: nest to arbitrary depth, collision-safe names', async () => {
  await withWorkspace(async (root) => {
    const a = await createFolder(root, { name: 'App' })
    const b = await createFolder(root, { parent_id: a.id, name: 'Auth' })
    const c = await createFolder(root, { parent_id: b.id, name: 'Login' })
    const d = await createFolder(root, { parent_id: c.id, name: 'Deep' })
    assert.equal(d.id, 'App/Auth/Login/Deep', 'four levels deep, id is the full posix path')

    const dup = await createFolder(root, { parent_id: b.id, name: 'Login' }) // duplicate name
    assert.equal(dup.id, 'App/Auth/Login (2)', 'duplicate folder name gets a collision-safe suffix')

    assert.deepEqual((await listFolders(root, b.id)).map((f) => f.id), ['App/Auth/Login', 'App/Auth/Login (2)'])
    assert.equal((await listFolders(root, 'nope')).length, 0, 'unknown parent has no folders')
  })
})

test('files: filename follows title exactly, frontmatter round-trips, rename moves the file', async () => {
  await withWorkspace(async (root) => {
    const a = await createFolder(root, { name: 'App' })
    const b = await createFolder(root, { parent_id: a.id, name: 'Auth' })

    const s1 = await createFile(root, { parent_id: b.id, title: 'User can log in' })
    assert.equal(s1.id, 'App/Auth/User can log in.md', 'the filename preserves the exact title text')
    assert.equal(s1.title, 'User can log in')
    assert.equal(s1.criticality, 'P1', 'default criticality P1')
    assert.deepEqual(s1.links, [], 'default links empty')

    const withLinks = await updateFile(root, s1.id, {
      links: [
        { url: 'https://figma.com/proto/x', tag: 'Design', color: 'purple' },
        { url: 'https://docs.google.com/y' },
      ],
      criticality: 'P2',
    })
    assert.deepEqual(withLinks.links, [
      { url: 'https://figma.com/proto/x', tag: 'Design', color: 'purple' },
      { url: 'https://docs.google.com/y', tag: '', color: '' },
    ])
    assert.equal(withLinks.criticality, 'P2')

    // An unrelated update must not clear links (mirrors the old "updateStory
    // rewrites every column from the merged row" guarantee).
    const afterTitleEdit = await updateFile(root, withLinks.id, { title: 'User can log in (v2)' })
    assert.equal(afterTitleEdit.id, 'App/Auth/User can log in (v2).md', 'renaming the title renames the file')
    assert.deepEqual(afterTitleEdit.links, withLinks.links, 'links survive a title-only update')
    assert.equal(await getFile(root, s1.id), null, 'the old path no longer resolves after rename')

    assert.deepEqual((await listFiles(root, b.id)).map((s) => s.id), [afterTitleEdit.id])

    await deleteFile(root, afterTitleEdit.id)
    assert.equal(await getFile(root, afterTitleEdit.id), null)
  })
})

test('cases: parsed from `<!-- case: -->` sections, auto "Case N" naming, update/delete by index', async () => {
  await withWorkspace(async (root) => {
    const a = await createFolder(root, { name: 'App' })
    const b = await createFolder(root, { parent_id: a.id, name: 'Auth' })
    const s = await createFile(root, { parent_id: b.id, title: 'Login' })

    assert.deepEqual(await listCases(root, s.id), [], 'a fresh file has no cases')

    const c1 = await createCase(root, { story_id: s.id, body: 'Happy path' })
    const c2 = await createCase(root, { story_id: s.id, body: 'Edge case' })
    assert.equal(c1.name, 'Case 1', 'auto-name is stored at creation')
    assert.equal(c2.name, 'Case 2')

    const updated = await updateCase(root, c1.id, { body: 'Happy path (revised)' })
    assert.equal(updated.body, 'Happy path (revised)')
    assert.equal((await getCase(root, c1.id)).body, 'Happy path (revised)')

    // Deleting c1 must not let a later create reuse "Case 1"'s number if it
    // collides with a still-existing name.
    await deleteCase(root, c1.id)
    const remaining = await listCases(root, s.id)
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0].name, 'Case 2')

    const c3 = await createCase(root, { story_id: s.id, body: 'Third' })
    assert.equal(c3.name, 'Case 3', 'next auto-name skips the still-existing Case 2')
  })
})

test('reorderCases rewrites the file so case sections appear in the new order', async () => {
  await withWorkspace(async (root) => {
    const a = await createFolder(root, { name: 'App' })
    const b = await createFolder(root, { parent_id: a.id, name: 'Auth' })
    const s = await createFile(root, { parent_id: b.id, title: 'Login' })
    const c1 = await createCase(root, { story_id: s.id, name: 'First', body: 'a' })
    const c2 = await createCase(root, { story_id: s.id, name: 'Second', body: 'b' })

    await reorderCases(root, s.id, [c2.id, c1.id])
    const cases = await listCases(root, s.id)
    assert.deepEqual(cases.map((c) => c.name), ['Second', 'First'])
  })
})

test('buildTree: arbitrary depth, folders first then files (each alphabetical), empty folders included', async () => {
  await withWorkspace(async (root) => {
    const myApp = await createFolder(root, { name: 'My App' })
    await createFolder(root, { name: 'Empty App' }) // no children — must still appear
    const auth = await createFolder(root, { parent_id: myApp.id, name: 'Auth' })
    const deep = await createFolder(root, { parent_id: auth.id, name: 'Deep' })
    await createFile(root, { parent_id: deep.id, title: 'Zeta' })
    const s1 = await createFile(root, { parent_id: auth.id, title: 'Login' })
    await createCase(root, { story_id: s1.id, body: 'case one' })
    // A file that sorts before "Auth" alphabetically must still render AFTER
    // it, since folders always come before files within the same parent.
    await createFile(root, { parent_id: myApp.id, title: 'AAA readme' })

    const tree = await buildTree(root)
    assert.equal(tree.length, 2)
    assert.deepEqual(tree.map((n) => n.id), ['Empty App', 'My App'], 'alphabetical, not creation order')

    const myAppNode = tree.find((n) => n.id === 'My App')
    assert.deepEqual(myAppNode.children.map((c) => c.type), ['folder', 'file'], 'folders before files')
    assert.equal(myAppNode.children[0].id, 'My App/Auth')
    assert.equal(myAppNode.children[1].id, 'My App/AAA readme.md')

    const authNode = myAppNode.children[0]
    assert.equal(authNode.children.length, 2, 'Deep folder + Login file')
    const loginNode = authNode.children.find((c) => c.type === 'file')
    assert.equal(loginNode.cases.length, 1)

    const deepNode = authNode.children.find((c) => c.type === 'folder')
    assert.equal(deepNode.children[0].id, 'My App/Auth/Deep/Zeta.md', 'four levels deep')
  })
})

test('moveNode: file moves into a different folder, folder moves into a different folder', async () => {
  await withWorkspace(async (root) => {
    const p1 = await createFolder(root, { name: 'App' })
    const f1 = await createFolder(root, { parent_id: p1.id, name: 'Auth' })
    const f2 = await createFolder(root, { parent_id: p1.id, name: 'Reports' })
    const s = await createFile(root, { parent_id: f1.id, title: 'Login' })

    const moved = await moveNode(root, 'file', s.id, f2.id)
    assert.equal(moved.id, 'App/Reports/Login.md')
    assert.equal(await getFile(root, s.id), null)
    assert.equal((await listFiles(root, f1.id)).length, 0)

    const p2 = await createFolder(root, { name: 'Other' })
    const movedFolder = await moveNode(root, 'folder', f2.id, p2.id)
    assert.equal(movedFolder.id, 'Other/Reports')
    assert.equal(await getFolder(root, f2.id), null)

    // Moving to the workspace root (newParentId null/empty).
    const movedToRoot = await moveNode(root, 'folder', movedFolder.id, null)
    assert.equal(movedToRoot.id, 'Reports')
  })
})

test('duplicateNode: file copy preserves content, folder copy is recursive', async () => {
  await withWorkspace(async (root) => {
    const a = await createFolder(root, { name: 'App' })
    const b = await createFolder(root, { parent_id: a.id, name: 'Auth' })
    const s = await createFile(root, {
      parent_id: b.id,
      title: 'Login',
      links: [{ url: 'https://a.test', tag: 'Design', color: 'purple' }],
      criticality: 'P2',
    })
    await createCase(root, { story_id: s.id, name: 'Happy path', body: 'Step 1' })

    const fileCopy = await duplicateNode(root, 'file', s.id)
    assert.equal(fileCopy.id, 'App/Auth/Login (copy).md')
    assert.equal(fileCopy.criticality, 'P2')
    assert.deepEqual(fileCopy.links, [{ url: 'https://a.test', tag: 'Design', color: 'purple' }])
    assert.deepEqual((await listCases(root, fileCopy.id)).map((c) => c.name), ['Happy path'], 'cases copied too')

    const nested = await createFolder(root, { parent_id: b.id, name: 'Nested' })
    await createFile(root, { parent_id: nested.id, title: 'Inner' })

    const folderCopy = await duplicateNode(root, 'folder', b.id)
    assert.equal(folderCopy.id, 'App/Auth (copy)')
    const copiedChildren = await buildTree(root)
    const appNode = copiedChildren.find((n) => n.id === 'App')
    const authCopyNode = appNode.children.find((n) => n.id === 'App/Auth (copy)')
    assert.ok(authCopyNode, 'the whole Auth subtree was recursively copied')
    const nestedCopy = authCopyNode.children.find((n) => n.name === 'Nested')
    assert.ok(nestedCopy, 'nested subfolder copied')
    assert.ok(nestedCopy.children.some((c) => c.title === 'Inner'), 'file inside nested subfolder copied')
  })
})

test('files on disk are readable markdown with YAML frontmatter', async () => {
  await withWorkspace(async (root) => {
    const a = await createFolder(root, { name: 'App' })
    const b = await createFolder(root, { parent_id: a.id, name: 'Auth' })
    const s = await createFile(root, {
      parent_id: b.id,
      title: 'Login',
      links: [{ url: 'https://a.test', tag: 'Design', color: 'purple' }],
      criticality: 'P2',
    })
    await createCase(root, { story_id: s.id, name: 'Happy path', body: 'Step 1' })

    const raw = await readFile(path.join(root, 'App', 'Auth', 'Login.md'), 'utf8')
    assert.match(raw, /^---/)
    assert.match(raw, /criticality: P2/)
    assert.match(raw, /- \{url: "https:\/\/a\.test", tag: Design, color: purple\}/)
    assert.match(raw, /<!-- case: Happy path -->/)
    assert.match(raw, /Step 1/)
  })
})
