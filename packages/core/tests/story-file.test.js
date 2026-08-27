// story-file tests — frontmatter parsing/serialization and `<!-- case: -->`
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

<!-- case: Happy path -->

Preconditions: registered user.
Steps: log in.

<!-- case: Wrong password -->

Expected: error shown.
`
  const { frontmatter, cases } = parseStoryFile(raw)
  assert.equal(frontmatter.criticality, 'P2')
  assert.deepEqual(frontmatter.links, [
    'https://www.figma.com/proto/abc',
    'https://docs.google.com/spreadsheets/d/xyz',
  ])
  assert.equal(cases.length, 2)
  assert.equal(cases[0].name, 'Happy path')
  assert.match(cases[0].body, /registered user/)
  assert.equal(cases[1].name, 'Wrong password')
})

test('a file with no markers and no body has zero cases', () => {
  const raw = '---\ncriticality: P1\nlinks: []\n---\n\n'
  const { cases } = parseStoryFile(raw)
  assert.deepEqual(cases, [])
})

test('a file with no markers but a body is read as one implicit case', () => {
  const raw = '---\ncriticality: P1\n---\n\nSome free-form notes.\n'
  const { cases } = parseStoryFile(raw)
  assert.equal(cases.length, 1)
  assert.equal(cases[0].name, 'Case 1')
  assert.match(cases[0].body, /free-form notes/)
})

test('missing frontmatter yields empty frontmatter, not a crash', () => {
  const { frontmatter, cases } = parseStoryFile('<!-- case: Only case -->\nbody text\n')
  assert.deepEqual(frontmatter.links, [])
  assert.equal(cases.length, 1)
  assert.equal(cases[0].name, 'Only case')
})

test('a marker inside a fenced code block is not a case boundary', () => {
  const raw = `---\ncriticality: P1\n---\n\n<!-- case: Real case -->\n\n\`\`\`\n<!-- case: not a marker -->\n\`\`\`\nmore text\n`
  const { cases } = parseStoryFile(raw)
  assert.equal(cases.length, 1)
  assert.equal(cases[0].name, 'Real case')
  assert.match(cases[0].body, /not a marker/)
})

