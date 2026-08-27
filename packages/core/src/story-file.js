// Story file format — the on-disk representation of one story.
//
// A story is a `.s.md` file — the extension is what separates it from any
// other markdown sitting in the same workspace folder (see repo.js). The
// `<!-- threadline-story -->` marker is still written into every story, so a
// file that has been renamed out of its extension can still be recognized for
// what it is — see isStoryFile() below.
//
//   ---
//   criticality: P1
//   links:
//     - {url: "https://www.figma.com/proto/abc", tag: Design, color: violet}
//     - {url: "https://docs.google.com/spreadsheets/d/xyz"}
//     - https://a-link-saved-before-tags-existed.test
//   ---
//
//   <!-- threadline-story -->
//
//   <!-- tab: Happy path -->
//   Preconditions: ...
//
//   <!-- tab: Wrong password -->
//   ...
//
// Frontmatter is a hand-rolled YAML subset (scalars + block lists whose items
// are scalars or single-line flow maps) deliberately, not a `js-yaml`
// dependency: the only fields today are `criticality` (scalar) and `links`
// (list), so a full YAML parser would be pure overhead. Unknown frontmatter
// keys are preserved on write so a story file can carry extra hand-added
// fields without this code understanding them.
//
// Tabs are delimited by `<!-- tab: Name -->` marker lines (the tabs shown in
// the story panel). An HTML comment is used rather than a markdown heading so
// authors are free to use `#`/`##` headings inside a tab body, and so the
// marker stays invisible when the file is rendered anywhere else. A file with
// no marker at all is treated as a single tab named "Tab 1". Markers inside
// fenced code blocks (```) are not treated as tab boundaries.
//
// A `<!-- comments -->` marker ends the tab region and opens the comment
// threads section, which runs to the end of the file:
//
//   <!-- comments -->
//
//   <!-- thread id=t_k3f9a2 tab="Happy path" status=open quote="log in" ... -->
//   > log in
//
//   - **jane@corp.test** · 2026-08-24T08:17:04Z
//     @ian@corp.test is this the right screen?
//   - **ian@corp.test** · 2026-08-24T09:02:11Z
//     yes
//
// The blockquote and the prose ARE the payload for anything reading this file
// as prose (an AI, a diff, a markdown renderer): they show what was commented
// on and what was said without parsing anything. The machine fields live in
// the one-line `<!-- thread ... -->` marker, invisible when rendered. Thread
// anchors are text-quote selectors (quote + surrounding context), not
// character offsets, so an edit elsewhere in the tab doesn't shift them.

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

// `<!-- threadline-story -->` on a line of its own, written directly under the
// frontmatter — the file's declaration that it IS a Threadline story and not
// merely a markdown file that happens to live in the workspace. The `.s.md`
// extension is what the app routes on; this makes the file say the same thing
// from the inside, so a story copied to a plain `.md` name (or written before
// the extension existed) is still identifiable as one.
//
// An HTML comment rather than a frontmatter key, for the same reasons the case
// and comment markers are: it stays invisible in every markdown renderer, it
// survives a file with no frontmatter at all, and the format already speaks in
// exactly this idiom.
export const STORY_MARKER = '<!-- threadline-story -->'
const STORY_MARKER_RE = /^[ \t]*<!--[ \t]*threadline-story[ \t]*-->[ \t]*$/i

// `<!-- tab: Name -->` on a line of its own. Case-insensitive on the keyword
// so a hand-typed `<!-- Tab: ... -->` still registers.
const TAB_MARKER_RE = /^[ \t]*<!--[ \t]*(tab|case):[ \t]*(.+?)[ \t]*-->[ \t]*$/i

// `<!-- comments -->` on a line of its own — ends the case region.
const COMMENTS_MARKER_RE = /^[ \t]*<!--[ \t]*comments[ \t]*-->[ \t]*$/i

// One thread header: `<!-- thread id=... case="..." status=open ... -->`.
const THREAD_MARKER_RE = /^[ \t]*<!--[ \t]*thread[ \t]+(.+?)[ \t]*-->[ \t]*$/i

// One comment: `- **author@corp.test** · 2026-08-24T08:17:04Z`, its body on
// the following 2-space-indented lines (a plain markdown list-item
// continuation, so the section renders correctly anywhere).
const COMMENT_HEAD_RE = /^-[ \t]+\*\*(.+?)\*\*[ \t]*·[ \t]*(\S+)[ \t]*$/

