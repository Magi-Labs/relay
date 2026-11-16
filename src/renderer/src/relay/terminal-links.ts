import { tableLinks, fragmentRange } from './terminal-table-links'
import type { Terminal, ILink, IBufferRange } from '@xterm/xterm'
import { extractTerminalFileLinkCandidates } from '@/lib/terminal-links'
import type { OpenFile } from './editor'
const modifier = (event: MouseEvent | KeyboardEvent) =>
  navigator.userAgent.includes('Mac') ? event.metaKey : event.ctrlKey
export function installTerminalLinks(
  term: Terminal,
  host: string,
  workspace: string,
  terminal: string,
  openFile: (file: OpenFile) => void,
  report: (error: unknown) => void
) {
  let disposed = false,
    held = false,
    hovered: ILink | undefined
  const decorate = () => {
    // While the link modifier is held, keep clicks local so mouse-tracking apps (Claude, tmux) don't swallow them.
    if (term.options.mouseEventsRequireAlt !== held) {
      term.options.mouseEventsRequireAlt = held
    }
    if (hovered?.decorations) {
      hovered.decorations.underline = held
      hovered.decorations.pointerCursor = held
    }
  }
  const key = (event: KeyboardEvent) => {
    held = modifier(event)
    decorate()
  }
  const blur = () => {
    held = false
    decorate()
  }
  window.addEventListener('keydown', key, true)
  window.addEventListener('keyup', key, true)
  window.addEventListener('blur', blur)
  const resolve = (paths: string[]) =>
    window.relay.request<(OpenFile | null)[]>(host, 'resolve_links', { workspace, terminal, paths })
  term.options.linkHandler = {
    allowNonHttpProtocols: true,
    activate(event, uri) {
      if (!modifier(event)) {
        return
      }
      event.preventDefault()
      if (/^https?:\/\//.test(uri)) {
        void window.relay.openExternal(uri).catch(report)
      } else if (uri.startsWith('file://')) {
        try {
          const path = decodeURIComponent(new URL(uri).pathname)
          void resolve([path])
            .then(([file]) => {
              if (file) {
                openFile(file)
              } else {
                throw new Error('File is unavailable on the execution host.')
              }
            })
            .catch(report)
        } catch (error) {
          report(error)
        }
      }
    }
  }
  const link = (text: string, range: IBufferRange, activate: () => Promise<void>): ILink => {
    const value: ILink = {
      text,
      range,
      decorations: { underline: held, pointerCursor: held },
      activate(event) {
        if (!modifier(event)) {
          return
        }
        event.preventDefault()
        term.clearSelection()
        void activate().catch(report)
      },
      hover(event) {
        hovered = value
        held = held || modifier(event)
        decorate()
      },
      leave() {
        if (hovered === value) {
          hovered = undefined
        }
      },
      dispose() {
        if (hovered === value) {
          hovered = undefined
        }
      }
    }
    return value
  }
  const provider = term.registerLinkProvider({
    provideLinks(row, callback) {
      const buffer = term.buffer.active
      let start = row - 1,
        end = row - 1
      while (start > 0 && buffer.getLine(start)?.isWrapped && row - start < 20) {
        start--
      }
      while (end + 1 < buffer.length && buffer.getLine(end + 1)?.isWrapped && end - start < 20) {
        end++
      }
      let text = ''
      const positions: { x: number; y: number }[] = []
      for (let y = start; y <= end; y++) {
        const line = buffer.getLine(y)
        if (!line) {
          continue
        }
        for (let x = 0; x < line.length; x++) {
          const cell = line.getCell(x)
          if (!cell || cell.getWidth() === 0) {
            continue
          }
          const chars = cell.getChars() || ' '
          for (let i = 0; i < chars.length; i++) {
            positions.push({ x: x + 1, y: y + 1 })
          }
          text += chars
        }
      }
      if (text.length > 8192) {
        callback(undefined)
        return
      }
      const range = (start: number, end: number): IBufferRange => ({
        start: positions[start],
        end: positions[end - 1]
      })
      const links: ILink[] = [],
        urls: [number, number][] = []
      const tableRows: string[] = [],
        tablePositions: { x: number; y: number }[][] = []
      for (let y = Math.max(0, row - 9); y < Math.min(buffer.length, row + 8); y++) {
        const line = buffer.getLine(y)
        let value = ''
        const cells: { x: number; y: number }[] = []
        for (let x = 0; line && x < Math.min(line.length, 1000); x++) {
          const cell = line.getCell(x)
          if (!cell || cell.getWidth() === 0) {
            continue
          }
          const chars = cell.getChars() || ' '
          for (let i = 0; i < chars.length; i++) {
            cells.push({ x: x + 1, y: y + 1 })
          }
          value += chars
        }
        tableRows.push(value)
        tablePositions.push(cells)
      }
      const tableRanges: IBufferRange[] = []
      for (const candidate of tableLinks(tableRows)) {
        for (const fragment of candidate.fragments) {
          const area = fragmentRange(fragment, tablePositions)
          tableRanges.push(area)
          if (area.start.y === row) {
            links.push(link(candidate.url, area, () => window.relay.openExternal(candidate.url)))
          }
        }
      }
      const inTable = (from: number, to: number) =>
        tableRanges.some((area) =>
          positions
            .slice(from, to)
            .some((pos) => pos.y === area.start.y && pos.x >= area.start.x && pos.x <= area.end.x)
        )
      for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/g)) {
        if (inTable(match.index, match.index + match[0].length)) {
          continue
        }
        const url = match[0].replace(/[.,;!?)\]]+$/, '')
        urls.push([match.index, match.index + match[0].length])
        links.push(
          link(url, range(match.index, match.index + url.length), () =>
            window.relay.openExternal(url)
          )
        )
      }
      const candidates = extractTerminalFileLinkCandidates(text)
        .filter((c) => !inTable(c.startIndex, c.endIndex))
        .filter((c) => !urls.some(([start, end]) => c.startIndex < end && c.endIndex > start))
        .slice(0, 64)
      if (!candidates.length) {
        callback(links)
        return
      }
      void resolve(candidates.map((c) => c.pathText))
        .then((files) => {
          if (disposed) {
            return
          }
          files.forEach((file, index) => {
            if (!file) {
              return
            }
            const candidate = candidates[index]
            links.push(
              link(
                candidate.displayText,
                range(candidate.startIndex, candidate.endIndex),
                async () => {
                  const [current] = await resolve([candidate.pathText])
                  if (!current) {
                    throw new Error('File is no longer available on the execution host.')
                  }
                  openFile({
                    ...current,
                    line: candidate.line || undefined,
                    column: candidate.column || undefined
                  })
                }
              )
            )
          })
          callback(links)
        })
        .catch(() => {
          if (!disposed) {
            callback(links)
          }
        })
    }
  })
  return () => {
    disposed = true
    provider.dispose()
    window.removeEventListener('keydown', key, true)
    window.removeEventListener('keyup', key, true)
    window.removeEventListener('blur', blur)
  }
}
