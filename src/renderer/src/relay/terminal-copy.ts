import type { Terminal } from '@xterm/xterm'
export function copyKey(event: KeyboardEvent) {
  const mac = navigator.userAgent.includes('Mac')
  return (
    event.key.toLowerCase() === 'c' &&
    !event.altKey &&
    (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && event.shiftKey && !event.metaKey)
  )
}
export function pasteKey(event: KeyboardEvent) {
  const mac = navigator.userAgent.includes('Mac')
  return (
    event.key.toLowerCase() === 'v' &&
    !event.altKey &&
    (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && event.shiftKey && !event.metaKey)
  )
}
export function installTerminalCopy(term: Terminal, container: HTMLElement, copy: () => void) {
  const handler = (event: ClipboardEvent) => {
    if (!container.contains(document.activeElement) || !term.hasSelection()) {
      return
    }
    event.preventDefault()
    event.stopImmediatePropagation()
    if (event.clipboardData) {
      event.clipboardData.setData('text/plain', term.getSelection())
    } else {
      copy()
    }
  }
  document.addEventListener('copy', handler, true)
  return () => document.removeEventListener('copy', handler, true)
}
