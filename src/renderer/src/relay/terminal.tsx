import { copyKey, installTerminalCopy } from './terminal-copy'
import { installTerminalLinks } from './terminal-links'
import { ActionMenu, command } from './action-menu'
import type { OpenFile } from './editor'
import { shiftEnterInput } from '../components/terminal-pane/terminal-shift-enter-input'
import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Button } from '@/components/ui/button'
export function SessionTerminal({
  openFile,
  host,
  workspace,
  terminal,
  fontSize,
  theme,
  active = true
}: {
  openFile: (file: OpenFile) => void
  host: string
  workspace: string
  terminal: string
  fontSize: number
  theme: string
  active?: boolean
}) {
  const open = useRef(openFile)
  open.current = openFile
  const focused = useRef(active)
  focused.current = active
  const instance = useRef<Terminal | null>(null)
  useEffect(() => {
    if (active && !document.querySelector('[data-relay-renaming]')) {
      instance.current?.focus()
    }
  }, [active])
  const container = useRef<HTMLDivElement>(null)
  const [copyError, setCopyError] = useState('')
  const [linkError, setLinkError] = useState('')
  const [dropError, setDropError] = useState('')
  const [dropStatus, setDropStatus] = useState('')
  const [menuText, setMenuText] = useState('')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!container.current) {
      return
    }
    let cancelled = false
    const key = JSON.stringify([host, workspace, terminal])
    const style = getComputedStyle(document.documentElement)
    const term = new Terminal({
      fontSize,
      fontFamily: 'Menlo, Monaco, monospace',
      cursorBlink: true,
      mouseEventsRequireAlt: true,
      scrollback: 10000,
      theme: {
        background: style.getPropertyValue('--background').trim(),
        foreground: style.getPropertyValue('--foreground').trim()
      }
    })
    const copy = () => {
      if (term.hasSelection()) {
        void window.relay.copyText(term.getSelection()).catch((e) => setCopyError(String(e)))
      }
    }
    term.attachCustomKeyEventHandler((event) => {
      if (copyKey(event)) {
        event.preventDefault()
        if (event.type === 'keydown') {
          copy()
        }
        return false
      }
      if (
        event.key !== 'Enter' ||
        !event.shiftKey ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.isComposing ||
        event.keyCode === 229
      ) {
        return true
      }
      if (event.type === 'keydown') {
        event.preventDefault()
        window.relay.write(key, shiftEnterInput(false))
      }
      return false
    })
    instance.current = term
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container.current)
    const removeCopy = installTerminalCopy(term, container.current, copy)
    const removeLinks = installTerminalLinks(
      term,
      host,
      workspace,
      terminal,
      (file) => open.current(file),
      (e) => setLinkError(String(e))
    )
    let frame = requestAnimationFrame(() => fit.fit())
    const off = window.relay.onTerminal((event) => {
      if (event.key !== key || cancelled) {
        return
      }
      if (event.data) {
        term.write(event.data)
      }
      if (event.state === 'unverifiable') {
        setError('Connection lost. The session may still be running. Reconnect to check.')
      }
    })
    const input = term.onData((data) => window.relay.write(key, data))
    const resize = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (cancelled || !container.current?.clientWidth || !container.current?.clientHeight) {
          return
        }
        fit.fit()
        window.relay.resize(key, term.cols, term.rows)
      })
    })
    resize.observe(container.current)
    setError('')
    window.relay
      .attach(host, workspace, terminal, term.cols, term.rows)
      .then(() => {
        if (!cancelled) {
          fit.fit()
          window.relay.resize(key, term.cols, term.rows)
          if (focused.current && !document.querySelector('[data-relay-renaming]')) {
            term.focus()
          }
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setError(String(error))
        }
      })
    return () => {
      cancelled = true
      off()
      removeLinks()
      removeCopy()
      input.dispose()
      resize.disconnect()
      cancelAnimationFrame(frame)
      window.relay.detach(key)
      instance.current = null
      term.dispose()
    }
  }, [host, workspace, terminal, fontSize, theme, attempt])
  return (
    <ActionMenu
      actions={[
        {
          label: 'Copy',
          shortcut: `${command}C`,
          disabled: !menuText,
          run: () => {
            if (menuText) {
              void window.relay.copyText(menuText).catch((e) => setCopyError(String(e)))
            }
          }
        },
        {
          label: 'Paste',
          shortcut: `${command}V`,
          run: async () => {
            const text = await window.relay.readClipboardText()
            instance.current?.paste(text)
          }
        },
        {
          label: 'Select All',
          shortcut: `${command}A`,
          run: () => instance.current?.selectAll()
        }
      ]}
    >
      <div
        className="relative flex h-full min-h-0 flex-col"
        onContextMenu={(event) => {
          // Keep the menu ours (not the pane's), and defang xterm's internal right-click shim:
          // it parks the helper textarea under the cursor at z-index 1000 and focuses it, which
          // makes later wheel/clicks at that spot miss the terminal entirely.
          event.stopPropagation()
          const area = instance.current?.textarea
          if (area) {
            area.value = ''
            area.style.zIndex = '-5'
          }
        }}
        onMouseDownCapture={(event) => {
          // Right press must keep the local selection for the context menu instead of clearing it in xterm.
          if (event.button === 2) {
            event.stopPropagation()
            setMenuText(instance.current?.getSelection() || '')
          }
        }}
        onMouseUpCapture={(event) => {
          // Match the mousedown guard so xterm never sees an unmatched right release.
          if (event.button === 2) {
            event.stopPropagation()
          }
        }}
      >
        <div
          ref={container}
          data-relay-host={host}
          className="relay-terminal min-h-0 flex-1 p-3"
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes('Files')) {
              event.preventDefault()
              event.dataTransfer.dropEffect = 'copy'
            }
          }}
          onDrop={async (event) => {
            if (!event.dataTransfer.files.length) {
              return
            }
            event.preventDefault()
            event.stopPropagation()
            const target = instance.current
            if (!target || dropStatus) {
              return
            }
            setDropError('')
            setDropStatus(host === 'local' ? 'Adding files…' : 'Uploading files…')
            try {
              const paths = await window.relay.dropFiles(
                host,
                workspace,
                terminal,
                Array.from(event.dataTransfer.files)
              )
              if (instance.current === target) {
                target.paste(
                  `${paths.map((path) => `'${path.replaceAll("'", "'\\''")}'`).join(' ')} `
                )
              }
            } catch (error) {
              setDropError(String(error))
            } finally {
              setDropStatus('')
            }
          }}
        />
        {dropStatus && (
          <div
            role="status"
            className="absolute inset-x-3 bottom-3 rounded-md border bg-popover p-3 text-sm"
          >
            {dropStatus}
          </div>
        )}
        {(linkError || copyError || dropError) && (
          <div
            role="alert"
            className="absolute inset-x-3 bottom-3 flex items-center gap-3 rounded-md border bg-popover p-3 text-sm"
          >
            <span className="flex-1">
              {dropError
                ? `Could not add files: ${dropError}`
                : copyError
                  ? `Could not copy: ${copyError}`
                  : `Could not open link: ${linkError}`}
            </span>
            <Button
              size="sm"
              onClick={() => {
                setDropError('')
                setLinkError('')
                setCopyError('')
              }}
            >
              Dismiss
            </Button>
          </div>
        )}
        {error && (
          <div
            role="alert"
            className="absolute inset-x-3 bottom-3 flex items-center gap-3 rounded-md border bg-popover p-3 text-sm"
          >
            <span className="flex-1">{error}</span>
            <Button size="sm" onClick={() => setAttempt(attempt + 1)}>
              Reconnect
            </Button>
          </div>
        )}
      </div>
    </ActionMenu>
  )
}