export const THREAD_STATUSES = ['open', 'resolved']


function parseYamlSubset(text) {
  const lines = text.split(/\r?\n/)
  const result = {}
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (!m) { i++; continue }
    const [, key, rest] = m
    if (rest.trim()) {
      result[key] = unquote(rest.trim())
      i++
      continue
    }
    // Block list: subsequent lines of the form `  - item`.
    const items = []
    let j = i + 1
    while (j < lines.length && /^\s*-\s*(.*)$/.test(lines[j])) {
      items.push(parseListItem(lines[j].match(/^\s*-\s*(.*)$/)[1].trim()))
      j++
    }
    result[key] = items
    i = j
  }
  return result
}

// A list item is either a scalar or a single-line flow map — `{url: "…", tag: x}`,
// which is how a tagged link is stored. Anything that isn't brace-wrapped stays a
// scalar, so links written before tags existed keep parsing as plain URLs.
function parseListItem(raw) {
  if (!(raw.startsWith('{') && raw.endsWith('}'))) return unquote(raw)
  const obj = {}
  for (const pair of splitTopLevel(raw.slice(1, -1))) {
    const at = pair.indexOf(':')
    if (at === -1) continue
    const key = pair.slice(0, at).trim()
    if (key) obj[key] = unquote(pair.slice(at + 1).trim())
  }
  return obj
}

// Split on commas that aren't inside a quoted value — a URL with a comma in it
// must not be read as two pairs.
function splitTopLevel(text) {
  const parts = []
  let current = ''
  let quote = ''
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = ''
      current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
    } else if (ch === ',') {
      parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  parts.push(current)
  return parts
}

function unquote(raw) {
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1)
  }
  return raw
}

function yamlScalar(value) {
  const str = String(value)
  if (str === '' || /^[\s]|[\s]$/.test(str) || /[:#]/.test(str)) {
    return JSON.stringify(str)
  }
  return str
}

// Inside a flow map the structural characters matter too, so a value carrying
// any of them has to be quoted on top of what `yamlScalar` already catches.
function yamlFlowScalar(value) {
  const str = String(value)
  if (/[,{}[\]]/.test(str)) return JSON.stringify(str)
  return yamlScalar(str)
}

function yamlListItem(item) {
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const pairs = Object.entries(item).map(([k, v]) => `${k}: ${yamlFlowScalar(v)}`)
    return `{${pairs.join(', ')}}`
  }
  return yamlScalar(item)
}

