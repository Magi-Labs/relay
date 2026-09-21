import { draftKey, getDraft, setDraft } from './file-drafts'
import { Button } from '@/components/ui/button'
import { restoreEditor } from './editor-state'
import { useRef } from 'react'
import { useEffect, useState } from 'react'
import Editor, { DiffEditor, loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import { installMonacoDiffEditorDisposalGuard } from '@/lib/monaco-diff-editor-disposal'
import { diffEditorScrollbarOptions } from '@/components/editor/diff-editor-scrollbar-options'
globalThis.MonacoEnvironment = {
  getWorker: (_id, label) => {
    if (label === 'typescript' || label === 'javascript') {
      return new tsWorker()
    }
    if (label === 'json') {
      return new jsonWorker()
    }
    if (['css', 'scss', 'less'].includes(label)) {
      return new cssWorker()
    }
    if (['html', 'handlebars', 'razor'].includes(label)) {
      return new htmlWorker()
    }
    return new editorWorker()
  }
}
installMonacoDiffEditorDisposalGuard(monaco)
monaco.typescript.typescriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: true
})
monaco.typescript.javascriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: true
})
loader.config({ monaco })
export type OpenFile = {
  absolutePath?: string
  repo: string
  path: string
  scope?: 'working' | 'staged' | 'comparison'
  comparisonRef?: string
  line?: number
  column?: number
}
export function FileViewer({
  revision = 0,
  host,
  workspace,
  file,
  theme,
  openFile
}: {
  revision?: number
  host: string
  workspace: string
  file: OpenFile
  theme: string
  openFile: (file: OpenFile) => void
}) {
  const disposeView = useRef<(() => void) | undefined>(undefined)
  useEffect(
    () => () => {
      disposeView.current?.()
      disposeView.current = undefined
    },
    []
  )
  const [content, setContent] = useState<{
    version?: string
    text?: string
    original?: string
    modified?: string
    truncated?: boolean
    binary?: boolean
  }>()
  const key = draftKey(host, workspace, file)
  const [draft, updateDraft] = useState(() => getDraft(key))
  const [saving, setSaving] = useState(false)
  const saveRef = useRef<() => void>(() => {})
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const contentKey = JSON.stringify([
    host,
    workspace,
    file.repo,
    file.path,
    file.scope,
    file.comparisonRef
  ])
  const previousKey = useRef('')
  useEffect(() => {
    let active = true
    if (previousKey.current !== contentKey) {
      setContent(undefined)
    }
    previousKey.current = contentKey
    setLoading(true)
    setError('')
    window.relay
      .request<typeof content>(host, file.scope ? 'diff_content' : 'file', {
        workspace,
        repo: file.repo,
        path: file.path,
        comparison_ref: file.comparisonRef,
        scope: file.scope
      })
      .then((value) => {
        if (active) {
          setContent(value)
          updateDraft(getDraft(key))
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false)
        }
      })
      .catch((e) => {
        if (active) {
          setError(String(e))
        }
      })
    return () => {
      active = false
    }
  }, [host, workspace, file, revision, contentKey, key])
  const save = async () => {
    if (!draft || saving) {
      return
    }
    setSaving(true)
    setError('')
    try {
      const saved = await window.relay.request<NonNullable<typeof content>>(host, 'file_save', {
        workspace,
        repo: file.repo,
        path: file.path,
        text: draft.text,
        version: draft.version
      })
      setContent(saved)
      setDraft(key)
      updateDraft(undefined)
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }
  saveRef.current = () => {
    void save()
  }
  const language =
    {
      ts: 'typescript',
      tsx: 'typescript',
      js: 'javascript',
      jsx: 'javascript',
      py: 'python',
      rs: 'rust',
      json: 'json',
      md: 'markdown',
      css: 'css',
      html: 'html',
      sh: 'shell',
      go: 'go'
    }[file.path.split('.').pop() || ''] || 'plaintext'
  const options = {
    readOnly: !!file.scope || saving,
    scrollbar: diffEditorScrollbarOptions,
    minimap: { enabled: false },
    fontSize: 13,
    automaticLayout: true,
    scrollBeyondLastLine: false
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center border-b px-3 text-xs">
        <span className="flex-1 truncate">
          {file.repo.startsWith('@') ? '' : `${file.repo} / `}
          {file.path}
          {file.scope &&
            ` · ${file.scope === 'comparison' ? `vs ${file.comparisonRef || 'base'}` : file.scope} diff`}
        </span>
        <span className="ml-3 shrink-0 text-muted-foreground">
          {saving
            ? 'Saving…'
            : loading
              ? 'Refreshing…'
              : file.scope
                ? 'Read-only diff'
                : draft
                  ? 'Unsaved changes'
                  : 'Saved'}
        </span>
        {file.scope && (
          <Button
            className="ml-3"
            size="sm"
            variant="outline"
            onClick={() => openFile({ ...file, scope: undefined })}
          >
            Edit file
          </Button>
        )}
        {!file.scope && (
          <Button
            className="ml-3"
            size="sm"
            disabled={!draft || saving}
            onClick={() => void save()}
          >
            Save
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {!content ? (
        <p className="p-4 text-sm text-muted-foreground">Loading file…</p>
      ) : content.binary || content.truncated ? (
        <p className="p-4 text-sm text-muted-foreground">
          {content.binary
            ? 'Binary file. Preview unavailable.'
            : 'File exceeds the 2 MB preview limit.'}
        </p>
      ) : file.scope ? (
        <DiffEditor
          keepCurrentOriginalModel
          keepCurrentModifiedModel
          onMount={(editor) => {
            const model = editor.getModel()
            disposeView.current = restoreEditor(editor.getModifiedEditor(), host, workspace, file)
            editor.onDidDispose(() => {
              model?.original.dispose()
              model?.modified.dispose()
            })
          }}
          original={content.original}
          modified={content.modified}
          language={language}
          theme={theme === 'light' ? 'vs' : 'vs-dark'}
          options={{ ...options, renderSideBySide: true }}
        />
      ) : (
        <Editor
          onMount={(editor) => {
            disposeView.current = restoreEditor(editor, host, workspace, file)
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current())
          }}
          onChange={(text) => {
            if (text === undefined || !content.version) {
              return
            }
            const next = {
              text,
              original: draft?.original ?? content.text ?? '',
              version: draft?.version ?? content.version
            }
            setDraft(key, next)
            updateDraft(getDraft(key))
          }}
          value={draft?.text ?? content.text}
          language={language}
          theme={theme === 'light' ? 'vs' : 'vs-dark'}
          options={options}
        />
      )}
    </div>
  )
}
