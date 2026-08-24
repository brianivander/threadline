// Resizable split panels, over react-resizable-panels v4.
//
// NOTE for anyone comparing this against shadcn's published `resizable`
// component: that one targets the v2/v3 API (`PanelGroup`, `PanelResizeHandle`,
// `direction`, `autoSaveId`), none of which exist in v4. Here the exports are
// `Group`/`Panel`/`Separator`, the axis prop is `orientation`, and layout
// persistence is a hook (`useDefaultLayout`) rather than a prop — pass
// `storageId` and every panel an `id`, and the layout is remembered.
//
// Only the horizontal orientation is styled, because it's the only one the
// board uses.

import * as React from 'react'
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'

import { cn } from '@/lib/utils'

function ResizableGroup({ className, storageId, children, ...props }) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: storageId,
    onlySaveAfterUserInteractions: true,
  })

  return (
    <Group
      data-slot="resizable-group"
      orientation="horizontal"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
      className={cn('flex h-full w-full', className)}
      {...props}
    >
      {children}
    </Group>
  )
}

function ResizablePanel({ className, ...props }) {
  return <Panel data-slot="resizable-panel" className={cn('min-w-0 overflow-hidden', className)} {...props} />
}

function ResizableHandle({ className, ...props }) {
  return (
    <Separator
      data-slot="resizable-handle"
      className={cn(
        'bg-border hover:bg-ring focus-visible:ring-ring relative w-px shrink-0 cursor-col-resize transition-colors focus-visible:ring-1 focus-visible:outline-hidden',
        // Widen the hit area beyond the 1px line without moving the layout —
        // the panel beside it hosts a <webview>, so the grab target needs to be
        // forgiving.
        'after:absolute after:inset-y-0 after:left-1/2 after:w-1.5 after:-translate-x-1/2',
        className,
      )}
      {...props}
    />
  )
}

export { ResizableGroup, ResizablePanel, ResizableHandle }
