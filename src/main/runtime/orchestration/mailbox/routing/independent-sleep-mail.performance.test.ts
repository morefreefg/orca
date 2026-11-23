import { afterEach, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { partialRuntimeStore } from '../../../construction/test-context/runtime-store-partial-fixture'
import { getDefaultWorkspaceSession } from '../../../../../shared/orca-profiles/constants'
import { scopedCrewChange, sessionCrewChanges } from '../../crew/crew-changes'
import { SleptMailboxWake } from './slept-mailbox-wake'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { RuntimeNotifier } from '../../../client/events/runtime-notifier-contract'

const HEAD = '79678e1d774aa78218446b70947bef30e8eac7a2'
function sleeper(i: number, manual = true): SleepingAgentSessionRecord {
  const leaf = `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`
  return { paneKey: `tab-${i}:${leaf}`, tabId: `tab-${i}`, worktreeId: `folder:${i}`,
    terminalHandle: `term_${i}`, agent: 'codex', providerSession: { key: 'session_id', id: `conversation-${i}` },
    prompt: '', state: 'done', origin: 'worktree-sleep', capturedAt: 1, updatedAt: 1,
    restoreOnTabOpenOnly: manual }
}
const noop = () => {}
function notify(members: Partial<RuntimeNotifier>): RuntimeNotifier {
  return new Proxy(members, { get: (target, key) => Reflect.get(target, key) ?? noop }) as RuntimeNotifier
}
const flush = () => vi.advanceTimersByTimeAsync(10)
function mount(count: number, owed: boolean, manual = true) {
  const db = new OrchestrationDb(':memory:')
  let records = Object.fromEntries(Array.from({ length: count }, (_, i) => {
    const record = sleeper(i, manual)
    return [record.paneKey, record]
  }))
  let storeWritten: ((host: string | null) => void) | undefined
  const runtime = new OrcaRuntimeService(partialRuntimeStore({
    getWorkspaceSession: () => ({ ...getDefaultWorkspaceSession(), sleepingAgentSessionsByPaneKey: records }),
    getWorkspaceSessionHostIds: () => ['local'],
    onWorkspaceSessionWritten: (listener) => { storeWritten = listener; return noop }
  }), undefined, { getAgentStatusSnapshotForPane: (pane) => {
    const record = records[pane]
    return record ? [{ paneKey: pane, receivedAt: 1, paneSleep: { ptyId: `stopped-${record.terminalHandle}` } } as never] : []
  } })
  const mailboxes: string[] = []
  if (owed) for (const record of Object.values(records)) {
    const run = db.createRun({ objective: 'owed', coordinatorHandle: null, coordinatorPaneKey: record.paneKey })
    const mailbox = `run:${run.id}`
    mailboxes.push(mailbox)
    db.insertMessage({ runId: run.id, from: 'worker', to: mailbox, subject: 'owed' })
  }
  const bell = vi.fn()
  runtime.setOrchestrationDb(db)
  runtime.setNotifier(notify({ sleepingMailChanged: bell }))
  const initialGraph = runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
  runtime.retrySleptMailboxWakes()
  return { db, runtime, records, mailboxes, bell, initialGraph,
    empty: () => { records = {}; storeWritten?.('local') } }
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

it.each([100, 1000])('empty sleeping population, %i reads/sends/changes', async (n) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
  const m = mount(0, false)
  try {
    await vi.advanceTimersByTimeAsync(5000)
    const refresh = vi.spyOn(SleptMailboxWake.prototype, 'refresh')
    const batch = vi.spyOn(SleptMailboxWake.prototype, 'batch')
    const sequence = vi.spyOn(m.db, 'getUndeliveredUnreadSequence')
    const sql = vi.spyOn(m.db.db, 'prepare')
    const crewBefore = (sessionCrewChanges as any).listeners.size
    const run = m.db.createRun({ objective: 'awake', coordinatorHandle: null, coordinatorPaneKey: null })
    for (let i = 0; i < n; i++) {
      const mail = m.db.insertMessage({ runId: run.id, from: 'worker', to: `run:${run.id}`, subject: 'awake' })
      m.runtime.notifyMessageArrived(`run:${run.id}`, 'status')
      await m.runtime.readSleepingMailHold(`run:${run.id}`)
      m.db.markAsRead([mail.id], { kind: 'orca' })
      m.db.crewChanges.notify(scopedCrewChange(['topology'], { dispatchIds: new Set([`other-${i}`]) }))
      await flush()
    }
    const readMailboxSql = sql.mock.calls.filter(([query]) => query.includes('SELECT DISTINCT to_handle')).length
    const counts = { refresh: refresh.mock.calls.length, batch: batch.mock.calls.length,
      sequence: sequence.mock.calls.length, readMailboxSql, sessionListeners: crewBefore, runtimeCrewListeners: (m.runtime as any).crewChanges.listeners.size, runtimeClientListeners: (m.runtime as any).clientEvents.listeners.size, terminalSideEffectConsumers: (m.runtime as any).clientEvents.countTerminalSideEffectConsumers() }
    console.log('BENCH empty', HEAD, n, JSON.stringify(counts))
    expect([counts.refresh, counts.batch, counts.sequence, readMailboxSql]).toEqual([0, 0, 0, 0])
  } finally { m.empty(); await flush(); m.runtime.setNotifier(null); m.db.close() }
}, 120000)

it.each([100, 1000])('scoped and availability work with %i held panes', async (s) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
  const m = mount(s, true)
  try {
    await vi.advanceTimersByTimeAsync(5000)
    const reads = [vi.spyOn(m.db, 'getRun'), vi.spyOn(m.db, 'getDispatchContextById'), vi.spyOn(m.db, 'getRemoteDispatchAttachment')]
    const refresh = vi.spyOn(SleptMailboxWake.prototype, 'refresh')
    m.bell.mockClear()
    const scoped: number[][] = []
    for (let i = 0; i < 10; i++) {
      reads.forEach((r) => r.mockClear()); refresh.mockClear()
      m.db.crewChanges.notify(Object.assign(new Set(['traffic'] as const), { trafficAddresses: new Set([`run:unrelated-${i}`]) }))
      m.db.crewChanges.notify(scopedCrewChange(['topology'], { dispatchIds: new Set([`unrelated-${i}`]) }))
      await flush()
      scoped.push([...reads.map((r) => r.mock.calls.length), refresh.mock.calls.length])
    }
    expect(scoped).toEqual(Array.from({ length: 10 }, () => [1, 1, 1, 2]))
    refresh.mockClear(); reads.forEach((r) => r.mockClear())
    for (let i = 0; i < 10; i++) { m.runtime.retrySleptMailboxWakes(undefined, true); await flush() }
    const availability = refresh.mock.calls.length
    expect(availability).toBe(10 * s)
    expect(m.bell).toHaveBeenCalledTimes(0)
    const listenersHeld = (sessionCrewChanges as any).listeners.size
    const idleRefresh = refresh.mock.calls.length
    await vi.advanceTimersByTimeAsync(60000)
    expect(refresh.mock.calls.length - idleRefresh).toBe(0)
    console.log('BENCH held', HEAD, s, JSON.stringify({ scopedPerChange: scoped[0], availabilityPerEdge: availability / 10,
      heldPublications: m.bell.mock.calls.length, listenersHeld, runtimeCrewListeners: (m.runtime as any).crewChanges.listeners.size, runtimeClientListeners: (m.runtime as any).clientEvents.listeners.size, idleRefreshes60s: 0 }))
    const consumed = m.db.getUndeliveredUnreadMessages(m.mailboxes[0]).map((row) => row.id)
    m.db.markAsRead(consumed, { kind: 'orca' })
    await flush()
    expect(m.bell).toHaveBeenCalledTimes(1)
    expect(m.bell.mock.calls[0][0]).toEqual({ held: [], released: ['folder:0'] })
    console.log('BENCH held-local-change', HEAD, s, JSON.stringify({ changedWorkspaces: 1,
      publications: m.bell.mock.calls.length, publishedIds: m.bell.mock.calls[0][0].held.length + m.bell.mock.calls[0][0].released.length,
      payloadBytes: Buffer.byteLength(JSON.stringify(m.bell.mock.calls[0][0])) }))
    m.bell.mockClear()
    for (const mailbox of m.mailboxes.slice(1, 51)) {
      m.db.markAsRead(m.db.getUndeliveredUnreadMessages(mailbox).map((row) => row.id), { kind: 'orca' })
    }
    await flush()
    expect(m.bell).toHaveBeenCalledTimes(1)
    expect(m.bell.mock.calls[0][0].released).toHaveLength(50)
    expect(m.bell.mock.calls[0][0].held).toHaveLength(0)
    console.log('BENCH held-burst', HEAD, s, JSON.stringify({ changes: 50,
      publications: m.bell.mock.calls.length, publishedIds: m.bell.mock.calls[0][0].held.length + m.bell.mock.calls[0][0].released.length }))
    m.empty(); await flush()
    console.log('BENCH teardown', s, JSON.stringify({ sessionListeners: (sessionCrewChanges as any).listeners.size }))
    expect((sessionCrewChanges as any).listeners.size).toBe(listenersHeld - 1)
  } finally { m.runtime.setNotifier(null); m.db.close() }
}, 120000)

