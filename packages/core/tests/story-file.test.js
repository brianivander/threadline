// story-file tests — frontmatter parsing/serialization and `<!-- tab: -->`
// marker splitting.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isStoryFile, parseStoryFile, serializeStoryFile, STORY_MARKER } from '../src/story-file.js'

test('parses frontmatter (criticality, links) and case sections', () => {
  const raw = `---
criticality: P2
links:
  - https://www.figma.com/proto/abc
  - https://docs.google.com/spreadsheets/d/xyz
---

<!-- tab: Happy path -->

Preconditions: registered user.
Steps: log in.

<!-- tab: Wrong password -->

Expected: error shown.
`
  const { frontmatter, tabs } = parseStoryFile(raw)
  assert.equal(frontmatter.criticality, 'P2')
  assert.deepEqual(frontmatter.links, [
    'https://www.figma.com/proto/abc',
    'https://docs.google.com/spreadsheets/d/xyz',
  ])
  assert.equal(tabs.length, 2)
  assert.equal(tabs[0].name, 'Happy path')
  assert.match(tabs[0].body, /registered user/)
  assert.equal(tabs[1].name, 'Wrong password')
})

test('a file with no markers and no body has zero tabs', () => {
  const raw = '---\ncriticality: P1\nlinks: []\n---\n\n'
  const { tabs } = parseStoryFile(raw)
  assert.deepEqual(tabs, [])
})

test('a file with no markers but a body is read as one implicit tab', () => {
  const raw = '---\ncriticality: P1\n---\n\nSome free-form notes.\n'
  const { tabs } = parseStoryFile(raw)
  assert.equal(tabs.length, 1)
  assert.equal(tabs[0].name, 'Tab 1')
  assert.match(tabs[0].body, /free-form notes/)
})

test('missing frontmatter yields empty frontmatter, not a crash', () => {
  const { frontmatter, tabs } = parseStoryFile('<!-- tab: Only tab -->\nbody text\n')
  assert.deepEqual(frontmatter.links, [])
  assert.equal(tabs.length, 1)
  assert.equal(tabs[0].name, 'Only tab')
})

test('a marker inside a fenced code block is not a tab boundary', () => {
  const raw = `---\ncriticality: P1\n---\n\n<!-- tab: Real tab -->\n\n\`\`\`\n<!-- tab: not a marker -->\n\`\`\`\nmore text\n`
  const { tabs } = parseStoryFile(raw)
  assert.equal(tabs.length, 1)
  assert.equal(tabs[0].name, 'Real tab')
  assert.match(tabs[0].body, /not a marker/)
})

