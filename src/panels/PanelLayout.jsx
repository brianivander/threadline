// The window: four panels side by side in one flat resizable group —
// sidebar | story | comments | browser.
//
// Flat on purpose. The sidebar/story/comments group used to be nested inside
// a board/browser group, which meant the divider between them moved a nested
// group's inner split rather than the two panels actually touching it.
//
// Structure only: every panel arrives as a rendered element from Board, which
// owns the state that decides what goes in them.

import { useEffect, useRef } from 'react'

import { ResizableGroup, ResizableHandle, ResizablePanel } from '@/components/ui/resizable'

export default function PanelLayout({ sidebar, story, comments, browser, browserOpen = true, onBrowserOpenChange }) {
  // The browser is collapsed rather than unmounted: tearing it down would
  // reload every open tab on the next toggle.
  const browserPanel = useRef(null)

  useEffect(() => {
    const panel = browserPanel.current
    if (!panel) return
    if (browserOpen && panel.isCollapsed()) panel.expand()
    else if (!browserOpen && !panel.isCollapsed()) panel.collapse()
  }, [browserOpen])

  return (
    // The sidebar and the comments panel each toggle independently, so the
    // layout is keyed by which of them are showing: hiding one must not leave
    // the remembered sizes of a different arrangement behind. The browser
    // isn't part of the key — it collapses in place.
    <ResizableGroup
      storageId={`threadline_layout_${sidebar ? 'sidebar' : 'nosidebar'}_${comments ? 'comments' : 'nocomments'}`}
      className="min-h-0 flex-1"
    >
      {sidebar && (
        <ResizablePanel id="sidebar" defaultSize="12%" minSize="8%" maxSize="40%">
          {sidebar}
        </ResizablePanel>
      )}
      {sidebar && <ResizableHandle />}

      <ResizablePanel id="story" defaultSize="24%" minSize="15%">
        {story}
      </ResizablePanel>

      {comments && <ResizableHandle />}
      {comments && (
        <ResizablePanel id="comments" defaultSize="20%" minSize="12%" maxSize="45%">
          {comments}
        </ResizablePanel>
      )}

      <ResizableHandle />
      <ResizablePanel
        id="browser"
        panelRef={browserPanel}
        collapsible
        collapsedSize="0%"
        defaultSize="64%"
        minSize="20%"
        // Dragging the handle shut is the same gesture as the header toggle, so
        // report it back instead of letting the two disagree. The mount call
        // (no previous size) is skipped — it would clobber the restored state
        // before the effect above gets to apply it.
        onResize={(size, id, prevSize) => {
          if (!prevSize || !onBrowserOpenChange) return
          onBrowserOpenChange(size.asPercentage > 0)
        }}
      >
        <div className="h-full min-w-0 overflow-hidden">{browser}</div>
      </ResizablePanel>
    </ResizableGroup>
  )
}
