import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Globe, Plus, RotateCw, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

// Standalone browser panel. Independent of stories — lives on the right side
// and persists across story selections. Only responds to arrow-button clicks
// which request specific URLs be opened as new tabs.
//
// Tabs are managed entirely here: add/close/navigate. Keyed by URL for
// reusability: re-opening a URL that's already loaded re-activates that tab
// instead of creating a duplicate. Each tab carries a stable id so React never
// reuses one tab's webview for another tab's URL.

const EMBED_PARTITION = 'persist:embeds'

function hostnameLabel(url) {
  if (!url) return 'New Tab'
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function normalizeUrl(raw) {
  const trimmed = (raw || '').trim()
  if (!trimmed) return trimmed
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

// Outside Electron the <iframe> is cross-origin and fires no favicon events, so
// the site's conventional icon path is the best guess available. Wrong often
// enough that TabIcon has to handle the 404 by falling back to the globe.
function guessFaviconUrl(url) {
  if (!url) return ''
  try {
    return `${new URL(url).origin}/favicon.ico`
  } catch {
    return ''
  }
}

// The tab's icon: the page's real favicon where one is known, a globe while a
// tab is blank, still loading, or serving an icon that fails to load.
function TabIcon({ src }) {
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)
  }, [src])

  if (!src || failed) return <Globe className="text-muted-foreground size-4 shrink-0" />
  return (
    <img
      src={src}
      alt=""
      className="size-4 shrink-0 rounded-[2px] object-contain"
      onError={() => setFailed(true)}
    />
  )
}

function BrowserTab({ url, active, isElectron, onNavigate, onFavicon }) {
  const containerRef = useRef(null)
  const webviewRef = useRef(null)
  const [urlDraft, setUrlDraft] = useState(url)
  const [iframeReloadKey, setIframeReloadKey] = useState(0)

  // Held in a ref so the webview effect doesn't list it as a dependency — a new
  // callback identity each parent render would otherwise tear the webview down
  // and reload the page on every keystroke elsewhere in the panel.
  const onFaviconRef = useRef(onFavicon)
  onFaviconRef.current = onFavicon

  // The tab's URL lives in the parent, so the address bar has to follow it —
  // otherwise opening a link into an existing tab leaves the old text behind.
  useEffect(() => {
    setUrlDraft(url)
  }, [url])

  useEffect(() => {
    if (!isElectron || !containerRef.current || !url) return
    const el = document.createElement('webview')
    el.setAttribute('partition', EMBED_PARTITION)
    // Google's OAuth "Continue with Google" flow opens a popup window; without
    // this the webview blocks it outright and the parent page reports a
    // generic profile-fetch failure with no further detail.
    el.setAttribute('allowpopups', 'true')
    el.setAttribute('src', url)
    el.style.width = '100%'
    el.style.height = '100%'
    el.style.border = 'none'
    // Electron hands over every declared icon, ascending by size; the last is
    // the sharpest. Leaving the page drops the old icon so a tab never wears
    // the previous site's favicon while the next one loads — keyed off
    // `did-navigate`, which is main-frame only. `did-start-loading` also fires
    // for every subframe, so an ad iframe would wipe the icon seconds after the
    // page itself supplied it.
    const onFaviconUpdated = (e) => onFaviconRef.current?.(e.favicons?.[e.favicons.length - 1] || '')
    const onDidNavigate = () => onFaviconRef.current?.('')
    el.addEventListener('page-favicon-updated', onFaviconUpdated)
    el.addEventListener('did-navigate', onDidNavigate)
    webviewRef.current = el
    containerRef.current.appendChild(el)
    return () => {
      el.removeEventListener('page-favicon-updated', onFaviconUpdated)
      el.removeEventListener('did-navigate', onDidNavigate)
      el.remove()
      webviewRef.current = null
    }
  }, [isElectron, url])

  function reload() {
    if (isElectron) webviewRef.current?.reload()
    else setIframeReloadKey((k) => k + 1)
  }

  function commitUrlDraft() {
    if (urlDraft.trim()) onNavigate(normalizeUrl(urlDraft))
  }

  return (
    <div className={cn('h-full flex-col', active ? 'flex' : 'hidden')}>
      <div className="bg-background flex shrink-0 items-center gap-1 border-b px-2 py-1">
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={!isElectron}
          title="Back"
          aria-label="Back"
          onClick={() => webviewRef.current?.goBack()}
        >
          <ArrowLeft />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={!isElectron}
          title="Forward"
          aria-label="Forward"
          onClick={() => webviewRef.current?.goForward()}
        >
          <ArrowRight />
        </Button>
        <Button variant="ghost" size="icon-sm" title="Reload" aria-label="Reload" onClick={reload}>
          <RotateCw />
        </Button>
        <Input
          className="h-7 flex-1 font-mono text-xs"
          value={urlDraft}
          onChange={(e) => setUrlDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitUrlDraft()
          }}
          autoFocus={!url}
          placeholder="https://…"
        />
      </div>
      {/* Explicitly white, not `bg-background`: the page inside is pinned to
          light (see nativeTheme in electron/main.cjs), so in dark mode a
          themed ground here would show through a blank or still-loading tab
          and then flash to white once the page paints. */}
      <div className="min-h-0 flex-1 bg-white">
        {isElectron ? (
          <div ref={containerRef} className="h-full w-full" />
        ) : (
          <iframe key={iframeReloadKey} src={url} className="h-full w-full border-none" />
        )}
      </div>
    </div>
  )
}

