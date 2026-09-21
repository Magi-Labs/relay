import { TerminalAgentIcon } from './agent-icon'
import { ActionMenu } from './action-menu'
import { useInteractions } from './workspace-actions'
import type { OpenFile } from './editor'
import { useEffect, useRef, useState } from 'react'
import type { PaneLayout, Workspace } from '../../../shared/relay/types'
import { SessionTerminal } from './terminal'
type Box = { left: number; top: number; width: number; height: number }
type Divider = Box & { id: string; axis: 'columns' | 'rows'; ratio: number }
function measure(
  tree: PaneLayout,
  box: Box,
  overrides: Record<string, number>,
  panes: (Box & { terminal: string })[],
  dividers: Divider[]
) {
  if ('terminal' in tree) {
    panes.push({ ...box, terminal: tree.terminal })
    return
  }
  const ratio = overrides[tree.id] ?? tree.ratio
  dividers.push({ ...box, id: tree.id, axis: tree.axis, ratio })
  const first = { ...box },
    second = { ...box }
  if (tree.axis === 'columns') {
    first.width *= ratio
    second.left += first.width
    second.width *= 1 - ratio
  } else {
    first.height *= ratio
    second.top += first.height
    second.height *= 1 - ratio
  }
  measure(tree.first, first, overrides, panes, dividers)
  measure(tree.second, second, overrides, panes, dividers)
}
export function TerminalLayout({
  visible = true,
  openFile,
  host,
  workspace,
  terminal,
  fontSize,
  theme,
  select,
  refresh
}: {
  visible?: boolean
  openFile: (file: OpenFile) => void
  host: string
  workspace: Workspace
  terminal: string
  fontSize: number
  theme: string
  select: (id: string) => void
  refresh: () => void
}) {
  const menus = useInteractions()
  const container = useRef<HTMLDivElement>(null)
  const [ratios, setRatios] = useState<Record<string, number>>({})
  const [error, setError] = useState('')
  const drag = useRef<{ id: string; value: number } | null>(null)
  useEffect(() => {
    if (!drag.current) {
      setRatios({})
    }
  }, [workspace.layouts])
  const active = workspace.terminals.find((t) => t.id === terminal)
  if (!active) {
    return null
  }
  const tab = active.tab_id || active.id
  const tree = workspace.layouts?.[tab] || { terminal }
  const panes: (Box & { terminal: string })[] = [],
    dividers: Divider[] = []
  measure(tree, { left: 0, top: 0, width: 100, height: 100 }, ratios, panes, dividers)
  const save = (id: string, ratio: number) => {
    void window.relay
      .request(host, 'terminal_resize', { workspace: workspace.id, node: id, ratio })
      .then(refresh)
      .catch((e) => setError(String(e)))
  }
  return (
    <div ref={container} className="relative h-full w-full min-h-0" data-terminal-layout>
      {panes.map((pane) => (
        <ActionMenu
          key={pane.terminal}
          actions={menus.terminal(
            workspace,
            workspace.terminals.find((t) => t.id === pane.terminal)!
          )}
        >
          <div
            key={pane.terminal}
            data-pane={pane.terminal}
            data-active={pane.terminal === terminal}
            className={`absolute min-h-0 min-w-0 overflow-hidden ${panes.length > 1 ? 'border' : ''} ${pane.terminal === terminal ? 'border-ring ring-1 ring-inset ring-ring/30' : 'border-border'}`}
            style={{
              left: `${pane.left}%`,
              top: `${pane.top}%`,
              width: `${pane.width}%`,
              height: `${pane.height}%`
            }}
            onPointerDownCapture={() => visible && select(pane.terminal)}
            onFocusCapture={() => visible && select(pane.terminal)}
          >
            {panes.length > 1 && (
              <span className="pointer-events-none absolute right-2 top-1 z-10 rounded bg-background/80 p-1">
                <TerminalAgentIcon terminal={pane.terminal} />
              </span>
            )}
            <SessionTerminal
              openFile={openFile}
              host={host}
              workspace={workspace.id}
              terminal={pane.terminal}
              fontSize={fontSize}
              theme={theme}
              active={visible && pane.terminal === terminal}
            />
          </div>
        </ActionMenu>
      ))}
      {dividers.map((d) => (
        <div
          key={d.id}
          role="separator"
          aria-label="Resize terminal split"
          aria-orientation={d.axis === 'columns' ? 'vertical' : 'horizontal'}
          aria-valuemin={10}
          aria-valuemax={90}
          aria-valuenow={Math.round(d.ratio * 100)}
          tabIndex={0}
          className={`absolute z-10 touch-none hover:bg-accent focus-visible:bg-accent ${d.axis === 'columns' ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'}`}
          style={
            d.axis === 'columns'
              ? {
                  left: `calc(${d.left + d.width * d.ratio}% - 2px)`,
                  top: `${d.top}%`,
                  height: `${d.height}%`
                }
              : {
                  top: `calc(${d.top + d.height * d.ratio}% - 2px)`,
                  left: `${d.left}%`,
                  width: `${d.width}%`
                }
          }
          title="Drag to resize; double-click to equalize"
          onDoubleClick={() => {
            setRatios((old) => ({ ...old, [d.id]: 0.5 }))
            save(d.id, 0.5)
          }}
          onPointerDown={(e) => {
            e.preventDefault()
            e.currentTarget.setPointerCapture(e.pointerId)
            drag.current = { id: d.id, value: d.ratio }
          }}
          onPointerMove={(e) => {
            if (drag.current?.id !== d.id || !container.current) {
              return
            }
            const rect = container.current.getBoundingClientRect()
            const position =
              d.axis === 'columns'
                ? (((e.clientX - rect.left) / rect.width) * 100 - d.left) / d.width
                : (((e.clientY - rect.top) / rect.height) * 100 - d.top) / d.height
            const value = Math.max(0.1, Math.min(0.9, position))
            drag.current.value = value
            setRatios((r) => ({ ...r, [d.id]: value }))
          }}
          onPointerUp={() => {
            if (drag.current?.id === d.id) {
              save(d.id, drag.current.value)
              drag.current = null
            }
          }}
          onPointerCancel={() => {
            drag.current = null
          }}
          onKeyDown={(e) => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
              return
            }
            e.preventDefault()
            const value = Math.max(
              0.1,
              Math.min(0.9, d.ratio + (['ArrowLeft', 'ArrowUp'].includes(e.key) ? -0.05 : 0.05))
            )
            setRatios((r) => ({ ...r, [d.id]: value }))
            save(d.id, value)
          }}
        />
      ))}
      {error && (
        <p
          role="alert"
          className="absolute bottom-2 left-2 z-20 bg-popover p-2 text-xs text-destructive"
        >
          {error}
        </p>
      )}
    </div>
  )
}
