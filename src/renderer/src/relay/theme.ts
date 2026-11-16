import { useEffect, useLayoutEffect, useState } from 'react'
import type { ITheme } from '@xterm/xterm'
import { DEFAULT_TERMINAL_THEMES } from '@/lib/terminal-themes/defaults'
export type ThemeChoice = 'system' | 'light' | 'dark'
export type Theme = 'light' | 'dark'
const query = '(prefers-color-scheme: dark)'
export const themeChoices: ThemeChoice[] = ['system', 'light', 'dark']
export const resolveTheme = (choice: ThemeChoice): Theme =>
  choice === 'system' ? (matchMedia(query).matches ? 'dark' : 'light') : choice
export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark')
  document.documentElement.style.colorScheme = theme
}
// Resolves "system" against macOS/Linux appearance and follows it live.
export function useResolvedTheme(choice: ThemeChoice): Theme {
  const [system, setSystem] = useState(() => resolveTheme('system'))
  useEffect(() => {
    const media = matchMedia(query)
    const change = () => setSystem(media.matches ? 'dark' : 'light')
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])
  const theme = choice === 'system' ? system : choice
  useLayoutEffect(() => applyTheme(theme), [theme])
  return theme
}
// Light reuses the Claude-tuned Tango palette; both take shell tokens so panes blend in.
export function terminalTheme(theme: Theme): ITheme {
  const style = getComputedStyle(document.documentElement)
  const background = style.getPropertyValue('--background').trim()
  const foreground = style.getPropertyValue('--foreground').trim()
  const base = theme === 'light' ? DEFAULT_TERMINAL_THEMES['Builtin Tango Light'] : {}
  return { ...base, background, foreground, cursor: foreground, cursorAccent: background }
}