it.each([100, 1000])('real slept-handle wait census and burst joins at %i panes', async (s) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
  const m = mount(s, false, false)
  const records = Object.values(m.records)
  const tabs = records.map((r) => ({ tabId: r.tabId!, worktreeId: r.worktreeId, title: 'Agent', activeLeafId: r.paneKey.split(':')[1], layout: null }))
  const leaves = records.map((r) => ({ tabId: r.tabId!, worktreeId: r.worktreeId, leafId: r.paneKey.split(':')[1], paneRuntimeId: 1, ptyId: null }))
  const cancel = new AbortController()
  try {
    await m.initialGraph
    await m.runtime.syncWindowGraph(1, { tabs: [...tabs, { tabId: 'unrelated-tab', worktreeId: 'folder:unrelated', title: 'Before', activeLeafId: null, layout: null }], leaves })
    await vi.advanceTimersByTimeAsync(5000)
    const handles = records.map((r) => m.runtime.getTerminalHandleForPaneKey(r.paneKey)!)
    expect(new Set(handles).size).toBe(s)
    const waiting = handles.map((handle) => m.runtime.waitForTerminal(handle, { condition: 'exit', signal: cancel.signal }).catch(() => undefined))
    const checks = vi.spyOn(m.runtime as any, 'wokenHandlePtyId')
    checks.mockClear()
    // A real identity producer for an unrelated terminal, without graph mutation.
    for (let event = 0; event < 10; event++) {
      ;(m.runtime as any).recordPtyWorktree(`unrelated-${event}`, 'folder:unrelated', { connected: true })
      await flush()
    }
    const unrelatedChecks = checks.mock.calls.length
    expect(unrelatedChecks).toBe(0)
    console.log('BENCH wait-fanout', HEAD, s, JSON.stringify({ unrelatedIdentityEvents: 10, unrelatedIdentityChecks: unrelatedChecks, checksPerEvent: unrelatedChecks / 10,
      pendingWaits: (m.runtime as any).wokenHandleChecks.size, runtimeCrewListeners: (m.runtime as any).crewChanges.listeners.size }))
    checks.mockClear()
    for (let event = 0; event < 10; event++) {
      await m.runtime.syncWindowGraph(1, { tabs: [...tabs, {
        tabId: 'unrelated-tab', worktreeId: 'folder:unrelated', title: 'After-' + event,
        activeLeafId: null, layout: null
      }], leaves })
      await flush()
    }
    const graphChecks = checks.mock.calls.length
    expect(graphChecks).toBe(0)
    console.log('BENCH graph-fanout', HEAD, s, JSON.stringify({
      unrelatedTitlePublications: 10, checks: graphChecks, checksPerPublication: graphChecks / 10,
      handleTouchListeners: (m.runtime as any).terminalIdentity.handleTouches.listeners.size
    }))
    checks.mockClear()
    const extraLeaf = { tabId: 'unrelated-tab', worktreeId: 'folder:unrelated',
      leafId: '99999999-1111-4111-8111-111111111111', paneRuntimeId: 1, ptyId: null }
    for (let event = 0; event < 10; event++) {
      await m.runtime.syncWindowGraph(1, { tabs: [...tabs, { tabId: 'unrelated-tab', worktreeId: 'folder:unrelated', title: 'Other', activeLeafId: extraLeaf.leafId, layout: null }], leaves: [...leaves, extraLeaf] })
      await flush()
      await m.runtime.syncWindowGraph(1, { tabs: [...tabs, { tabId: 'unrelated-tab', worktreeId: 'folder:unrelated', title: 'Other', activeLeafId: null, layout: null }], leaves })
      await flush()
    }
    const dropChecks = checks.mock.calls.length
    console.log('BENCH unrelated-leaf-drop', HEAD, s, JSON.stringify({ events: 10, checks: dropChecks, checksPerEvent: dropChecks / 10 }))
    expect(dropChecks).toBe(10 * s)
    cancel.abort(); await Promise.all(waiting)
    // Exercise real shared wake map, workspace command queue, handle watcher and join deadlines.
    // The external process/readiness boundary is controlled; no agent process is spawned.
    let release!: () => void
    const barrier = new Promise<void>((resolve) => { release = resolve })
    const resumes = vi.fn(async () => { await barrier; return true })
    m.runtime.setNotifier(notify({ resumeSleepingAgents: resumes }))
    vi.spyOn((m.runtime as any).terminalWait, 'wait').mockImplementation(async (handle: string) => ({ handle, condition: 'tui-idle', satisfied: true, status: 'running', exitCode: null }))
    const joined = handles.flatMap((handle) => Array.from({ length: 10 }, () => m.runtime.wakeSleptAgentHandle(handle, { timeoutMs: 120000 })!))
    await flush()
    expect(resumes).toHaveBeenCalledTimes(s)
    release(); await flush()
    for (let i = 0; i < handles.length; i++) {
      const handle = handles[i]
      const identity = (m.runtime as any).terminalIdentity
      const old = identity.handles.get(handle)
      ;(m.runtime as any).recordPtyWorktree(`resumed-${i}`, records[i].worktreeId, { connected: true })
      identity.setHandle(handle, { ...old, ptyId: `resumed-${i}` })
    }
    await flush()
    expect(await Promise.all(joined)).toHaveLength(10 * s)
    expect(resumes).toHaveBeenCalledTimes(s)
    expect((m.runtime as any).sleptAgentWakes.size).toBe(0)
    await flush()
    expect((m.runtime as any).wokenHandleChecks.size).toBe(0)
    expect((m.runtime as any).stopWatchingWokenHandles).toBe(null)
    console.log('BENCH burst', HEAD, s, JSON.stringify({ callers: 10 * s, resumes: resumes.mock.calls.length,
      retainedJoins: (m.runtime as any).sleptAgentWakes.size, retainedWaits: (m.runtime as any).wokenHandleChecks.size }))
  } finally { cancel.abort(); m.empty(); await flush(); m.runtime.setNotifier(null); m.db.close() }
}, 120000)

