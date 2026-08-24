// Theme state for the app: 'light' | 'dark', persisted, applied as a class on
// <html> (which is what the `dark:` variant in index.css keys off).
//
// MDXEditor does not read shadcn's tokens — it themes itself from Radix
// semantic variables and flips to dark via its own `dark-theme` class. Both
// classes are toggled together here so the editor never lags the app.

import { createContext, useCallback, useContext, useEffect, useState } from 'react'

const STORAGE_KEY = 'threadline_theme'
const ThemeContext = createContext({ theme: 'light', toggleTheme: () => {} })

function loadTheme() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'light' || saved === 'dark') return saved
  } catch {
    /* noop */
  }
  return 'light'
}

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(loadTheme)

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', theme === 'dark')
    root.classList.toggle('dark-theme', theme === 'dark')
    try {
      localStorage.setItem(STORAGE_KEY, theme)
    } catch {
      /* noop */
    }
  }, [theme])

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'))
  }, [])

  return <ThemeContext.Provider value={{ theme, toggleTheme }}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  return useContext(ThemeContext)
}
