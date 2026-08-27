// The two pieces of save UI every body editor shows: the button that writes the
// file, and the banners that explain when something needs the user's attention.
//
// Split into two exports because they don't sit together. The button belongs in
// whatever header the panel already has; the banners span the full width above
// the text, where an error can't be missed and can't be mistaken for content.

import { Save } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

// How long ago a draft was written, in the only terms that matter here: whether
// it's worth worrying about. Exact times aren't — "which of these two versions
// is mine" is answered by looking at the text.
function howLongAgo(iso) {
  if (!iso) return 'earlier'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 'earlier'
  const mins = Math.floor((Date.now() - then) / 60000)
  if (mins < 1) return 'moments ago'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

// Deliberately always mounted rather than appearing only when dirty: a button
// that isn't there until you need it can't be found before you need it, and
// this one is the answer to "how do I save". Disabled IS the saved state.
export function SaveButton({ dirty, saving, onSave, className }) {
  return (
    <Button
      variant={dirty ? 'default' : 'ghost'}
      size="sm"
      className={cn('shrink-0 gap-1.5', className)}
      disabled={!dirty || saving}
      onClick={onSave}
      aria-label={dirty ? 'Save changes' : 'No unsaved changes'}
      title={dirty ? 'Save (Ctrl+S)' : 'Saved'}
    >
      <Save className="size-3.5" />
      {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
    </Button>
  )
}

// `recovered` is a draft this editor restored on open — text the user typed
// that never reached disk. `stale` on it means the file itself changed in the
// meantime, which is the case worth interrupting for: saving would overwrite
// whatever arrived, and discarding would throw away what they wrote.
// `problem` is anything else that went wrong in the editor and has nowhere of
// its own to be shown — a paste that couldn't be stored, say. It shares the
// banner but not the "Couldn't save" wording, which would be a lie about what
// failed.
export function SaveNotices({ recovered, error, problem, onDiscard, onSave }) {
  return (
    <>
      {error && (
        <div className="bg-destructive/10 text-destructive shrink-0 border-y px-4 py-1.5 text-xs">
          Couldn’t save: {error}
        </div>
      )}

      {problem && (
        <div className="bg-destructive/10 text-destructive shrink-0 border-y px-4 py-1.5 text-xs">
          {problem}
        </div>
      )}

      {recovered && (
        <div
          className={cn(
            'shrink-0 border-y px-4 py-2 text-xs',
            recovered.stale ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground',
          )}
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0">
              {recovered.stale ? (
                <>
                  <span className="font-medium">Unsaved changes restored, but this file has changed since.</span>{' '}
                  Your draft from {howLongAgo(recovered.at)} is shown. Saving replaces what’s now on disk.
                </>
              ) : (
                <>
                  <span className="font-medium">Unsaved changes restored</span> from {howLongAgo(recovered.at)}.
                </>
              )}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1">
              <Button variant="ghost" size="xs" onClick={onDiscard}>
                Discard draft
              </Button>
              <Button variant="secondary" size="xs" onClick={onSave}>
                Save it
              </Button>
            </span>
          </div>
        </div>
      )}
    </>
  )
}
