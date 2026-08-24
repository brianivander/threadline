import { Moon, Sun } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useTheme } from '@/components/theme-provider'

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme()
  const label = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'

  return (
    <Button variant="ghost" size="icon-sm" onClick={toggleTheme} aria-label={label} title={label}>
      {theme === 'dark' ? <Moon /> : <Sun />}
    </Button>
  )
}
