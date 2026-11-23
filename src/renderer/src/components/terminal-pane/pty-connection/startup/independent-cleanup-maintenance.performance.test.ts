import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { sleepingAgentRecordIndex } from '@/store/terminals/sleep/sleeping-agent-record-index'
import { installSleepingRecordAccess } from './sleeping-record-access'

afterEach(() => vi.restoreAllMocks())
it.each([100, 1000])('actual store resume replacement and cleanup among %i conversations', n => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  let fields = 0
  const touched = new Set<number>()
  const leaf = '11111111-1111-4111-8111-111111111111'
  const records = Object.fromEntries(Array.from({ length: n }, (_, i) => {
    const paneKey = `tab-${i}:${leaf}`
    const record = { paneKey, tabId: `tab-${i}`, worktreeId: 'wt', origin: 'worktree-sleep', state: 'done',
      agent: 'codex', providerSession: { key: 'session_id', id: `conversation-${i}` }, capturedAt: 1, updatedAt: 1 }
    return [paneKey, new Proxy(record, { get(target, key, receiver) { fields++; touched.add(i); return Reflect.get(target, key, receiver) } })]
  }))
  useAppStore.setState({ sleepingAgentSessionsByPaneKey: records as never })
  sleepingAgentRecordIndex.update(records as never)
  let maxFields = 0
  let totalFields = 0
  let maxConversations = 0
  const snapshots = vi.spyOn(sleepingAgentRecordIndex, 'entries')
  for (let i = 0; i < n; i++) {
    fields = 0; touched.clear()
    const paneKey = `tab-${i}:${leaf}`
    const captured = records[paneKey]
    const session: any = { cacheKey: paneKey, deps: { worktreeId: 'wt', tabId: `tab-${i}` }, pane: { id: 1, leafId: leaf } }
    installSleepingRecordAccess(session)
    useAppStore.getState().rememberSleepingAgentSession({ ...captured, origin: 'live' } as never, captured as never)
    session.clearSleepingRecordProviderDuplicates(useAppStore.getState(), { paneKey, record: captured }, paneKey)
    maxFields = Math.max(maxFields, fields)
    maxConversations = Math.max(maxConversations, touched.size)
    totalFields += fields
    expect(touched.size).toBe(1)
    expect(fields).toBeLessThanOrEqual(100)
  }
  expect(snapshots).not.toHaveBeenCalled()
  expect(Object.keys(useAppStore.getState().sleepingAgentSessionsByPaneKey)).toHaveLength(n)
  console.log('BENCH cleanup-maintenance', JSON.stringify({ head: '6b8d0c43b72c4bb7da70477cd657c2b612d79f88', conversations: n, targets: n, maxConversations, maxFields, totalFields, workspaceSnapshots: snapshots.mock.calls.length }))
})
