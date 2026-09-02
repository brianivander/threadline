// Repo tests — CRUD over a generic, arbitrary-depth folder/file tree, tab
// handling within a file, tree building, moving nodes, and duplication.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CRITICALITIES } from '../src/index.js'
import {
  listFolders, getFolder, createFolder, updateFolder, deleteFolder,
  listFiles, getFile, createFile, updateFile, deleteFile,
  listTabs, getTab, createTab, updateTab, deleteTab,
  buildTree, moveNode, duplicateNode, reorderTabs,
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
    assert.equal(s1.id, 'App/Auth/User can log in.s.md', 'the filename preserves the exact title text')
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
    assert.equal(afterTitleEdit.id, 'App/Auth/User can log in (v2).s.md', 'renaming the title renames the file')
    assert.deepEqual(afterTitleEdit.links, withLinks.links, 'links survive a title-only update')
    assert.equal(await getFile(root, s1.id), null, 'the old path no longer resolves after rename')

    assert.deepEqual((await listFiles(root, b.id)).map((s) => s.id), [afterTitleEdit.id])

    await deleteFile(root, afterTitleEdit.id)
    assert.equal(await getFile(root, afterTitleEdit.id), null)
  })
})

test("createFile kind 'doc' writes a plain empty .md, not a story", async () => {
  await withWorkspace(async (root) => {
    const f = await createFolder(root, { name: 'Docs' })
    const doc = await createFile(root, { parent_id: f.id, kind: 'doc', title: 'Spec' })

    assert.equal(doc.id, 'Docs/Spec.md', 'a doc keeps its real extension in the id')
    assert.equal(doc.kind, 'doc')
    assert.equal(doc.ext, 'md')
    assert.equal(await readFile(path.join(root, 'Docs', 'Spec.md'), 'utf8'), '', 'no frontmatter')

    // The default kind is still a story, and the two never collide on name.
    const story = await createFile(root, { parent_id: f.id, title: 'Spec' })
    assert.equal(story.id, 'Docs/Spec.s.md')
    assert.equal(story.kind, 'story')

    // Same title twice gets the usual ' (2)' treatment within its own kind.
    const second = await createFile(root, { parent_id: f.id, kind: 'doc', title: 'Spec' })
    assert.equal(second.id, 'Docs/Spec (2).md')
  })
})

test('tabs: parsed from `<!-- tab: -->` sections, auto "Tab N" naming, update/delete by index', async () => {
  await withWorkspace(async (root) => {
    const a = await createFolder(root, { name: 'App' })
    const b = await createFolder(root, { parent_id: a.id, name: 'Auth' })
    const s = await createFile(root, { parent_id: b.id, title: 'Login' })

    assert.deepEqual(await listTabs(root, s.id), [], 'a fresh file has no tabs')

    const c1 = await createTab(root, { story_id: s.id, body: 'Happy path' })
    const c2 = await createTab(root, { story_id: s.id, body: 'Edge case' })
    assert.equal(c1.name, 'Tab 1', 'auto-name is stored at creation')
    assert.equal(c2.name, 'Tab 2')

    const updated = await updateTab(root, c1.id, { body: 'Happy path (revised)' })
    assert.equal(updated.body, 'Happy path (revised)')
    assert.equal((await getTab(root, c1.id)).body, 'Happy path (revised)')

    // Deleting c1 must not let a later create reuse "Tab 1"'s number if it
    // collides with a still-existing name.
    await deleteTab(root, c1.id)
    const remaining = await listTabs(root, s.id)
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0].name, 'Tab 2')

    const c3 = await createTab(root, { story_id: s.id, body: 'Third' })
    assert.equal(c3.name, 'Tab 3', 'next auto-name skips the still-existing Tab 2')
  })
})