test('markdown headings inside a case body are not case boundaries', () => {
  const raw = `---\ncriticality: P1\n---\n\n<!-- case: Real case -->\n\n## Steps\n1. log in\n\n### Expected\nhome screen\n`
  const { cases } = parseStoryFile(raw)
  assert.equal(cases.length, 1)
  assert.equal(cases[0].name, 'Real case')
  assert.match(cases[0].body, /## Steps/)
  assert.match(cases[0].body, /### Expected/)
})

test('serializeStoryFile round-trips through parseStoryFile', () => {
  const original = {
    frontmatter: { criticality: 'P3', links: ['https://a.test', 'https://b.test'] },
    cases: [
      { name: 'Case A', body: 'Step 1\nStep 2' },
      { name: 'Case B', body: 'Other steps' },
    ],
  }
  const raw = serializeStoryFile(original)
  const parsed = parseStoryFile(raw)
  assert.equal(parsed.frontmatter.criticality, 'P3')
  assert.deepEqual(parsed.frontmatter.links, original.frontmatter.links)
  assert.deepEqual(parsed.cases, original.cases)
})

test('parses flow-map list items (tagged links) alongside bare strings', () => {
  const raw = `---
criticality: P1
links:
  - {url: "https://www.figma.com/proto/abc", tag: Design, color: purple}
  - {url: "https://docs.google.com/d/xyz"}
  - https://saved-before-tags-existed.test
---

<!-- case: Case 1 -->
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
    cases: [{ name: 'Case A', body: 'Step 1' }],
  }
  const raw = serializeStoryFile(original)
  const parsed = parseStoryFile(raw)
  assert.deepEqual(parsed.frontmatter.links, original.frontmatter.links)
  assert.deepEqual(parsed.cases, original.cases)
})

test('unknown frontmatter keys are preserved through round-trip', () => {
  const raw = '---\ncriticality: P1\nlinks: []\nowner: "jane"\n---\n\n<!-- case: Case 1 -->\nbody\n'
  const { frontmatter, cases } = parseStoryFile(raw)
  assert.equal(frontmatter.owner, 'jane')
  const rewritten = serializeStoryFile({ frontmatter, cases })
  assert.match(rewritten, /owner: jane/)
})

// ---- comment threads --------------------------------------------------------

test('parses a comment thread: marker fields, anchor and comments', () => {
  const raw = `---
criticality: P1
links: []
---

<!-- case: Happy path -->

Preconditions: registered user.
Steps: log in.

<!-- comments -->

<!-- thread id=t_abc case="Happy path" status=open quote="log in" prefix="Steps: " suffix="." -->

> log in

- **jane@corp.test** · 2026-08-24T08:17:04Z
  @ian@corp.test is this the right screen?

- **ian@corp.test** · 2026-08-24T09:02:11Z
  yes it is
`
  const { cases, threads } = parseStoryFile(raw)
  // The comments section must not leak into the case body.
  assert.equal(cases.length, 1)
  assert.equal(cases[0].body, 'Preconditions: registered user.\nSteps: log in.')

  assert.equal(threads.length, 1)
  const t = threads[0]
  assert.equal(t.id, 't_abc')
  assert.equal(t.caseName, 'Happy path')
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
    caseName: '',
    status: 'open',
    anchor: null,
    comments: [{ author: 'a@corp.test', at: '2026-08-24T10:00:00Z', body: 'general note' }],
  }
  const raw = serializeStoryFile({ frontmatter: { criticality: 'P1', links: [] }, cases: [], threads: [thread] })
  assert.doesNotMatch(raw, /^>/m)
  assert.deepEqual(parseStoryFile(raw).threads, [thread])
})

test('anchor text containing --> does not terminate the thread marker', () => {
  const thread = {
    id: 't_1',
    caseName: 'Case 1',
    status: 'open',
    anchor: { quote: 'ends with --> here', prefix: '', suffix: '' },
    comments: [{ author: 'a@corp.test', at: '2026-08-24T10:00:00Z', body: 'x' }],
  }
  const raw = serializeStoryFile({ frontmatter: { criticality: 'P1', links: [] }, cases: [], threads: [thread] })
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
    caseName: 'Case "A"',
    status: 'resolved',
    anchor: { quote: 'say "hi"', prefix: 'a\nb', suffix: 'C:\\path\\to' },
    comments: [{ author: 'a@corp.test', at: '2026-08-24T10:00:00Z', body: 'line1\nline2\n\npara2' }],
  }
  const raw = serializeStoryFile({ frontmatter: { criticality: 'P1', links: [] }, cases: [], threads: [thread] })
  assert.deepEqual(parseStoryFile(raw).threads, [thread])
})

test('an unknown status falls back to open', () => {
  const raw = '---\ncriticality: P1\n---\n\n<!-- comments -->\n\n<!-- thread id=t_x status=weird quote="q" -->\n'
  assert.equal(parseStoryFile(raw).threads[0].status, 'open')
})

test('a thread marker with no id is skipped, not half-parsed', () => {
  const raw = '---\ncriticality: P1\n---\n\n<!-- comments -->\n\n<!-- thread case="Case 1" status=open -->\n\n- **a@b.test** · 2026-01-01T00:00:00Z\n  orphan\n'
  assert.deepEqual(parseStoryFile(raw).threads, [])
})

test('a comments marker inside a fenced code block is not a section boundary', () => {
  const raw = '---\ncriticality: P1\n---\n\n<!-- case: Case 1 -->\n\n```\n<!-- comments -->\n```\n'
  const { cases, threads } = parseStoryFile(raw)
  assert.equal(cases.length, 1)
  assert.match(cases[0].body, /<!-- comments -->/)
  assert.deepEqual(threads, [])
})

test('a file with threads but no cases keeps both regions distinct', () => {
  const thread = {
    id: 't_3',
    caseName: '',
    status: 'open',
    anchor: null,
    comments: [{ author: 'a@corp.test', at: '2026-08-24T10:00:00Z', body: 'note' }],
  }
  const raw = serializeStoryFile({ frontmatter: { criticality: 'P1', links: [] }, cases: [], threads: [thread] })
  const parsed = parseStoryFile(raw)
  assert.deepEqual(parsed.cases, [])
  assert.deepEqual(parsed.threads, [thread])
})

test('serializing without a threads argument leaves no comments section', () => {
  const raw = serializeStoryFile({
    frontmatter: { criticality: 'P1', links: [] },
    cases: [{ name: 'Case 1', body: 'body' }],
  })
  assert.doesNotMatch(raw, /<!-- comments -->/)
  assert.deepEqual(parseStoryFile(raw).threads, [])
})

test('an anchor round-trips its occurrence number', () => {
  const thread = {
    id: 't_nth',
    caseName: 'Case 1',
    status: 'open',
    anchor: { quote: 'asdf', prefix: 'a', suffix: 'b', nth: 12 },
    comments: [{ author: 'a@corp.test', at: '2026-08-24T10:00:00Z', body: 'x' }],
  }
  const raw = serializeStoryFile({ frontmatter: { criticality: 'P1', links: [] }, cases: [], threads: [thread] })
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
  assert.equal(isStoryFile('<!-- case: Happy -->\n\nok\n'), true)
  assert.equal(isStoryFile('---\ncriticality: P1\n---\n\nnotes\n'), true)
  assert.equal(isStoryFile('<!-- comments -->\n'), true)

  // A document explaining the format quotes it inside a fence — that is
  // content, not a declaration.
  assert.equal(isStoryFile('```md\n<!-- threadline-story -->\n<!-- case: X -->\n```\n'), false)
})

test('serializeStoryFile writes the marker, and parsing takes it back out', () => {
  const out = serializeStoryFile({ frontmatter: { criticality: 'P1' }, cases: [] })
  assert.match(out, /^---\ncriticality: P1\n---\n\n<!-- threadline-story -->\n/)
  assert.equal(isStoryFile(out), true)

  // The marker must not survive into the body, or a story with no case markers
  // would show it as the text of its implicit "Case 1".
  assert.deepEqual(parseStoryFile(out).cases, [])

  const withCase = serializeStoryFile({ frontmatter: {}, cases: [{ name: 'Happy', body: 'ok' }] })
  assert.deepEqual(parseStoryFile(withCase).cases, [{ name: 'Happy', body: 'ok' }])
  assert.equal(parseStoryFile(withCase).preamble, '', 'the marker is not left behind as a preamble')

  // Round-tripping does not stack a second marker on top of the first.
  const twice = serializeStoryFile({ frontmatter: {}, ...parseStoryFile(withCase) })
  assert.equal(twice.split(STORY_MARKER).length - 1, 1)
})

test('a marker-less body is still read as one implicit case', () => {
  // The marker is stripped from the lead only; free-form notes below it stay.
  const parsed = parseStoryFile('<!-- threadline-story -->\n\nfree-form notes\n')
  assert.deepEqual(parsed.cases, [{ name: 'Case 1', body: 'free-form notes' }])
})
