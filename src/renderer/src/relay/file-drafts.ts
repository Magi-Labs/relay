import type { OpenFile } from './editor'
export type Draft = { text: string; original: string; version: string }
const drafts = new Map<string, Draft>()
export const draftKey = (host: string, workspace: string, file: OpenFile) =>
  JSON.stringify([host, workspace, file.absolutePath || [file.repo, file.path]])
export const getDraft = (key: string) => drafts.get(key)
export function setDraft(key: string, draft?: Draft) {
  if (!draft || draft.text === draft.original) {
    drafts.delete(key)
  } else {
    drafts.set(key, draft)
  }
}
export function discardDrafts(host: string, workspace: string, files: OpenFile[]) {
  const dirty = files.filter((file) => !file.scope && drafts.has(draftKey(host, workspace, file)))
  if (!dirty.length) {
    return true
  }
  if (!window.confirm(`Discard unsaved changes to ${dirty.map((file) => file.path).join(', ')}?`)) {
    return false
  }
  for (const file of dirty) {
    drafts.delete(draftKey(host, workspace, file))
  }
  return true
}
window.addEventListener('beforeunload', (event) => {
  if (drafts.size) {
    event.preventDefault()
    event.returnValue = ''
  }
})