test('reorderTabs rewrites the file so case sections appear in the new order', async () => {
  await withWorkspace(async (root) => {
    const a = await createFolder(root, { name: 'App' })
    const b = await createFolder(root, { parent_id: a.id, name: 'Auth' })
    const s = await createFile(root, { parent_id: b.id, title: 'Login' })
    const c1 = await createTab(root, { story_id: s.id, name: 'First', body: 'a' })
    const c2 = await createTab(root, { story_id: s.id, name: 'Second', body: 'b' })

    await reorderTabs(root, s.id, [c2.id, c1.id])
    const cases = await listTabs(root, s.id)
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
    await createTab(root, { story_id: s1.id, body: 'case one' })
    // A file that sorts before "Auth" alphabetically must still render AFTER
    // it, since folders always come before files within the same parent.
    await createFile(root, { parent_id: myApp.id, title: 'AAA readme' })

    const tree = await buildTree(root)
    assert.equal(tree.length, 2)
    assert.deepEqual(tree.map((n) => n.id), ['Empty App', 'My App'], 'alphabetical, not creation order')

    const myAppNode = tree.find((n) => n.id === 'My App')
    assert.deepEqual(myAppNode.children.map((c) => c.type), ['folder', 'file'], 'folders before files')
    assert.equal(myAppNode.children[0].id, 'My App/Auth')
    assert.equal(myAppNode.children[1].id, 'My App/AAA readme.s.md')

    const authNode = myAppNode.children[0]
    assert.equal(authNode.children.length, 2, 'Deep folder + Login file')
    const loginNode = authNode.children.find((c) => c.type === 'file')
    assert.equal(loginNode.id, 'My App/Auth/Login.s.md')
    assert.equal(loginNode.cases, undefined, 'cases are fetched per story, not carried by the tree')

    const deepNode = authNode.children.find((c) => c.type === 'folder')
    assert.equal(deepNode.children[0].id, 'My App/Auth/Deep/Zeta.s.md', 'four levels deep')
  })
})

test('moveNode: file moves into a different folder, folder moves into a different folder', async () => {
  await withWorkspace(async (root) => {
    const p1 = await createFolder(root, { name: 'App' })
    const f1 = await createFolder(root, { parent_id: p1.id, name: 'Auth' })
    const f2 = await createFolder(root, { parent_id: p1.id, name: 'Reports' })
    const s = await createFile(root, { parent_id: f1.id, title: 'Login' })

    const moved = await moveNode(root, 'file', s.id, f2.id)
    assert.equal(moved.id, 'App/Reports/Login.s.md')
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
    await createTab(root, { story_id: s.id, name: 'Happy path', body: 'Step 1' })

    const fileCopy = await duplicateNode(root, 'file', s.id)
    assert.equal(fileCopy.id, 'App/Auth/Login (copy).s.md')
    assert.equal(fileCopy.criticality, 'P2')
    assert.deepEqual(fileCopy.links, [{ url: 'https://a.test', tag: 'Design', color: 'purple' }])
    assert.deepEqual((await listTabs(root, fileCopy.id)).map((c) => c.name), ['Happy path'], 'cases copied too')

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
    await createTab(root, { story_id: s.id, name: 'Happy path', body: 'Step 1' })

    const raw = await readFile(path.join(root, 'App', 'Auth', 'Login.s.md'), 'utf8')
    assert.match(raw, /^---/)
    assert.match(raw, /criticality: P2/)
    assert.match(raw, /- \{url: "https:\/\/a\.test", tag: Design, color: purple\}/)
    assert.match(raw, /<!-- tab: Happy path -->/)
    assert.match(raw, /Step 1/)
  })
})


// ---- file kinds: story vs plain document vs HTML page -------------------------

test('a `.s.md` is a story and any other markdown is a doc — the name is the whole rule', async () => {
  await withWorkspace(async (root) => {
    const story = await createFile(root, { title: 'Login' })
    assert.equal(story.id, 'Login.s.md', 'a new file is a story, so it gets the story extension')
    assert.equal(story.kind, 'story')
    assert.equal(story.title, 'Login', 'the compound extension comes off whole, not just its last dot')
    assert.equal(story.ext, 's.md')
    const raw = await readFile(path.join(root, 'Login.s.md'), 'utf8')
    assert.match(raw, /<!-- threadline-story -->/, 'a story still says so from the inside too')

    // A hand-written document with no Threadline structure at all.
    await writeFile(path.join(root, 'PRD.md'), '# Product requirements\n\nSome prose.\n', 'utf8')
    const doc = await getFile(root, 'PRD.md')
    assert.equal(doc.kind, 'doc')
    assert.equal(doc.title, 'PRD', 'the extension is carried separately, not in the title')
    assert.equal(doc.ext, 'md')
    assert.equal(doc.criticality, undefined, 'no story fields are invented for it')

    // Contents never decide: a plain `.md` carrying every story marker there is
    // stays a doc, and an empty `.s.md` is a story with no cases yet.
    await writeFile(path.join(root, 'Marked.md'), '---\ncriticality: P2\n---\n\n<!-- case: Happy -->\n\nok\n', 'utf8')
    assert.equal((await getFile(root, 'Marked.md')).kind, 'doc')
    await writeFile(path.join(root, 'Bare.s.md'), '', 'utf8')
    assert.equal((await getFile(root, 'Bare.s.md')).kind, 'story')
    assert.deepEqual(await listTabs(root, 'Bare.s.md'), [])
  })
})

