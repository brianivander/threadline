// The board's comment panel — the third column, toggled from the story
// panel's header.
//
// Two tabs and two dropdowns, which compose:
//   All Comments / For You     — For You is threads @mentioning the current
//                                user, anywhere in the workspace
//   All stories / This story   — scope
//   Open / Resolved / All      — status. Defaults to Open, so resolved threads
//                                are out of the way but one click back.
//
// Every row comes from the SQLite index (see useComments), so a card can name
// a story that isn't open. Clicking one navigates there — and once its story
// is open, the card shows the full conversation rather than the indexed
// preview, because that's when the full thread has actually been read from
// the file.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, CornerDownRight, MessageSquarePlus, MoreHorizontal, RotateCcw, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button, buttonVariants } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import CommentComposer from '@/board/CommentComposer'

// Two copies of one pattern: split() needs the capturing group, and the
// per-part test must NOT be global — a global regex carries `lastIndex`
// between calls, so testing each part in turn would match every other one.
const MENTION_PATTERN = '@[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}'
const MENTION_SPLIT_RE = new RegExp(`(${MENTION_PATTERN})`, 'g')
const MENTION_TEST_RE = new RegExp(`^${MENTION_PATTERN}$`)

// "8:17 AM Today" for today, "8:17 AM Yesterday", else "8:17 AM Aug 24".
function formatWhen(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return `${time} Today`
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return `${time} Yesterday`
  return `${time} ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

// Mentions are plain text in the markdown; they're only styled on the way out.
function renderBody(text) {
  return String(text || '')
    .split(MENTION_SPLIT_RE)
    .map((part, i) =>
      MENTION_TEST_RE.test(part) ? (
        <span key={i} className="text-primary font-medium">
          {part}
        </span>
      ) : (
        <span key={i}>{part}</span>
      ),
    )
}

function CommentRow({ comment }) {
  return (
    <div className="mt-2.5 first:mt-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[13px] font-semibold">{comment.author}</span>
        <span className="text-muted-foreground shrink-0 text-[11px]">{formatWhen(comment.at)}</span>
      </div>
      <p className="mt-0.5 text-[13px] whitespace-pre-wrap break-words">{renderBody(comment.body)}</p>
    </div>
  )
}

function ThreadCard({
  thread,
  isCurrentStory,
  userEmail,
  users,
  isActive,
  isReplying,
  onActivate,
  onOpenStory,
  onStartReply,
  onCancelReply,
  onReply,
  onResolve,
  onReopen,
  onDelete,
}) {
  const [draft, setDraft] = useState('')
  const resolved = thread.status === 'resolved'
  // An indexed row carries a one-line preview; the full conversation is only
  // available once the thread's story has been read from disk.
  const comments = thread.comments || null
  // An open story's thread carries its parsed anchor; an indexed row from
  // another story carries only the flat `quote` column — which is the only
  // thing that lets a cross-story card show the text being commented on
  // without reading that story's file.
  const quote = thread.anchor?.quote || thread.quote || ''
  // Where the comment lives. A story has several case tabs, so naming the case
  // is the difference between "somewhere in Login" and a place you can go —
  // and clicking this opens exactly that tab.
  const location = [thread.story_title, thread.case_name].filter(Boolean).join(' · ')

  useEffect(() => {
    if (!isReplying) setDraft('')
  }, [isReplying])

  // Clicking a highlight in the editor focuses a card that may be well below
  // the fold, so bring it into view. 'nearest' rather than 'center' so a card
  // already visible doesn't jump.
  const cardRef = useRef(null)
  useEffect(() => {
    if (isActive) cardRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [isActive])

  return (
    <div
      ref={cardRef}
      className={cn(
        'bg-muted/50 cursor-pointer rounded-md border p-2.5 transition-colors',
        isActive ? 'border-primary' : 'border-transparent hover:border-border',
        resolved ? 'opacity-70' : '',
      )}
      onClick={() => onActivate(thread)}
    >
      {/* The story name is its own control, not decoration: it's the obvious
          way to say "take me there", and it reads as a link so that's
          discoverable without clicking to find out. Shown on every card, not
          just cross-story ones, so the affordance never moves around. */}
      {thread.story_title && (
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground mb-1.5 block max-w-full cursor-pointer truncate text-left text-[11px] font-medium hover:underline"
          title={`${isCurrentStory ? 'Go to' : 'Open'} ${location}`}
          onClick={(e) => {
            // The card's own click would fire too, doing the same navigation
            // twice.
            e.stopPropagation()
            onOpenStory(thread)
          }}
        >
          {location}
        </button>
      )}

      <div className="mb-1 flex items-start justify-between gap-1">
        <div className="min-w-0 flex-1">
          {quote && (
            <div className="text-muted-foreground border-muted-foreground/40 mb-1.5 truncate border-l-2 pl-2 text-[12px] italic">
              {quote}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center">
          <Button
            variant="ghost"
            size="icon-xs"
            className={resolved ? 'text-primary' : ''}
            aria-label={resolved ? 'Reopen thread' : 'Resolve thread'}
            title={resolved ? 'Reopen' : 'Resolve'}
            onClick={(e) => {
              e.stopPropagation()
              resolved ? onReopen(thread) : onResolve(thread)
            }}
          >
            {resolved ? <RotateCcw /> : <Check />}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Thread actions"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
              <DropdownMenuItem onSelect={() => onStartReply(thread)}>Reply</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => (resolved ? onReopen(thread) : onResolve(thread))}>
                {resolved ? 'Reopen' : 'Resolve'}
              </DropdownMenuItem>
              {/* Only the author can delete — the API refuses anyone else, so
                  the option isn't offered where it would just fail. */}
              {thread.author === userEmail && (
                <DropdownMenuItem variant="destructive" onSelect={() => onDelete(thread)}>
                  Delete
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {comments ? (
        comments.map((c, i) => <CommentRow key={i} comment={c} />)
      ) : (
        <>
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-[13px] font-semibold">{thread.author}</span>
            <span className="text-muted-foreground shrink-0 text-[11px]">{formatWhen(thread.updated_at)}</span>
          </div>
          <p className="mt-0.5 line-clamp-3 text-[13px] break-words">{renderBody(thread.preview)}</p>
          {thread.reply_count > 0 && (
            <div className="text-muted-foreground mt-1 text-[11px]">
              {thread.reply_count} {thread.reply_count === 1 ? 'reply' : 'replies'}
            </div>
          )}
        </>
      )}

      {isReplying ? (
        <div className="mt-2" onClick={(e) => e.stopPropagation()}>
          <CommentComposer
            users={users}
            value={draft}
            onChange={setDraft}
            onSubmit={() => onReply(thread, draft)}
            onCancel={onCancelReply}
            placeholder="Reply…"
            submitLabel="Reply"
            autoFocus
          />
        </div>
      ) : (
        isCurrentStory && (
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground mt-1.5"
            onClick={(e) => {
              e.stopPropagation()
              onStartReply(thread)
            }}
          >
            <CornerDownRight />
            Reply
          </Button>
        )
      )}
    </div>
  )
}

export default function CommentsPanel({
  storyId,
  storyTitle,
  storyThreads = [],
  repoThreads = [],
  users = [],
  userEmail,
  error,
  activeThreadId,
  pendingAnchor,
  onClose,
  onSelectStory,
  onActivateThread,
  onClearPendingAnchor,
  onSetMentionsOnly,
  actions,
}) {
  const [tab, setTab] = useState('all')
  const [scope, setScope] = useState('story')
  // Resolved threads are out of sight until asked for — the panel is for what
  // still needs attention.
  const [status, setStatus] = useState('open')
  const [replyingTo, setReplyingTo] = useState(null)
  const [composing, setComposing] = useState(false)
  const [draft, setDraft] = useState('')
  // Deleting a thread destroys the whole conversation and can't be undone, so
  // it's confirmed — the same treatment every other delete in the board gets.
  const [pendingDelete, setPendingDelete] = useState(null)

  // "For You" spans the workspace by definition — a mention you have to go
  // looking for story by story isn't an inbox.
  useEffect(() => {
    onSetMentionsOnly(tab === 'you')
    if (tab === 'you') setScope('all')
  }, [tab, onSetMentionsOnly])

  // A selection arriving from the editor's right-click → Comment opens the
  // composer with that anchor attached.
  useEffect(() => {
    if (pendingAnchor) {
      setComposing(true)
      setReplyingTo(null)
    }
  }, [pendingAnchor])

  const byId = useMemo(() => new Map(storyThreads.map((t) => [t.id, t])), [storyThreads])

  const rows = useMemo(() => {
    let list = repoThreads
    if (scope === 'story') list = list.filter((t) => t.story_id === storyId)
    if (status !== 'all') list = list.filter((t) => t.status === status)
    // Swap in the full thread wherever we have it: same row, real conversation.
    return list.map((t) => byId.get(t.id) ? { ...t, ...byId.get(t.id) } : t)
  }, [repoThreads, scope, status, storyId, byId])

  function submitNew() {
    const body = draft.trim()
    if (!body) return
    actions.createThread({
      storyId,
      // "+ New" is a comment on the story, not on a case: no anchor, and no
      // case name either, so it stays visible whichever tab is open. Only a
      // comment made from a selection belongs to one case.
      caseName: pendingAnchor?.caseName || '',
      anchor: pendingAnchor?.anchor || null,
      body,
    })
    setDraft('')
    setComposing(false)
    onClearPendingAnchor()
  }

  function cancelNew() {
    setDraft('')
    setComposing(false)
    onClearPendingAnchor()
  }

  function activate(thread) {
    // A card from another story: go there first, so the editor can show the
    // highlight this thread is anchored to.
    if (thread.story_id !== storyId) onSelectStory(thread.story_id, thread.case_name)
    onActivateThread(thread.id)
  }

  // Clicking the story name. Unlike activating a card, this navigates even when
  // the thread is already on the open story — it's the "show me this in the
  // editor" action, so it moves to the right case tab either way.
  function openStory(thread) {
    onSelectStory(thread.story_id, thread.case_name)
    onActivateThread(thread.id)
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden border-l">
      <div className="shrink-0 border-b px-3 pt-2.5 pb-2">
        <div className="mb-2 flex items-center gap-1">
          <Tabs value={tab} onValueChange={setTab} className="min-w-0 flex-1">
            <TabsList>
              <TabsTrigger value="all">All Comments</TabsTrigger>
              <TabsTrigger value="you">For You</TabsTrigger>
            </TabsList>
          </Tabs>
          <Button
            variant="outline"
            size="xs"
            disabled={!storyId}
            title={storyId ? 'Comment on this story' : 'Select a story first'}
            onClick={() => {
              onClearPendingAnchor()
              setReplyingTo(null)
              setComposing(true)
            }}
          >
            <MessageSquarePlus />
            New
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Close comments" title="Close comments" onClick={onClose}>
            <X />
          </Button>
        </div>

        <div className="flex items-center gap-1.5">
          <Select value={scope} onValueChange={setScope} disabled={tab === 'you'}>
            <SelectTrigger size="sm" className="flex-1 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All stories</SelectItem>
              <SelectItem value="story">This story</SelectItem>
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger size="sm" className="flex-1 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              <SelectItem value="open">Open</SelectItem>
              <SelectItem value="resolved">Resolved</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {error && (
        <div className="text-destructive flex items-start gap-1.5 border-b px-3 py-2 text-[12px]">
          <span className="min-w-0 flex-1">{error}</span>
          <button type="button" className="shrink-0 underline" onClick={actions.clearError}>
            Dismiss
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {composing && (
          <div className="mb-2 rounded-md border p-2.5">
            {pendingAnchor ? (
              <div className="text-muted-foreground border-muted-foreground/40 mb-1.5 truncate border-l-2 pl-2 text-[12px] italic">
                {pendingAnchor.anchor.quote}
              </div>
            ) : (
              <div className="text-muted-foreground mb-1.5 text-[11px]">
                Commenting on {storyTitle || 'this story'}
              </div>
            )}
            <CommentComposer
              users={users}
              value={draft}
              onChange={setDraft}
              onSubmit={submitNew}
              onCancel={cancelNew}
              autoFocus
            />
          </div>
        )}

        {rows.length === 0 && !composing ? (
          <p className="text-muted-foreground px-1 py-6 text-center text-[13px]">
            {tab === 'you'
              ? 'No comments mention you.'
              : status === 'open'
                ? 'No open comments here.'
                : 'No comments yet.'}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {rows.map((thread) => (
              <ThreadCard
                key={`${thread.story_id}::${thread.id}`}
                thread={thread}
                isCurrentStory={thread.story_id === storyId}
                userEmail={userEmail}
                users={users}
                isActive={activeThreadId === thread.id}
                isReplying={replyingTo === thread.id}
                onActivate={activate}
                onOpenStory={openStory}
                onStartReply={(t) => {
                  activate(t)
                  setComposing(false)
                  setReplyingTo(t.id)
                }}
                onCancelReply={() => setReplyingTo(null)}
                onReply={(t, body) => {
                  if (!body.trim()) return
                  actions.addReply({ storyId: t.story_id, threadId: t.id, body: body.trim() })
                  setReplyingTo(null)
                }}
                onResolve={(t) => actions.setStatus({ storyId: t.story_id, threadId: t.id, status: 'resolved' })}
                onReopen={(t) => actions.setStatus({ storyId: t.story_id, threadId: t.id, status: 'open' })}
                onDelete={setPendingDelete}
              />
            ))}
          </div>
        )}
      </div>

      <AlertDialog open={!!pendingDelete} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete comment thread?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the thread and all {pendingDelete?.comments?.length || pendingDelete?.reply_count + 1 || 1}{' '}
              of its comments from {pendingDelete?.story_title || 'the story'}. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: 'destructive' })}
              onClick={() => {
                actions.deleteThread({ storyId: pendingDelete.story_id, threadId: pendingDelete.id })
                setPendingDelete(null)
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
