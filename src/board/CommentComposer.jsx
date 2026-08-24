// Comment composer — a textarea with an `@` typeahead over the users this
// install has seen.
//
// The mention is inserted as the bare address (`@jane@corp.test`), which is
// exactly what gets stored in the markdown: readable to a person, readable to
// an AI, and matchable by the "For You" filter without a parallel index of
// who-was-mentioned-where.

import { useEffect, useMemo, useRef, useState } from 'react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

const MAX_SUGGESTIONS = 6

// The `@partial` immediately before the caret, if the caret is inside one.
// Anchored to a word boundary so an address already typed in full (which
// itself contains an '@') doesn't reopen the menu on its domain half.
function activeMentionQuery(value, caret) {
  const upToCaret = value.slice(0, caret)
  const match = upToCaret.match(/(^|\s)@([^\s@]*)$/)
  if (!match) return null
  return { query: match[2], start: caret - match[2].length - 1 }
}

export default function CommentComposer({
  users = [],
  value,
  onChange,
  onSubmit,
  onCancel,
  placeholder = 'Add a comment…',
  submitLabel = 'Comment',
  autoFocus = false,
}) {
  const textareaRef = useRef(null)
  const [caret, setCaret] = useState(0)
  const [highlighted, setHighlighted] = useState(0)
  // Set when a suggestion is picked or dismissed, so the menu doesn't spring
  // straight back open at the same caret position.
  const [dismissedAt, setDismissedAt] = useState(-1)

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus()
  }, [autoFocus])

  const mention = useMemo(() => {
    const found = activeMentionQuery(value, caret)
    if (!found || found.start === dismissedAt) return null
    return found
  }, [value, caret, dismissedAt])

  const suggestions = useMemo(() => {
    if (!mention) return []
    const q = mention.query.toLowerCase()
    return users
      .filter((email) => email.toLowerCase().includes(q))
      .slice(0, MAX_SUGGESTIONS)
  }, [mention, users])

  useEffect(() => {
    setHighlighted(0)
  }, [mention?.query])

  const open = !!mention && suggestions.length > 0

  function insertMention(email) {
    const before = value.slice(0, mention.start)
    const after = value.slice(caret)
    // Trailing space: the next thing typed shouldn't glue onto the address.
    const next = `${before}@${email} ${after}`
    const nextCaret = mention.start + email.length + 2
    onChange(next)
    setDismissedAt(-1)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(nextCaret, nextCaret)
      setCaret(nextCaret)
    })
  }

  function syncCaret(e) {
    setCaret(e.target.selectionStart ?? 0)
  }

  function onKeyDown(e) {
    if (open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlighted((i) => (i + 1) % suggestions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlighted((i) => (i - 1 + suggestions.length) % suggestions.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        insertMention(suggestions[highlighted])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setDismissedAt(mention.start)
        return
      }
    }

    // Enter submits, Shift+Enter is a newline — the convention everywhere else
    // comments are written.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (value.trim()) onSubmit()
      return
    }
    if (e.key === 'Escape' && onCancel) {
      e.preventDefault()
      onCancel()
    }
  }

  return (
    <div className="relative">
      <textarea
        ref={textareaRef}
        className="border-input focus-visible:border-ring focus-visible:ring-ring/50 placeholder:text-muted-foreground field-sizing-content min-h-16 w-full resize-none rounded-md border bg-transparent px-2 py-1.5 text-[13px] outline-none focus-visible:ring-[3px]"
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value)
          setCaret(e.target.selectionStart ?? 0)
        }}
        onKeyUp={syncCaret}
        onClick={syncCaret}
        onKeyDown={onKeyDown}
      />

      {open && (
        <ul
          className="bg-popover text-popover-foreground absolute bottom-full z-50 mb-1 max-h-48 w-full overflow-y-auto rounded-md border p-1 shadow-md"
          role="listbox"
        >
          {suggestions.map((email, i) => (
            <li key={email}>
              <button
                type="button"
                role="option"
                aria-selected={i === highlighted}
                className={cn(
                  'w-full cursor-pointer truncate rounded-sm px-2 py-1 text-left text-[13px]',
                  i === highlighted ? 'bg-accent text-accent-foreground' : '',
                )}
                onMouseEnter={() => setHighlighted(i)}
                // mousedown, not click: the textarea's blur would otherwise
                // close the menu before the click landed.
                onMouseDown={(e) => {
                  e.preventDefault()
                  insertMention(email)
                }}
              >
                {email}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-1.5 flex items-center justify-end gap-1.5">
        {onCancel && (
          <Button variant="ghost" size="xs" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button size="xs" disabled={!value.trim()} onClick={onSubmit}>
          {submitLabel}
        </Button>
      </div>
    </div>
  )
}