test('renaming carries story-ness: a story keeps `.s.md`, and `.s.md` is how a doc becomes one', async () => {
  await withWorkspace(async (root) => {
    const story = await createFile(root, { title: 'Login' })

    // The extension is invisible in the UI — a title-only rename must put it
    // back, or renaming a story would silently demote it to a document.
    const renamed = await updateFile(root, story.id, { title: 'User can log in' })
    assert.equal(renamed.id, 'User can log in.s.md')
    assert.equal(renamed.kind, 'story')

    // A deliberate extension typed into a rename still wins, both ways round.
    const demoted = await updateFile(root, renamed.id, { title: 'User can log in.md' })
    assert.equal(demoted.id, 'User can log in.md')
    assert.equal(demoted.kind, 'doc')

    await writeFile(path.join(root, 'PRD.md'), '---\ncriticality: P2\n---\n\n<!-- case: Happy -->\n\nok\n', 'utf8')
    const promoted = await updateFile(root, 'PRD.md', { title: 'PRD.s.md' })
    assert.equal(promoted.kind, 'story')
    assert.equal(promoted.criticality, 'P2', 'and it is read as the story its text already was')
  })
})

test('a story keeps its extension through a move and a duplicate', async () => {
  await withWorkspace(async (root) => {
    await createFolder(root, { name: 'sub' })
    const story = await createFile(root, { title: 'Login' })

    const moved = await moveNode(root, 'file', story.id, 'sub')
    assert.equal(moved.id, 'sub/Login.s.md', 'the counter and the copy suffix land before the whole extension')
    assert.equal((await duplicateNode(root, 'file', moved.id)).id, 'sub/Login (copy).s.md')

    // A collision suffix, likewise — 'Login (2).s.md', never 'Login.s (2).md'.
    assert.equal((await createFile(root, { parent_id: 'sub', title: 'Login' })).id, 'sub/Login (2).s.md')
  })
})

test('HTML pages are listed and never read as markdown', async () => {
  await withWorkspace(async (root) => {
    await writeFile(path.join(root, 'mock.html'), '<!doctype html><h1>Mock</h1>', 'utf8')
    await writeFile(path.join(root, 'legacy.htm'), '<h1>Legacy</h1>', 'utf8')
    // Listed like anything else, as the kind that says "not openable here".
    await writeFile(path.join(root, 'notes.txt'), 'ignored', 'utf8')
    await createFile(root, { title: 'Login' })

    const files = await listFiles(root, null)
    assert.deepEqual(
      files.map((f) => [f.title, f.ext, f.kind]),
      [
        ['legacy', 'htm', 'page'],
        ['Login', 's.md', 'story'],
        ['mock', 'html', 'page'],
        ['notes', 'txt', 'text'],
      ],
      'every file is listed alphabetically; the kind says what opening it would do',
    )

    // updateFile is the rename route, and it must not rewrite a page's body.
    const renamed = await updateFile(root, 'mock.html', { title: 'mockup.html' })
    assert.equal(renamed.id, 'mockup.html')
    assert.equal(await readFile(path.join(root, 'mockup.html'), 'utf8'), '<!doctype html><h1>Mock</h1>')
  })
})

test('editing a plain document through updateFile leaves its text alone', async () => {
  await withWorkspace(async (root) => {
    const text = '# Product requirements\n\nSome prose.\n'
    await writeFile(path.join(root, 'PRD.md'), text, 'utf8')
    // A criticality has nowhere to go on a doc, and answering it by
    // re-serializing the file as a story would flatten the prose.
    await updateFile(root, 'PRD.md', { criticality: 'P1' })
    assert.equal(await readFile(path.join(root, 'PRD.md'), 'utf8'), text)
  })
})

test('renaming, moving and duplicating a file keep its extension', async () => {
  await withWorkspace(async (root) => {
    await createFolder(root, { name: 'sub' })
    await writeFile(path.join(root, 'mock.html'), '<h1>Mock</h1>', 'utf8')
    await writeFile(path.join(root, 'PRD.md'), '# PRD\n', 'utf8')

    // A rename that already carries a known extension is taken verbatim...
    assert.equal((await updateFile(root, 'PRD.md', { title: 'PRD v2.md' })).id, 'PRD v2.md')
    // ...and one that doesn't keeps the extension the file already had.
    assert.equal((await updateFile(root, 'mock.html', { title: 'mockup' })).id, 'mockup.html')

    assert.equal((await moveNode(root, 'file', 'mockup.html', 'sub')).id, 'sub/mockup.html')
    assert.equal((await duplicateNode(root, 'file', 'sub/mockup.html')).id, 'sub/mockup (copy).html')
  })
})