it.each([100, 1000])('mail wake queue admits once per pane at %i panes', async (s) => {
  const db = new OrchestrationDb(':memory:')
  const records = new Map<string, SleepingAgentSessionRecord>()
  const mailboxes: string[] = []
  let release!: () => void
  const barrier = new Promise<void>((resolve) => { release = resolve })
  let active = 0, maxActive = 0, resumes = 0
  try {
    for (let i = 0; i < s; i++) {
      const record = sleeper(i, false)
      records.set(record.paneKey, record)
      const run = db.createRun({ objective: 'burst', coordinatorHandle: null, coordinatorPaneKey: record.paneKey })
      const mailbox = `run:${run.id}`
      db.insertMessage({ runId: run.id, from: 'worker', to: mailbox, subject: 'burst' })
      mailboxes.push(mailbox)
    }
    const queue = new SleptMailboxWake({ db: () => db, record: (key) => records.get(key) ?? null,
      waiters: () => undefined, prepare: async () => {}, wake: async () => {
        resumes++; active++; maxActive = Math.max(active, maxActive)
        await barrier; active--; return true
      } })
    for (const mailbox of mailboxes) for (let i = 0; i < 10; i++) queue.request(mailbox)
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(resumes).toBe(2)
    expect((queue as any).pending.size).toBe(s - 2)
    release()
    for (let i = 0; i < s * 20; i++) await Promise.resolve()
    expect(resumes).toBe(s)
    expect(maxActive).toBe(2)
    expect((queue as any).pending.size).toBe(0)
    expect((queue as any).inFlight.size).toBe(0)
    console.log('BENCH mail-burst', HEAD, s, JSON.stringify({ requests: 10 * s, resumes, maxActive,
      retainedPending: (queue as any).pending.size, retainedInFlight: (queue as any).inFlight.size }))
  } finally { release?.(); db.close() }
}, 120000)
