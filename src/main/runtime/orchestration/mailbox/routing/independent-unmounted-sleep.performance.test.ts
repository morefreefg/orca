import { afterEach, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { OrchestrationDb } from '../../db/orchestration-db'
import { partialRuntimeStore } from '../../../construction/test-context/runtime-store-partial-fixture'
import { getDefaultWorkspaceSession } from '../../../../../shared/orca-profiles/constants'

const HEAD = 'd1eb8c9d8b9bbf06803f667085d2c942b8c26a32'
const noop = () => {}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

it.each([0, 100, 1000])('unmounted slept-handle act census among %i records', async s => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
  const records = Object.fromEntries(Array.from({ length: s }, (_, i) => {
    const leafId = `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`
    const paneKey = `tab-${i}:${leafId}`
    return [paneKey, { paneKey, tabId: `tab-${i}`, worktreeId: 'folder:bench', terminalHandle: `term_${i}`,
      agent: 'codex', providerSession: { key: 'session_id', id: `conversation-${i}` }, prompt: '',
      state: 'done', origin: 'worktree-sleep', capturedAt: 1, updatedAt: 1 }]
  }))
  let saved = records
  let written: ((host: string) => void) | undefined
  const db = new OrchestrationDb(':memory:')
  const runtime = new OrcaRuntimeService(partialRuntimeStore({
    getWorkspaceSession: () => ({ ...getDefaultWorkspaceSession(), sleepingAgentSessionsByPaneKey: saved as never }),
    getWorkspaceSessionHostIds: () => ['local'],
    onWorkspaceSessionWritten: callback => { written = callback; return noop }
  }))
  const r = runtime as any
  let resumed = 0
  const members = { resumeSleepingAgents: async (_wt: string, paneKey: string) => {
    resumed++
    const record = records[paneKey]
    const ptyId = `resumed-${resumed}`
    r.recordPtyWorktree(ptyId, record.worktreeId, { connected: true })
    runtime.registerPreAllocatedHandleForPty(ptyId, record.terminalHandle)
    return true
  } }
  runtime.setOrchestrationDb(db)
  runtime.setNotifier(new Proxy(members, { get: (target, key) => Reflect.get(target, key) ?? noop }) as never)
  const counts = { hits: 0, gets: 0, visits: 0, identityVisits: 0, handleIndex: 0, reverse: 0 }
  const reset = () => { for (const key of Object.keys(counts)) counts[key] = 0 }
  try {
    await runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    await vi.advanceTimersByTimeAsync(5000)
    vi.spyOn(r, 'getResolvedWorktreeMap').mockResolvedValue(new Map())
    vi.spyOn(r.terminalWait, 'wait').mockImplementation(async (handle: string) => ({ handle, condition: 'tui-idle', satisfied: true, status: 'running', exitCode: null }))
    const writes = vi.spyOn(r, 'writeTerminalAction').mockResolvedValue({ outcome: 'accepted' })
    for (let i = 0; i < Math.max(100, s); i++) r.terminalIdentity.bindPty(`unrelated-${i}`, `term_unrelated-${i}`)
    await vi.advanceTimersByTimeAsync(10)
    const sleep = r.sleepingRecords
    const realGet = sleep.get.bind(sleep)
    vi.spyOn(sleep, 'get').mockImplementation((key: string) => { counts.gets++; const value = realGet(key); if (value) counts.hits++; return value })
    for (const [map, counter] of [[sleep, 'visits'], [r.handles, 'identityVisits'], [r.handleByPtyId, 'identityVisits'], [r.ptysById, 'identityVisits']] as const) {
      for (const name of [Symbol.iterator, 'entries', 'values'] as const) {
        const original = map[name].bind(map)
        vi.spyOn(map, name as any).mockImplementation(function* () { for (const value of { [Symbol.iterator]: original }) { counts[counter]++; yield value } })
      }
    }
    const paneForHandle = r.sleepingRecordIndex.paneForHandle.bind(r.sleepingRecordIndex)
    vi.spyOn(r.sleepingRecordIndex, 'paneForHandle').mockImplementation((h: string) => { counts.handleIndex++; return paneForHandle(h) })
    const reverse = r.terminalIdentity.firstReversePtyId.bind(r.terminalIdentity)
    vi.spyOn(r.terminalIdentity, 'firstReversePtyId').mockImplementation((h: string) => { counts.reverse++; return reverse(h) })
    const acts: Record<string, unknown> = {}
    const measure = async (name: string, action: () => unknown) => {
      reset()
      let result: any
      let error: unknown
      try { result = await action() } catch (caught) { error = caught }
      acts[name] = { ...counts, status: result?.status, accepted: result?.accepted, error: error instanceof Error ? error.message : undefined }
      expect(counts.visits).toBe(0)
      expect(counts.identityVisits).toBe(0)
      expect(counts.gets).toBeLessThanOrEqual(20)
      if (s && name !== 'ordinary-registration') expect(error).toBeUndefined()
      if (!s) expect(counts.hits).toBe(0)
      return result
    }
    const h = (i: number) => s ? `term_${i}` : 'term_missing'
    const read = await measure('read', () => runtime.readTerminal(h(0), {}))
    if (s) expect(read.status).toBe('running')
    const shown = await measure('show', () => runtime.showTerminal(h(0)))
    if (s) expect(shown.handle).toBe(h(0))
    const idle = await measure('wait', () => runtime.waitForTerminal(h(0), { condition: 'tui-idle' }))
    if (s) expect(idle.satisfied).toBe(true)
    await measure('send', () => runtime.sendTerminal(h(1), { text: 'only once' }, { inputKind: 'orchestration' }))
    await measure('wake', () => runtime.wakeSleptAgentHandle(h(2), {}))
    expect(resumed).toBe(s ? 2 : 0)
    expect(writes.mock.calls.length).toBe(s ? 1 : 0)
    reset()
    const listed = await runtime.listTerminals(undefined, Math.max(1, s + 10), { includeVisualLayouts: false })
    const list = { ...counts, outputs: listed.terminals.length }
    expect(counts.visits).toBe(s)
    expect(counts.gets).toBeLessThanOrEqual(10 * s)
    if (s) expect(listed.terminals.filter(t => t.handle === 'term_0')).toHaveLength(1)
    await measure('ordinary-registration', () => runtime.registerPreAllocatedHandleForPty('ordinary-new', 'term_ordinary-new'))
    expect(counts.gets).toBe(0)
    expect(counts.handleIndex).toBe(0)
    expect(counts.reverse).toBe(1)
    expect(r.sleptWaits.size).toBe(0)
    expect(r.sleptAgentWakes.size).toBe(0)
    console.log('BENCH unmounted-acts', HEAD, JSON.stringify({ slept: s, reverseBindings: Math.max(100, s), acts, list, resumes: resumed, writes: writes.mock.calls.length }))
  } finally {
    vi.restoreAllMocks()
    saved = {}; written?.('local')
    await vi.advanceTimersByTimeAsync(10)
    runtime.setNotifier(null); db.close()
  }
}, 120000)