test('buildTree reports a kind for every file and carries no cases', async () => {
  await withWorkspace(async (root) => {
    await createFile(root, { title: 'Login' })
    await createTab(root, { story_id: 'Login.s.md', name: 'Happy', body: 'ok' })
    await writeFile(path.join(root, 'PRD.md'), '# PRD\n', 'utf8')
    await writeFile(path.join(root, 'mock.html'), '<h1>Mock</h1>', 'utf8')

    const tree = await buildTree(root)
    assert.deepEqual(
      tree.map((n) => [n.title, n.ext, n.kind]),
      [['Login', 's.md', 'story'], ['mock', 'html', 'page'], ['PRD', 'md', 'doc']],
    )
    assert.ok(tree.every((n) => n.cases === undefined), 'no node carries cases')
    // The story's case is still there — it's just fetched on its own.
    assert.equal((await listTabs(root, 'Login.s.md')).length, 1)
  })
})


test("a file this app cannot open is listed as 'other' and never read", async () => {
  await withWorkspace(async (root) => {
    // Bytes that would be nonsense if parsed as markdown.
    await writeFile(path.join(root, 'sheet.xlsx'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]))
    await writeFile(path.join(root, 'archive.zip'), Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    await writeFile(path.join(root, '.gitignore'), '*.db', 'utf8')

    const files = await listFiles(root, null)
    assert.deepEqual(files.map((f) => [f.title, f.ext, f.kind]), [
      // A dotfile has nothing before the dot, so its whole name is the title —
      // and nothing to consult, which makes it text rather than unopenable.
      ['.gitignore', '', 'text'],
      ['archive', 'zip', 'other'],
      ['sheet', 'xlsx', 'other'],
    ])

    // Described, not interpreted: none of the story fields are invented for it.
    const one = await getFile(root, 'sheet.xlsx')
    assert.equal(one.kind, 'other')
    assert.equal(one.criticality, undefined)
    assert.equal('cases' in one, false)

    // And a rename leaves the bytes alone.
    const renamed = await updateFile(root, 'archive.zip', { title: 'backup' })
    assert.equal(renamed.id, 'backup.zip')
    assert.deepEqual([...(await readFile(path.join(root, 'backup.zip')))], [0x50, 0x4b, 0x05, 0x06])
  })
})

test('images are listed as their own kind and never read', async () => {
  await withWorkspace(async (root) => {
    await writeFile(path.join(root, 'mockup.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    await writeFile(path.join(root, 'photo.JPG'), Buffer.from([0xff, 0xd8, 0xff]))
    await writeFile(path.join(root, 'icon.svg'), '<svg/>', 'utf8')
    await writeFile(path.join(root, 'data.csv'), 'a,b\n', 'utf8')

    const files = await listFiles(root, null)
    assert.deepEqual(
      files.map((f) => [f.title, f.ext, f.kind]),
      [
        ['data', 'csv', 'text'],
        ['icon', 'svg', 'image'],
        ['mockup', 'png', 'image'],
        ['photo', 'jpg', 'image'],
      ],
      'the extension is reported lowercased regardless of how the file spells it',
    )

    // A rename keeps the extension the file actually has, not the lowercased
    // label — renaming a file is no occasion to reletter its extension.
    assert.equal((await updateFile(root, 'photo.JPG', { title: 'team photo' })).id, 'team photo.JPG')

    // ...and it must never rewrite the bytes of a binary.
    const renamed = await updateFile(root, 'mockup.png', { title: 'login mockup' })
    assert.equal(renamed.id, 'login mockup.png')
    assert.deepEqual([...(await readFile(path.join(root, 'login mockup.png')))], [0x89, 0x50, 0x4e, 0x47])
  })
})

test('every file kind reports an ext the sidebar can label', async () => {
  await withWorkspace(async (root) => {
    await createFile(root, { title: 'Login' })
    await writeFile(path.join(root, 'PRD.md'), '# PRD\n', 'utf8')
    await writeFile(path.join(root, 'mock.html'), '<h1/>', 'utf8')
    await writeFile(path.join(root, 'shot.png'), Buffer.from([0x89]))

    for (const f of await listFiles(root, null)) {
      assert.ok(f.ext && !f.ext.startsWith('.'), `${f.title} has a bare ext, got ${JSON.stringify(f.ext)}`)
      assert.ok(!f.title.includes('.'), `${f.title} keeps its extension out of the title`)
    }
  })
})