const EmbedViewer = forwardRef(function EmbedViewer(_props, ref) {
  const isElectron = typeof window !== 'undefined' && !!window.threadlineDesktop?.isElectron
  // Starts with one blank tab so the panel always shows a live browser (nav
  // row + address bar), never an empty instructional placeholder.
  const [tabs, setTabs] = useState([{ id: 0, url: '', favicon: '' }])
  const [activeId, setActiveId] = useState(0)
  const nextIdRef = useRef(1)

  // Tab elements by id, so the strip can scroll the active one into view once
  // there are more tabs than fit.
  const tabElsRef = useRef(new Map())

  // Mirror of `tabs` for event handlers, so opening a link can look up an
  // existing tab without scheduling state updates from inside an updater.
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs

  useEffect(() => {
    tabElsRef.current.get(activeId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeId, tabs.length])

  function addTab(url) {
    const id = nextIdRef.current++
    setTabs((prev) => [...prev, { id, url, favicon: '' }])
    setActiveId(id)
  }

  // Exposed via ref: App.jsx calls this when an arrow button is clicked.
  useImperativeHandle(ref, () => ({
    openUrl(url) {
      const normalized = normalizeUrl(url)
      if (!normalized) return
      const existing = tabsRef.current.find((tab) => tab.url === normalized)
      if (existing) {
        setActiveId(existing.id)
        return
      }
      // Reuse the blank starter tab rather than stranding it beside the new one.
      const blank = tabsRef.current.find((tab) => !tab.url)
      if (blank) {
        setTabs((prev) =>
          prev.map((tab) => (tab.id === blank.id ? { ...tab, url: normalized, favicon: '' } : tab)),
        )
        setActiveId(blank.id)
        return
      }
      addTab(normalized)
    },
  }))

  function navigate(id, url) {
    setTabs((prev) => prev.map((tab) => (tab.id === id ? { ...tab, url, favicon: '' } : tab)))
  }

  function setFavicon(id, favicon) {
    setTabs((prev) => prev.map((tab) => (tab.id === id ? { ...tab, favicon } : tab)))
  }

  function closeTab(id) {
    const prev = tabsRef.current
    const index = prev.findIndex((tab) => tab.id === id)
    const next = prev.filter((tab) => tab.id !== id)
    // Never leave zero tabs — closing the last one reverts to a blank
    // browser tab rather than the empty placeholder state.
    if (!next.length) {
      const blankId = nextIdRef.current++
      setTabs([{ id: blankId, url: '', favicon: '' }])
      setActiveId(blankId)
      return
    }
    setTabs(next)
    if (id === activeId) setActiveId(next[Math.min(index, next.length - 1)].id)
  }

  return (
    <div className="flex h-full flex-col">
      {/* Chrome-style: tabs shrink evenly, shedding first the label and then
          an inactive tab's close button, down to a favicon-wide floor. Past
          that the strip scrolls sideways rather than slicing tabs thinner. */}
      <div className="bg-muted/40 flex shrink-0 items-center border-b px-1.5 pt-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overflow-y-hidden [&::-webkit-scrollbar]:hidden">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              ref={(el) => {
                if (el) tabElsRef.current.set(tab.id, el)
                else tabElsRef.current.delete(tab.id)
              }}
              role="button"
              tabIndex={0}
              onClick={() => setActiveId(tab.id)}
              title={hostnameLabel(tab.url)}
              className={cn(
                '@container group -mb-px flex flex-1 basis-auto cursor-pointer items-center gap-1.5 rounded-t-md border px-3 py-1.5 text-[13px] whitespace-nowrap',
                'max-w-44',
                tab.id === activeId
                  ? 'bg-background text-foreground border-b-background min-w-[68px]'
                  : 'text-muted-foreground hover:text-foreground min-w-10 border-transparent',
              )}
            >
              <TabIcon src={tab.favicon || (isElectron ? '' : guessFaviconUrl(tab.url))} />
              <span className="min-w-0 flex-1 overflow-hidden text-ellipsis">
                {hostnameLabel(tab.url)}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                className={cn(
                  'shrink-0',
                  // At the floor an inactive tab is only as wide as its favicon,
                  // so the × steps aside until the pointer is on that tab.
                  tab.id !== activeId && '@max-[68px]:hidden @max-[68px]:group-hover:inline-flex',
                )}
                aria-label="Close tab"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(tab.id)
                }}
              >
                <X />
              </Button>
            </div>
          ))}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          title="New tab"
          aria-label="New tab"
          onClick={() => addTab('')}
        >
          <Plus />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
        {tabs.map((tab) => (
          <BrowserTab
            key={tab.id}
            url={tab.url}
            active={tab.id === activeId}
            isElectron={isElectron}
            onNavigate={(url) => navigate(tab.id, url)}
            onFavicon={(favicon) => setFavicon(tab.id, favicon)}
          />
        ))}
      </div>
    </div>
  )
})

export default EmbedViewer
