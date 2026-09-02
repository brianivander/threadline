// Comment thread tests — thread CRUD against real story files on disk, the
// workspace-wide scan, and the guarantee that editing a tab body (what the
// story panel autosaves on a debounce) never drops comments.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createFolder, createFile, updateFile,
  createTab, updateTab, deleteTab, reorderTabs, listTabs,
  listThreads, createThread, addReply, setThreadStatus, deleteThread, scanThreads,
  extractMentions, buildTree, getFile, duplicateNode, moveNode,
} from '../src/repo.js'

async function withWorkspace(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'threadline-threads-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const ANCHOR = { quote: 'log in', prefix: 'Steps: ', suffix: '.' }

test('extractMentions finds each mentioned address once, lowercased', () => {
  assert.deepEqual(extractMentions('@a@corp.test and @B@Corp.test and @a@corp.test again'), [
    'a@corp.test',
    'b@corp.test',
  ])
  assert.deepEqual(extractMentions('no mentions here'), [])
  assert.deepEqual(extractMentions(''), [])
})

test('createThread writes an anchored thread and returns an enriched row', async () => {
  await withWorkspace(async (root) => {
    const story = await createFile(root, { title: 'Login' })
    await createTab(root, { story_id: story.id, name: 'Happy path', body: 'Steps: log in.' })

    const thread = await createThread(root, {
      story_id: story.id,
      case_name: 'Happy path',
      anchor: ANCHOR,
      author: 'jane@corp.test',
      body: '@ian@corp.test is this the right screen?',
    })

    assert.match(thread.id, /^t_[0-9a-f]{12}$/)
    assert.equal(thread.story_id, story.id)
    assert.equal(thread.story_title, 'Login')
    assert.equal(thread.case_name, 'Happy path')
    assert.equal(thread.status, 'open')
    assert.deepEqual(thread.anchor, ANCHOR)
    assert.equal(thread.author, 'jane@corp.test')
    assert.deepEqual(thread.mentions, ['ian@corp.test'])
    assert.equal(thread.reply_count, 0)
    assert.equal(thread.comments.length, 1)

    // ...and it's really on disk, in the comments section, as readable prose.
    const raw = await readFile(path.join(root, 'Login.s.md'), 'utf8')
    assert.match(raw, /<!-- comments -->/)
    assert.match(raw, /<!-- thread id=t_[0-9a-f]{12} tab="Happy path" status=open/)
    assert.match(raw, /^> log in$/m)
    assert.match(raw, /- \*\*jane@corp\.test\*\*/)
  })
})

test('a story-level thread has no anchor', async () => {
  await withWorkspace(async (root) => {
    const story = await createFile(root, { title: 'Login' })
    const thread = await createThread(root, {
      story_id: story.id,
      author: 'jane@corp.test',
      body: 'general note about this story',
    })
    assert.equal(thread.anchor, null)
    assert.equal(thread.case_name, '')

    const raw = await readFile(path.join(root, 'Login.s.md'), 'utf8')
    assert.doesNotMatch(raw, /^>/m)
  })
})

test('createThread rejects a missing author or an empty body', async () => {
  await withWorkspace(async (root) => {
    const story = await createFile(root, { title: 'Login' })
    await assert.rejects(() => createThread(root, { story_id: story.id, body: 'x' }), /requires author/)
    await assert.rejects(
      () => createThread(root, { story_id: story.id, author: 'a@corp.test', body: '   ' }),
      /non-empty body/,
    )
    await assert.rejects(() => createThread(root, { author: 'a@corp.test', body: 'x' }), /requires story_id/)
    assert.deepEqual(await listThreads(root, story.id), [])
  })
})

test('addReply appends to the thread and updates the derived counts', async () => {
  await withWorkspace(async (root) => {
    const story = await createFile(root, { title: 'Login' })
    const created = await createThread(root, {
      story_id: story.id,
      anchor: ANCHOR,
      author: 'jane@corp.test',
      body: 'question?',
    })

    const replied = await addReply(root, story.id, created.id, { author: 'ian@corp.test', body: 'answer @sam@corp.test' })
    assert.equal(replied.comments.length, 2)
    assert.equal(replied.reply_count, 1)
    // The author is whoever OPENED the thread, not whoever last replied.
    assert.equal(replied.author, 'jane@corp.test')
    assert.deepEqual(replied.mentions, ['sam@corp.test'])
    assert.ok(replied.updated_at >= replied.created_at)

    await assert.rejects(() => addReply(root, story.id, 't_nope', { author: 'a@corp.test', body: 'x' }), /Thread not found/)
  })
})

test('resolving appends a note as the final comment; reopening appends another', async () => {
  await withWorkspace(async (root) => {
    const story = await createFile(root, { title: 'Login' })
    const created = await createThread(root, { story_id: story.id, author: 'jane@corp.test', body: 'question?' })

    const resolved = await setThreadStatus(root, story.id, created.id, {
      status: 'resolved',
      author: 'ian@corp.test',
    })
    assert.equal(resolved.status, 'resolved')
    assert.equal(resolved.comments.length, 2)
    assert.equal(resolved.comments[1].body, '_Marked as resolved._')
    assert.equal(resolved.comments[1].author, 'ian@corp.test')

    const reopened = await setThreadStatus(root, story.id, created.id, { status: 'open', author: 'jane@corp.test' })
    assert.equal(reopened.status, 'open')
    assert.equal(reopened.comments.length, 3)
    assert.equal(reopened.comments[2].body, '_Reopened._')

    const raw = await readFile(path.join(root, 'Login.s.md'), 'utf8')
    assert.match(raw, /status=open/)
  })
})

test('re-resolving an already resolved thread is a no-op, not a second note', async () => {
  await withWorkspace(async (root) => {
    const story = await createFile(root, { title: 'Login' })
    const created = await createThread(root, { story_id: story.id, author: 'jane@corp.test', body: 'q' })
    await setThreadStatus(root, story.id, created.id, { status: 'resolved', author: 'ian@corp.test' })
    const again = await setThreadStatus(root, story.id, created.id, { status: 'resolved', author: 'ian@corp.test' })
    assert.equal(again.comments.length, 2)
  })
})

test('only the thread author can delete it', async () => {
  await withWorkspace(async (root) => {
    const story = await createFile(root, { title: 'Login' })
    const created = await createThread(root, { story_id: story.id, author: 'jane@corp.test', body: 'q' })
    await addReply(root, story.id, created.id, { author: 'ian@corp.test', body: 'a' })

    await assert.rejects(
      () => deleteThread(root, story.id, created.id, { requester: 'ian@corp.test' }),
      /Only the thread author \(jane@corp\.test\)/,
    )
    await assert.rejects(() => deleteThread(root, story.id, created.id, {}), /Only the thread author/)
    // The failed attempts must not have written a partial file.
    assert.equal((await listThreads(root, story.id)).length, 1)

    await deleteThread(root, story.id, created.id, { requester: 'jane@corp.test' })
    assert.deepEqual(await listThreads(root, story.id), [])
  })
})

test('editing a case body preserves the comments section', async () => {
  await withWorkspace(async (root) => {
    const story = await createFile(root, { title: 'Login' })
    const c = await createTab(root, { story_id: story.id, name: 'Happy path', body: 'Steps: log in.' })
    const created = await createThread(root, {
      story_id: story.id,
      case_name: 'Happy path',
      anchor: ANCHOR,
      author: 'jane@corp.test',
      body: 'q',
    })

    // This is what the story panel's debounced autosave does.
    await updateTab(root, c.id, { body: 'Steps: log in. Then log out.' })

    const threads = await listThreads(root, story.id)
    assert.equal(threads.length, 1, 'thread survived a case-body save')
    assert.equal(threads[0].id, created.id)
    assert.deepEqual(threads[0].anchor, ANCHOR)
  })
})

test('other file mutations preserve the comments section too', async () => {
  await withWorkspace(async (root) => {
    const story = await createFile(root, { title: 'Login' })
    await createTab(root, { story_id: story.id, name: 'A', body: 'a' })
    const second = await createTab(root, { story_id: story.id, name: 'B', body: 'b' })
    await createThread(root, { story_id: story.id, author: 'jane@corp.test', body: 'q' })

    await updateFile(root, story.id, { criticality: 'P4' })
    assert.equal((await listThreads(root, story.id)).length, 1, 'survived a metadata change')

    await createTab(root, { story_id: story.id, name: 'C', body: 'c' })
    assert.equal((await listThreads(root, story.id)).length, 1, 'survived adding a tab')

    const tabs = await listTabs(root, story.id)
    await reorderTabs(root, story.id, [tabs[2].id, tabs[0].id, tabs[1].id])
    assert.equal((await listThreads(root, story.id)).length, 1, 'survived a tab reorder')

    await deleteTab(root, second.id)
    assert.equal((await listThreads(root, story.id)).length, 1, 'survived deleting a tab')

    // A title change renames the file; threads move with it, under the new id.
    const renamed = await updateFile(root, story.id, { title: 'Sign in' })
    assert.notEqual(renamed.id, story.id)
    const moved = await listThreads(root, renamed.id)
    assert.equal(moved.length, 1)
    assert.equal(moved[0].story_title, 'Sign in')
  })
})

test('threads are absent from file and tree payloads', async () => {
  await withWorkspace(async (root) => {
    const story = await createFile(root, { title: 'Login' })
    await createTab(root, { story_id: story.id, name: 'A', body: 'a' })
    await createThread(root, { story_id: story.id, author: 'jane@corp.test', body: 'q' })

    assert.equal('threads' in (await getFile(root, story.id)), false)
    const tree = await buildTree(root)
    assert.equal('threads' in tree[0], false)
    assert.equal('cases' in tree[0], false, 'cases do not travel with the tree either')
  })
})

test('scanThreads collects every thread in the workspace, at any depth', async () => {
  await withWorkspace(async (root) => {
    const project = await createFolder(root, { name: 'project1' })
    const feature = await createFolder(root, { parent_id: project.id, name: 'feature1' })

    const top = await createFile(root, { title: 'Top' })
    const deep = await createFile(root, { parent_id: feature.id, title: 'Deep' })
    const empty = await createFile(root, { parent_id: feature.id, title: 'NoComments' })

    await createThread(root, { story_id: top.id, author: 'jane@corp.test', body: 'hi @ian@corp.test' })
    await createThread(root, { story_id: deep.id, author: 'ian@corp.test', body: 'deep one' })
    const resolvable = await createThread(root, { story_id: deep.id, author: 'sam@corp.test', body: 'to resolve' })
    await setThreadStatus(root, deep.id, resolvable.id, { status: 'resolved', author: 'sam@corp.test' })

    const all = await scanThreads(root)
    assert.equal(all.length, 3)
    assert.deepEqual(
      all.map((t) => t.story_id).sort(),
      ['Top.s.md', 'project1/feature1/Deep.s.md', 'project1/feature1/Deep.s.md'].sort(),
    )
    assert.ok(all.every((t) => t.story_title))
    assert.equal(empty && (await listThreads(root, empty.id)).length, 0)

    // The two filters the panel drives: mentions of me, and status.
    const forIan = all.filter((t) => t.mentions.includes('ian@corp.test'))
    assert.equal(forIan.length, 1)
    assert.equal(forIan[0].story_id, 'Top.s.md')
    assert.equal(all.filter((t) => t.status === 'resolved').length, 1)
    assert.equal(all.filter((t) => t.status === 'open').length, 2)
  })
})

test('scanThreads is empty for a workspace with no comments', async () => {
  await withWorkspace(async (root) => {
    await createFile(root, { title: 'Login' })
    assert.deepEqual(await scanThreads(root), [])
  })
})

test('duplicating or moving a story carries its threads', async () => {
  await withWorkspace(async (root) => {
    const folder = await createFolder(root, { name: 'elsewhere' })
    const story = await createFile(root, { title: 'Login' })
    await createThread(root, { story_id: story.id, anchor: ANCHOR, author: 'jane@corp.test', body: 'q' })

    const copy = await duplicateNode(root, 'file', story.id)
    const copied = await listThreads(root, copy.id)
    assert.equal(copied.length, 1)
    assert.deepEqual(copied[0].anchor, ANCHOR)

    const moved = await moveNode(root, 'file', story.id, folder.id)
    assert.equal(moved.id, 'elsewhere/Login.s.md')
    assert.equal((await listThreads(root, moved.id)).length, 1)
  })
})

test('listThreads on a missing or absent story is empty, not a throw', async () => {
  await withWorkspace(async (root) => {
    assert.deepEqual(await listThreads(root, 'nope.md'), [])
    assert.deepEqual(await listThreads(root, null), [])
  })
})

test('mutating a thread on a missing story rejects', async () => {
  await withWorkspace(async (root) => {
    await assert.rejects(
      () => createThread(root, { story_id: 'nope.md', author: 'a@corp.test', body: 'x' }),
      /File not found/,
    )
  })
})

test('several threads on one story keep their order and stay independent', async () => {
  await withWorkspace(async (root) => {
    const story = await createFile(root, { title: 'Login' })
    const first = await createThread(root, { story_id: story.id, author: 'a@corp.test', body: 'first' })
    const second = await createThread(root, { story_id: story.id, author: 'b@corp.test', body: 'second' })
    const third = await createThread(root, { story_id: story.id, author: 'c@corp.test', body: 'third' })

    await setThreadStatus(root, story.id, second.id, { status: 'resolved', author: 'b@corp.test' })
    await addReply(root, story.id, first.id, { author: 'z@corp.test', body: 'reply' })

    const threads = await listThreads(root, story.id)
    assert.deepEqual(threads.map((t) => t.id), [first.id, second.id, third.id])
    assert.deepEqual(threads.map((t) => t.status), ['open', 'resolved', 'open'])
    assert.deepEqual(threads.map((t) => t.reply_count), [1, 1, 0])

    await deleteThread(root, story.id, second.id, { requester: 'b@corp.test' })
    assert.deepEqual((await listThreads(root, story.id)).map((t) => t.id), [first.id, third.id])
  })
})