function serializeYaml(obj) {
  const lines = []
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`)
      for (const item of value) lines.push(`  - ${yamlListItem(item)}`)
    } else {
      lines.push(`${key}: ${yamlScalar(value)}`)
    }
  }
  return lines.join('\n')
}

// Strip surrounding blank lines without touching trailing spaces on the first
// and last content lines — a bare task item serializes as `* [ ] ` and GFM only
// parses the checkbox when that space survives.
function trimBlankLines(text) {
  return text.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/(?:\r?\n[ \t]*)+$/, '')
}

// Split a story body into tabs at `<!-- tab: Name -->` markers, skipping any
// found inside fenced (```) code blocks.
function splitTabs(body) {
  const lines = body.split(/\r?\n/)
  const headings = []
  let inFence = false
  lines.forEach((line, idx) => {
    if (/^\s*```/.test(line)) { inFence = !inFence; return }
    if (inFence) return
    const m = line.match(TAB_MARKER_RE)
    if (m) headings.push({ line: idx, name: m[2].trim() })
  })

  if (!headings.length) {
    const trimmed = trimBlankLines(body)
    // No markers at all: a brand-new story has zero tabs (nothing to
    // show as a tab yet); a plain-text body with no tab structure is read as
    // one implicit tab, so pre-existing free-form notes aren't discarded.
    return { preamble: '', tabs: body.trim() ? [{ name: 'Tab 1', body: trimmed }] : [] }
  }

  const preamble = lines.slice(0, headings[0].line).join('\n').trim()
  const tabs = headings.map((h, i) => {
    const start = h.line + 1
    const end = i + 1 < headings.length ? headings[i + 1].line : lines.length
    return { name: h.name, body: trimBlankLines(lines.slice(start, end).join('\n')) }
  })
  return { preamble, tabs }
}


// ---- comment threads --------------------------------------------------------

// Thread marker attributes: `key=bare` or `key="json string"`. Values that can
// contain spaces, quotes or newlines (case name, anchor text) are always
// JSON-quoted, so the marker survives as one line whatever the user selected.
function parseAttrs(text) {
  const attrs = {}
  const re = /([A-Za-z_][\w-]*)=("(?:[^"\\]|\\.)*"|\S+)/g
  let m
  while ((m = re.exec(text))) {
    const [, key, raw] = m
    if (raw.startsWith('"')) {
      try {
        attrs[key] = JSON.parse(raw)
      } catch {
        attrs[key] = raw.slice(1, -1)
      }
    } else {
      attrs[key] = raw
    }
  }
  return attrs
}

// `id` and `status` are known-safe bare tokens; everything else is JSON-quoted
// unconditionally, because free text needs the quoting to be predictable
// rather than value-dependent. A literal `-->` inside a value would end the
// HTML comment early, so it goes out as a `>` escape — JSON.parse turns
// it back into '>' on read, and no bare `-->` ever reaches the file.
const BARE_ATTRS = new Set(['id', 'status', 'nth'])

function serializeAttrs(pairs) {
  return pairs
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => {
      if (BARE_ATTRS.has(key) && /^[\w.:+-]+$/.test(String(value))) return `${key}=${value}`
      return `${key}=${JSON.stringify(String(value)).replace(/>/g, '\\u003e')}`
    })
    .join(' ')
}

// Find the `<!-- comments -->` line (ignoring any inside a fenced block) and
// cut the body there. No marker -> everything is tab region, no threads.
function splitCommentSection(body) {
  const lines = body.split(/\r?\n/)
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue }
    if (inFence) continue
    if (COMMENTS_MARKER_RE.test(lines[i])) {
      return { tabRegion: lines.slice(0, i).join('\n'), commentRegion: lines.slice(i + 1).join('\n') }
    }
  }
  return { tabRegion: body, commentRegion: '' }
}

// The `> quoted text` blockquote and the comment prose are a human/AI-readable
// mirror of the marker's fields, so the blockquote is skipped on read — the
// anchor always comes from the marker, which can carry newlines and context
// the blockquote can't.
function parseThreads(region) {
  const lines = region.split(/\r?\n/)
  const threads = []
  let thread = null
  let comment = null

  const flushComment = () => {
    if (!thread || !comment) return
    thread.comments.push({ ...comment, body: trimBlankLines(comment.body.join('\n')) })
    comment = null
  }

  for (const line of lines) {
    const markerMatch = line.match(THREAD_MARKER_RE)
    if (markerMatch) {
      flushComment()
      const a = parseAttrs(markerMatch[1])
      thread = {
        id: a.id || '',
        tabName: a.tab || a.case || '',
        status: a.status === 'resolved' ? 'resolved' : 'open',
        anchor: a.quote
          ? {
              quote: a.quote,
              prefix: a.prefix || '',
              suffix: a.suffix || '',
              // Absent on anchors written before `nth` existed; the resolver
              // treats a missing value as "no tiebreaker available".
              ...(Number.isInteger(Number(a.nth)) && Number(a.nth) > 0 ? { nth: Number(a.nth) } : {}),
            }
          : null,
        comments: [],
      }
      if (thread.id) threads.push(thread)
      continue
    }
    if (!thread) continue

    const headMatch = line.match(COMMENT_HEAD_RE)
    if (headMatch) {
      flushComment()
      comment = { author: headMatch[1].trim(), at: headMatch[2].trim(), body: [] }
      continue
    }
    // A comment body line: the 2-space list-item indent, stripped back off.
    if (comment) comment.body.push(line.replace(/^ {1,4}/, ''))
  }
  flushComment()
  return threads
}

function serializeThreads(threads) {
  const blocks = []
  for (const t of threads) {
    if (!t?.id) continue
    const marker = serializeAttrs([
      ['id', t.id],
      ['tab', t.tabName || ''],
      ['status', t.status === 'resolved' ? 'resolved' : 'open'],
      ['quote', t.anchor?.quote || ''],
      ['prefix', t.anchor?.prefix || ''],
      ['suffix', t.anchor?.suffix || ''],
      ['nth', t.anchor?.nth || ''],
    ])
    const parts = [`<!-- thread ${marker} -->`]
    if (t.anchor?.quote) {
      parts.push(t.anchor.quote.split(/\r?\n/).map((l) => `> ${l}`).join('\n>\n'))
    }
    for (const c of t.comments || []) {
      // Indent every body line by two spaces so multi-line and multi-paragraph
      // comments stay inside their list item as GFM parses it.
      const body = String(c.body || '')
        .split(/\r?\n/)
        .map((l) => (l.trim() ? `  ${l}` : ''))
        .join('\n')
      parts.push(`- **${c.author}** \u00b7 ${c.at}\n${body}`)
    }
    blocks.push(parts.join('\n\n'))
  }
  return blocks.join('\n\n')
}

// Does the TEXT of this markdown file claim to be a Threadline story?
//
// NOT what decides a tree row's kind — that is the `.s.md` extension, and this
// is deliberately never consulted there: two definitions of "is a story" that
// can disagree is exactly the thing the extension exists to end. This answers
// the different question of what an arbitrary markdown file's contents are, so
// a story written before the extension existed (or copied to a `.md` name) can
// be found and renamed rather than quietly read as a document.
//
// The `<!-- threadline-story -->` marker is the rule. The two fallbacks below
// exist for files written before the marker did — every story this app has
// ever saved carries either an explicit tab/comments marker or a
// `criticality` frontmatter key, and both are structure no plain document
// would have.
//
// Deliberately NOT a signal: having a body at all. splitTabs() reads a
// marker-less body as one implicit "Tab 1", so "it parsed into a tab" is
// true of literally every markdown file and says nothing.
export function isStoryFile(raw) {
  const text = String(raw || '')
  const fmMatch = text.match(FRONTMATTER_RE)
  const frontmatter = fmMatch ? parseYamlSubset(fmMatch[1]) : {}
  const body = fmMatch ? text.slice(fmMatch[0].length) : text

  let inFence = false
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (STORY_MARKER_RE.test(line) || TAB_MARKER_RE.test(line) || COMMENTS_MARKER_RE.test(line)) return true
  }
  return frontmatter.criticality !== undefined
}

// Take the marker line back out of the body before it is split into tabs —
// left in, a story with no tab markers would parse it as the text of its
// implicit "Tab 1" and show `<!-- threadline-story -->` as the tab body.
// Only the first one, and only ahead of any tab/comments marker: past that
// point it is content (a document about this format, quoting it).
function stripStoryMarker(body) {
  const lines = body.split(/\r?\n/)
  let inFence = false
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (TAB_MARKER_RE.test(lines[i]) || COMMENTS_MARKER_RE.test(lines[i])) return body
    if (STORY_MARKER_RE.test(lines[i])) {
      lines.splice(i, 1)
      return lines.join('\n')
    }
  }
  return body
}

// raw (string) → { frontmatter: {criticality, links, ...unknown}, preamble, tabs: [{name, body}] }
export function parseStoryFile(raw) {
  const text = raw || ''
  const fmMatch = text.match(FRONTMATTER_RE)
  const frontmatter = fmMatch ? parseYamlSubset(fmMatch[1]) : {}
  const body = stripStoryMarker(fmMatch ? text.slice(fmMatch[0].length) : text)
  const { tabRegion, commentRegion } = splitCommentSection(body)
  const { preamble, tabs } = splitTabs(tabRegion)
  if (!Array.isArray(frontmatter.links)) {
    frontmatter.links = frontmatter.links ? [frontmatter.links] : []
  }
  return { frontmatter, preamble, tabs, threads: parseThreads(commentRegion) }
}

// { frontmatter, preamble, tabs, threads } → raw file text
export function serializeStoryFile({ frontmatter = {}, preamble = '', tabs = [], threads = [] }) {
  const fm = serializeYaml(frontmatter)
  const parts = []
  if (preamble.trim()) parts.push(preamble.trim())
  for (const t of tabs) {
    parts.push(trimBlankLines(`<!-- tab: ${t.name} -->\n\n${t.body || ''}`))
  }
  const threadText = serializeThreads(threads)
  if (threadText) parts.push(`<!-- comments -->\n\n${threadText}`)
  const body = parts.join('\n\n')
  // The marker goes in unconditionally: this is the story serializer, so
  // anything it writes is a story — including a legacy file that reached here
  // without one, which is how those get migrated.
  return `---\n${fm}\n---\n\n${STORY_MARKER}\n\n${body ? body + '\n' : ''}`
}
