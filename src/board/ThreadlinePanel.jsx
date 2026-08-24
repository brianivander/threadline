// Always-on, docked layout: the board fills a resizable panel on one side,
// the app content (the embedded browser) takes the rest. No FAB, no toggle,
// no dismiss — the board is permanently visible side-by-side with the app.
//
// The content panel is collapsible rather than unmounted: hiding the browser
// must not tear down its <webview>s, or every open tab would reload on the
// next toggle.

import { useEffect, useRef } from 'react'

import { ResizableGroup, ResizableHandle, ResizablePanel } from '@/components/ui/resizable'

export default function ThreadlinePanel({ children, board, browserOpen = true, onBrowserOpenChange }) {
  const contentPanel = useRef(null)

  useEffect(() => {
    const panel = contentPanel.current
    if (!panel) return
    if (browserOpen && panel.isCollapsed()) panel.expand()
    else if (!browserOpen && !panel.isCollapsed()) panel.collapse()
  }, [browserOpen])

  return (
    <ResizableGroup storageId="threadline_panel_layout" className="h-screen">
      <ResizablePanel id="board" defaultSize="30%" minSize="15%">
        {board}
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel
        id="content"
        panelRef={contentPanel}
        collapsible
        collapsedSize="0%"
        defaultSize="70%"
        minSize="20%"
        // Dragging the handle shut is the same gesture as the header toggle,
        // so report it back instead of letting the two disagree. The mount
        // call (no previous size) is skipped — it would clobber the restored
        // state before the effect above gets to apply it.
        onResize={(size, id, prevSize) => {
          if (!prevSize || !onBrowserOpenChange) return
          onBrowserOpenChange(size.asPercentage > 0)
        }}
      >
        <div className="h-full min-w-0 overflow-hidden">{children}</div>
      </ResizablePanel>
    </ResizableGroup>
  )
}