test('markdown headings inside a tab body are not tab boundaries', () => {
  const raw = `---\ncriticality: P1\n---\n\n<!-- tab: Real tab -->\n\n## Steps\n1. log in\n\n### Expected\nhome screen\n`
  const { tabs } = parseStoryFile(raw)
  assert.equal(tabs.length, 1)
  assert.equal(tabs[0].name, 'Real tab')
  assert.match(tabs[0].body, /## Steps/)
  assert.match(tabs[0].body, /### Expected/)
})

test('serializeStoryFile round-trips through parseStoryFile', () => {
  const original = {
    frontmatter: { criticality: 'P3', links: ['https://a.test', 'https://b.test'] },
    tabs: [
      { name: 'Tab A', body: 'Step 1\nStep 2' },
      { name: 'Tab B', body: 'Other steps' },
    ],
  }
  const raw = serializeStoryFile(original)
  const parsed = parseStoryFile(raw)
  assert.equal(parsed.frontmatter.criticality, 'P3')
  assert.deepEqual(parsed.frontmatter.links, original.frontmatter.links)
  assert.deepEqual(parsed.tabs, original.tabs)
})

test('parses flow-map list items (tagged links) alongside bare strings', () => {
  const raw = `---
criticality: P1
links:
  - {url: "https://www.figma.com/proto/abc", tag: Design, color: purple}
  - {url: "https://docs.google.com/d/xyz"}
  - https://saved-before-tags-existed.test
---

<!-- tab: Tab 1 -->
body
`
  const { frontmatter } = parseStoryFile(raw)
  assert.deepEqual(frontmatter.links, [
    { url: 'https://www.figma.com/proto/abc', tag: 'Design', color: 'purple' },
    { url: 'https://docs.google.com/d/xyz' },
    'https://saved-before-tags-existed.test',
  ])
})

test('tagged links round-trip, including a comma and a colon in the values', () => {
  const original = {
    frontmatter: {
      criticality: 'P2',
      links: [
        { url: 'https://a.test/x?a=1,2', tag: 'Specs, v2', color: 'light-blue' },
        { url: 'https://b.test' },
      ],
    },
    tabs: [{ name: 'Tab A', body: 'Step 1' }],
  }
  const raw = serializeStoryFile(original)
  const parsed = parseStoryFile(raw)
  assert.deepEqual(parsed.frontmatter.links, original.frontmatter.links)
  assert.deepEqual(parsed.cases, original.cases)
})

test('unknown frontmatter keys are preserved through round-trip', () => {
  const raw = '---\ncriticality: P1\nlinks: []\nowner: "jane"\n---\n\n<!-- tab: Tab 1 -->\nbody\n'
  const { frontmatter, tabs } = parseStoryFile(raw)
  assert.equal(frontmatter.owner, 'jane')
  const rewritten = serializeStoryFile({ frontmatter, tabs })
  assert.match(rewritten, /owner: jane/)
})

// ---- comment threads --------------------------------------------------------

test('parses a comment thread: marker fields, anchor and comments', () => {
  const raw = `---
criticality: P1
links: []
---

<!-- tab: Happy path -->

Preconditions: registered user.
Steps: log in.

<!-- comments -->

<!-- thread id=t_abc tab="Happy path" status=open quote="log in" prefix="Steps: " suffix="." -->

> log in

- **jane@corp.test** · 2026-08-24T08:17:04Z
  @ian@corp.test is this the right screen?

- **ian@corp.test** · 2026-08-24T09:02:11Z
  yes it is
`
  const { tabs, threads } = parseStoryFile(raw)
  // The comments section must not leak into the tab body.
  assert.equal(tabs.length, 1)
  assert.equal(tabs[0].body, 'Preconditions: registered user.\nSteps: log in.')

  assert.equal(threads.length, 1)
  const t = threads[0]
  assert.equal(t.id, 't_abc')
  assert.equal(t.tabName, 'Happy path')
  assert.equal(t.status, 'open')
  assert.deepEqual(t.anchor, { quote: 'log in', prefix: 'Steps: ', suffix: '.' })
  assert.equal(t.comments.length, 2)
  assert.equal(t.comments[0].author, 'jane@corp.test')
  assert.equal(t.comments[0].at, '2026-08-24T08:17:04Z')
  assert.equal(t.comments[0].body, '@ian@corp.test is this the right screen?')
  assert.equal(t.comments[1].body, 'yes it is')
})

test('a story-level thread has no anchor and no blockquote', () => {
  const thread = {
    id: 't_page',
    tabName: '',
    status: 'open',
    anchor: null,
    comments: [{ author: 'a@corp.test', at: '2026-08-24T10:00:00Z', body: 'general note' }],
  }
  const raw = serializeStoryFile({ frontmatter: { criticality: 'P1', links: [] }, tabs: [], threads: [thread] })
  assert.doesNotMatch(raw, /^>/m)
  assert.deepEqual(parseStoryFile(raw).threads, [thread])
})

test('anchor text containing --> does not terminate the thread marker', () => {
  const thread = {
    id: 't_1',
    tabName: 'Tab 1',
    status: 'open',
    anchor: { quote: 'ends with --> here', prefix: '', suffix: '' },
    comments: [{ author: 'a@corp.test', at: '2026-08-24T10:00:00Z', body: 'x' }],
  }
  const raw = serializeStoryFile({ frontmatter: { criticality: 'P1', links: [] }, tabs: [], threads: [thread] })
  // Escaped in the marker, literal only in the human-readable blockquote.
  assert.match(raw, /quote="ends with --\\u003e here"/)
  // The literal arrow appears only in the blockquote, never in the marker.
  const markerLine = raw.split('\n').find((l) => l.startsWith('<!-- thread '))
  assert.doesNotMatch(markerLine, /--> here/)
  assert.deepEqual(parseStoryFile(raw).threads, [thread])
})

test('quotes, newlines and backslashes survive the anchor round-trip', () => {
  const thread = {
    id: 't_2',
    tabName: 'Tab "A"',
    status: 'resolved',
    anchor: { quote: 'say "hi"', prefix: 'a\nb', suffix: 'C:\\path\\to' },
    comments: [{ author: 'a@corp.test', at: '2026-08-24T10:00:00Z', body: 'line1\nline2\n\npara2' }],
  }
  const raw = serializeStoryFile({ frontmatter: { criticality: 'P1', links: [] }, tabs: [], threads: [thread] })
  assert.deepEqual(parseStoryFile(raw).threads, [thread])
})

test('an unknown status falls back to open', () => {
  const raw = '---\ncriticality: P1\n---\n\n<!-- comments -->\n\n<!-- thread id=t_x status=weird quote="q" -->\n'
  assert.equal(parseStoryFile(raw).threads[0].status, 'open')
})

test('a thread marker with no id is skipped, not half-parsed', () => {
  const raw = '---\ncriticality: P1\n---\n\n<!-- comments -->\n\n<!-- thread tab="Tab 1" status=open -->\n\n- **a@b.test** · 2026-01-01T00:00:00Z\n  orphan\n'
  assert.deepEqual(parseStoryFile(raw).threads, [])
})

test('a comments marker inside a fenced code block is not a section boundary', () => {
  const raw = '---\ncriticality: P1\n---\n\n<!-- tab: Tab 1 -->\n\n```\n<!-- comments -->\n```\n'
  const { tabs, threads } = parseStoryFile(raw)
  assert.equal(tabs.length, 1)
  assert.match(tabs[0].body, /<!-- comments -->/)
  assert.deepEqual(threads, [])
})

test('a file with threads but no tabs keeps both regions distinct', () => {
  const thread = {
    id: 't_3',
    tabName: '',
    status: 'open',
    anchor: null,
    comments: [{ author: 'a@corp.test', at: '2026-08-24T10:00:00Z', body: 'note' }],
  }
  const raw = serializeStoryFile({ frontmatter: { criticality: 'P1', links: [] }, tabs: [], threads: [thread] })
  const parsed = parseStoryFile(raw)
  assert.deepEqual(parsed.tabs, [])
  assert.deepEqual(parsed.threads, [thread])
})

test('serializing without a threads argument leaves no comments section', () => {
  const raw = serializeStoryFile({
    frontmatter: { criticality: 'P1', links: [] },
    tabs: [{ name: 'Tab 1', body: 'body' }],
  })
  assert.doesNotMatch(raw, /<!-- comments -->/)
  assert.deepEqual(parseStoryFile(raw).threads, [])
})

test('an anchor round-trips its occurrence number', () => {
  const thread = {
    id: 't_nth',
    tabName: 'Tab 1',
    status: 'open',
    anchor: { quote: 'asdf', prefix: 'a', suffix: 'b', nth: 12 },
    comments: [{ author: 'a@corp.test', at: '2026-08-24T10:00:00Z', body: 'x' }],
  }
  const raw = serializeStoryFile({ frontmatter: { criticality: 'P1', links: [] }, tabs: [], threads: [thread] })
  // A bare number, not a quoted string — it stays readable in the file.
  assert.match(raw, /nth=12/)
  assert.deepEqual(parseStoryFile(raw).threads, [thread])
})

test('an anchor written before nth existed still parses', () => {
  const raw =
    '---\ncriticality: P1\n---\n\n<!-- comments -->\n\n<!-- thread id=t_old status=open quote="asdf" prefix="a" suffix="b" -->\n\n> asdf\n\n- **a@corp.test** \u00b7 2026-01-01T00:00:00Z\n  x\n'
  const [thread] = parseStoryFile(raw).threads
  assert.deepEqual(thread.anchor, { quote: 'asdf', prefix: 'a', suffix: 'b' })
  assert.equal('nth' in thread.anchor, false, 'absent rather than zero, so the resolver skips the tiebreaker')
})

test('a non-numeric or zero nth is dropped rather than trusted', () => {
  const base = (attrs) =>
    `---\ncriticality: P1\n---\n\n<!-- comments -->\n\n<!-- thread id=t_x status=open quote="asdf" ${attrs} -->\n`
  assert.equal('nth' in parseStoryFile(base('nth=oops')).threads[0].anchor, false)
  assert.equal('nth' in parseStoryFile(base('nth=0')).threads[0].anchor, false)
  assert.equal(parseStoryFile(base('nth=3')).threads[0].anchor.nth, 3)
})


// ---- the story marker ---------------------------------------------------------

test('isStoryFile: the marker is the rule', () => {
  assert.equal(isStoryFile('<!-- threadline-story -->\n'), true)
  assert.equal(isStoryFile('---\nlinks:\n---\n\n<!-- threadline-story -->\n'), true)
  // Case-insensitive and tolerant of the whitespace a formatter might add.
  assert.equal(isStoryFile('  <!--  Threadline-Story  -->  \n'), true)

  assert.equal(isStoryFile('# A PRD\n\nProse.\n'), false)
  assert.equal(isStoryFile(''), false)
  assert.equal(isStoryFile('---\ntitle: A spec\n---\n\nProse.\n'), false)
})

test('isStoryFile: legacy structure counts, and a code fence does not', () => {
  // Files written before the marker existed.
  assert.equal(isStoryFile('<!-- tab: Happy -->\n\nok\n'), true)
  assert.equal(isStoryFile('---\ncriticality: P1\n---\n\nnotes\n'), true)
  assert.equal(isStoryFile('<!-- comments -->\n'), true)

  // A document explaining the format quotes it inside a fence — that is
  // content, not a declaration.
  assert.equal(isStoryFile('```md\n<!-- threadline-story -->\n<!-- tab: X -->\n```\n'), false)
})

test('serializeStoryFile writes the marker, and parsing takes it back out', () => {
  const out = serializeStoryFile({ frontmatter: { criticality: 'P1' }, tabs: [] })
  assert.match(out, /^---\ncriticality: P1\n---\n\n<!-- threadline-story -->\n/)
  assert.equal(isStoryFile(out), true)

  // The marker must not survive into the body, or a story with no tab markers
  // would show it as the text of its implicit "Tab 1".
  assert.deepEqual(parseStoryFile(out).tabs, [])

  const withTab = serializeStoryFile({ frontmatter: {}, tabs: [{ name: 'Happy', body: 'ok' }] })
  assert.deepEqual(parseStoryFile(withTab).tabs, [{ name: 'Happy', body: 'ok' }])
  assert.equal(parseStoryFile(withTab).preamble, '', 'the marker is not left behind as a preamble')

  // Round-tripping does not stack a second marker on top of the first.
  const twice = serializeStoryFile({ frontmatter: {}, ...parseStoryFile(withTab) })
  assert.equal(twice.split(STORY_MARKER).length - 1, 1)
})

test('a marker-less body is still read as one implicit tab', () => {
  // The marker is stripped from the lead only; free-form notes below it stay.
  const parsed = parseStoryFile('<!-- threadline-story -->\n\nfree-form notes\n')
  assert.deepEqual(parsed.tabs, [{ name: 'Tab 1', body: 'free-form notes' }])
})
