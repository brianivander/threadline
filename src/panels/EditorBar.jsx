// The editor column's top bar: the sidebar toggle, the open tabs, and the
// comment and browser toggles.
//
// General on purpose. This used to be part of StoryPanel, with DocPanel keeping
// its own copy of the same row — so which controls existed depended on what
// kind of file was open, and the comment toggle vanished the moment you opened
// a README. The bar now belongs to the column rather than to any one panel:
// the same controls are there whatever is in the tabs, and the panels below
// render only their own content.
//
// The comment toggle is always enabled. Whether the OPEN FILE can hold a
// comment is a separate question, answered inside the panel — the workspace's
// comment lists ("All stories", "For You") are worth reaching from anywhere.

import { cn } from '@/lib/utils'
import { File, FileCode, FileText, Globe, Image as ImageIcon, MessageSquareText, PanelLeft, X } from 'lucide-react'

import { Button } from '@/components/ui/button'

// Same glyph vocabulary as a tree row, so a tab reads as the file it is.
const TAB_GLYPHS = { story: FileText, doc: File, page: FileCode, text: FileCode, image: ImageIcon }

function EditorTab({ tab, active, onActivate, onClose }) {
  const Glyph = TAB_GLYPHS[tab.kind] || File
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      title={tab.path}
      className={cn(
        // Sized to its own title up to a comfortable maximum, but allowed to
        // shrink once the strip runs out of room — a default flex item
        // (`flex: 0 1 auto`), with min-w-0 letting the title truncate inside
        // it. The minimum is what still reads as a tab: the glyph, a few
        // characters, and a close button. Past that the strip scrolls, because
        // tabs squeezed below this can be neither read nor aimed at.
        'group/tab flex h-7 max-w-52 min-w-28 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-[13px]',
        active
          ? 'bg-accent text-accent-foreground border-border font-semibold'
          : 'text-muted-foreground hover:bg-accent/50 border-transparent',
      )}
      onClick={() => onActivate(tab.key)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onActivate(tab.key)
      }}
      // Middle-click closes, as it does in every editor with tabs.
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault()
          onClose(tab.key)
        }
      }}
    >
      <Glyph className="size-3.5 shrink-0" />
      {/* The first thing to give way: the glyph and the close button keep their
          size, and the name truncates between them. */}
      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap" title={tab.title}>
        {tab.title}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        // Always visible on the active tab, on hover otherwise: a row of close
        // buttons is noise, but a tab you can't see how to close is worse.
        className={cn('shrink-0', active ? '' : 'opacity-0 group-hover/tab:opacity-100 focus:opacity-100')}
        aria-label={`Close ${tab.title}`}
        onClick={(e) => {
          e.stopPropagation()
          onClose(tab.key)
        }}
      >
        <X />
      </Button>
    </div>
  )
}

export default function EditorBar({
  tabs = [],
  activeKey,
  onActivateTab,
  onCloseTab,
  onToggleSidebar,
  commentsOpen,
  onToggleComments,
  // Open comments anywhere in the workspace that mention the current user.
  openCommentCount = 0,
  browserOpen,
  onToggleBrowser,
}) {
  return (
    // The edge-bolted groups hold controls that act on things OUTSIDE this
    // column — the sidebar, the comment panel, the browser. The tabs between
    // them are the column's own content.
    <div className="flex shrink-0 items-center gap-1 border-b py-1 pr-0 pl-0">
      <div className="bg-muted/60 border-border flex shrink-0 items-center rounded-r-lg border border-l-0 py-0.5 pr-1 pl-0.5">
        <Button variant="ghost" size="icon-sm" aria-label="Toggle sidebar" title="Toggle sidebar" onClick={onToggleSidebar}>
          <PanelLeft />
        </Button>
      </div>

      {/* Scrolls rather than shrinking: a tab squeezed to nothing can't be
          read or closed. */}
      <div role="tablist" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1">
        {tabs.map((tab) => (
          <EditorTab
            key={tab.key}
            tab={tab}
            active={tab.key === activeKey}
            onActivate={onActivateTab}
            onClose={onCloseTab}
          />
        ))}
      </div>

      <div className="bg-muted/60 border-border flex shrink-0 items-center gap-0.5 rounded-l-lg border border-r-0 py-0.5 pr-0.5 pl-1">
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn('relative', commentsOpen ? 'text-primary' : '')}
          aria-label={commentsOpen ? 'Hide comments' : 'Show comments'}
          aria-pressed={commentsOpen}
          title={
            openCommentCount > 0
              ? `${openCommentCount} open comment${openCommentCount === 1 ? '' : 's'} mentioning you`
              : commentsOpen
                ? 'Hide comments'
                : 'Show comments'
          }
          onClick={onToggleComments}
        >
          <MessageSquareText />
          {openCommentCount > 0 && (
            <span className="bg-primary text-primary-foreground absolute -top-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full text-[9px] font-semibold">
              {openCommentCount > 9 ? '9+' : openCommentCount}
            </span>
          )}
        </Button>
        {/* Opening a link's arrow reveals the browser too, so the two stay in
            agreement. */}
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn(browserOpen ? 'text-primary' : '')}
          aria-label={browserOpen ? 'Hide browser' : 'Show browser'}
          aria-pressed={browserOpen}
          title={browserOpen ? 'Hide browser' : 'Show browser'}
          onClick={onToggleBrowser}
        >
          <Globe />
        </Button>
      </div>
    </div>
  )
}
