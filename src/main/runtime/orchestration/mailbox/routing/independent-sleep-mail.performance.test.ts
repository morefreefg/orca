import { afterEach, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { partialRuntimeStore } from '../../../construction/test-context/runtime-store-partial-fixture'
import { getDefaultWorkspaceSession } from '../../../../../shared/orca-profiles/constants'
import { scopedCrewChange, sessionCrewChanges } from '../../crew/crew-changes'
import { SleptMailboxWake } from './slept-mailbox-wake'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { RuntimeNotifier } from '../../../client/events/runtime-notifier-contract'

const HEAD = '8b158734cf68241878246ef605134392cbd845ac'
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
    touchSession: () => storeWritten?.('local'), empty: () => { records = {}; storeWritten?.('local') } }
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
    // The bridge declines changes while its renderer document reloads. Unchanged mail must not rebuild the full set.
    m.bell.mockReturnValue(false)
    m.db.markAsRead(m.db.getUndeliveredUnreadMessages(m.mailboxes[51]).map(row => row.id), {kind:'orca'})
    await flush()
    m.bell.mockClear()
    const snapshot = vi.spyOn((m.runtime as any).sleptMailboxWake, 'heldWorktrees')
    for (let i=0; i<10; i++) {
      m.db.crewChanges.notify(Object.assign(new Set(['traffic'] as const), {trafficAddresses:new Set(['run:unrelated-drop-'+i])}))
      await flush()
    }
    m.db.markAsRead(m.db.getUndeliveredUnreadMessages(m.mailboxes[52]).map(row => row.id), {kind:'orca'})
    await flush()
    expect(snapshot).toHaveBeenCalledTimes(0)
    expect(m.bell).toHaveBeenCalledTimes(0)
    const rebuiltIds = m.bell.mock.calls.reduce((sum, [change]) => sum + change.worktreeIds.length, 0)
    expect(rebuiltIds).toBe(0)
    console.log('BENCH dropped-window', HEAD, s, JSON.stringify({ unrelatedEvents:10, fullRebuilds:snapshot.mock.calls.length, unchangedRebuiltIds:rebuiltIds }))
    m.bell.mockReturnValue(true); m.bell.mockClear()
    m.runtime.resendSleepingMailWorktrees(); await flush()
    expect(m.bell).toHaveBeenCalledTimes(1)
    expect(m.bell.mock.calls[0][0].worktreeIds).toHaveLength(s-53)
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
      pendingWaits: (m.runtime as any).sleptWaits.size, runtimeCrewListeners: (m.runtime as any).crewChanges.listeners.size }))
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
    expect(dropChecks).toBe(0)
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
    expect((m.runtime as any).sleptWakesByPane.size).toBe(0)
    await flush()
    expect((m.runtime as any).sleptWaits.size).toBe(0)
    expect((m.runtime as any).sleptWaits.stopWatching).toBe(null)
    console.log('BENCH burst', HEAD, s, JSON.stringify({ callers: 10 * s, resumes: resumes.mock.calls.length,
      retainedJoins: (m.runtime as any).sleptAgentWakes.size, retainedWaits: (m.runtime as any).sleptWaits.size }))
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

// PR #44113: count graph searches inside the real check when waited leaves leave together.
it.each([100, 1000])('closing waited leaves at %i panes', async (s) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
  const m = mount(s, false, false)
  const records = Object.values(m.records)
  const tabs = records.map((r) => ({ tabId: r.tabId!, worktreeId: r.worktreeId, title: 'Agent', activeLeafId: r.paneKey.split(':')[1], layout: null }))
  const leaves = records.map((r) => ({ tabId: r.tabId!, worktreeId: r.worktreeId, leafId: r.paneKey.split(':')[1], paneRuntimeId: 1, ptyId: null }))
  const cancel = new AbortController()
  const internals = m.runtime as any
  let waiting: Promise<unknown>[] = []
  try {
    await m.initialGraph
    await m.runtime.syncWindowGraph(1, { tabs, leaves })
    await vi.advanceTimersByTimeAsync(5000)
    const handles = records.map((r) => m.runtime.getTerminalHandleForPaneKey(r.paneKey)!)
    expect(new Set(handles).size).toBe(s)
    waiting = handles.map((handle) => m.runtime.waitForTerminal(handle, { condition: 'exit', signal: cancel.signal }).catch(() => undefined))
    expect(internals.sleptWaits.size).toBe(s)
    let leafVisits = 0
    const realCheck = internals.sleptPaneState.bind(m.runtime)
    const checks = vi.spyOn(internals, 'sleptPaneState').mockImplementation((...args: unknown[]) => {
      const graphLeaves = internals.leaves
      const originals = [Symbol.iterator, 'entries', 'values'].map(name => [name, graphLeaves[name]] as const)
      for (const [name, original] of originals) graphLeaves[name] = function* () {
        for (const leaf of { [Symbol.iterator]: () => original.call(graphLeaves) }) { leafVisits++; yield leaf }
      }
      try { return realCheck(...args) } finally { for (const [name, original] of originals) graphLeaves[name] = original }
    })
    await m.runtime.syncWindowGraph(1, { tabs: tabs.slice(0, s / 2), leaves: leaves.slice(0, s / 2) })
    await flush()
    console.log('BENCH waited-leaf-close', HEAD, s, JSON.stringify({ droppedWaitedLeaves: s / 2, remainingLeaves: s / 2, checks: checks.mock.calls.length, leafVisits }))
    expect(checks.mock.calls.length).toBe(s / 2)
    expect(leafVisits).toBe(0)
    // Saved records disappearing completes the removed panes' exit waits; survivors still wait.
    m.empty(); await flush()
    expect(internals.sleptWaits.size).toBe(s / 2)
    cancel.abort(); await Promise.all(waiting)
    expect(internals.sleptWaits.size).toBe(0)
    expect(internals.terminalIdentity.handleTouches.listeners.size).toBe(0)
    expect(internals.terminalIdentity.handleTouches.leafListeners.size).toBe(0)
  } finally { cancel.abort(); await Promise.all(waiting); m.empty(); await flush(); m.runtime.setNotifier(null); m.db.close() }
}, 120000)

it.each([100, 1000])('retained mail settlement during %i unrelated explicit wakes', async (n) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
  const m = mount(2*n, false, false)
  const records = Object.values(m.records)
  const internals = m.runtime as any
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const joined: Promise<unknown>[] = []
  try {
    await m.initialGraph
    await m.runtime.syncWindowGraph(1, {
      tabs: records.map(r => ({ tabId: r.tabId!, worktreeId: r.worktreeId, title: 'Agent', activeLeafId: r.paneKey.split(':')[1], layout: null })),
      leaves: records.map(r => ({ tabId: r.tabId!, worktreeId: r.worktreeId, leafId: r.paneKey.split(':')[1], paneRuntimeId: 1, ptyId: null }))
    })
    await vi.advanceTimersByTimeAsync(5000)
    const handles = records.slice(0,n).map(r => m.runtime.getTerminalHandleForPaneKey(r.paneKey)!)
    m.runtime.setNotifier(notify({ resumeSleepingAgents: async () => { await barrier; return true } }))
    vi.spyOn(internals.terminalWait, 'wait').mockImplementation(async (handle: string) => ({handle, satisfied: true, status: 'running'}))
    joined.push(...handles.map(handle => m.runtime.wakeSleptAgentHandle(handle, {})!))
    await flush()
    for (const record of records.slice(n)) expect(internals.mailWakeAttempts.claim(record)).toBeTruthy()
    let visited = 0
    const wakes = internals.sleptAgentWakes
    const original = wakes.values
    wakes.values = function* () { for (const entry of original.call(wakes)) { visited++; yield entry } }
    internals.publishSleepingMail({panes: records.slice(n).map(r => r.paneKey)})
    await flush()
    wakes.values = original
    expect(visited).toBe(0)
    expect(internals.mailWakeAttempts.size).toBe(0)
    console.log('BENCH retained-overlap', HEAD, JSON.stringify({ retainedAttempts: n, explicitWakes: n, custodyEntryVisits: visited, settledAttempts: n }))
    release(); await flush()
    for (let i=0; i<n; i++) {
      const old = internals.terminalIdentity.handles.get(handles[i])
      internals.recordPtyWorktree('overlap-resumed-'+i, records[i].worktreeId, {connected:true})
      internals.terminalIdentity.setHandle(handles[i], {...old, ptyId:'overlap-resumed-'+i})
    }
    await flush(); await Promise.all(joined)
    expect(internals.sleptAgentWakes.size).toBe(0)
    expect(internals.sleptWakesByPane.size).toBe(0)
  } finally { release?.(); m.empty(); await flush(); m.runtime.setNotifier(null); m.db.close() }
}, 120000)


it.each([750, 7500].flatMap(workspaces => [true, false].map(manual => ({workspaces, manual}))))(
  'held send receipt catalog visits among $workspaces workspaces, manual=$manual', async ({workspaces, manual}) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
  const m = mount(1, true, manual)
  try {
    await vi.advanceTimersByTimeAsync(5000)
    const r = m.runtime as any
    // A failed automatic wake uses the same receipt branch as a manual sleeper.
    if (!manual) r.sleptMailboxWake.failed.set(Object.keys(m.records)[0], 1)
    let visits = 0
    const worktrees = Array.from({length:workspaces}, (_, i) => ({
      get id() { visits++; return i === workspaces - 1 ? 'folder:0' : `folder:other-${i}` },
      displayName: i === workspaces - 1 ? 'Target workspace' : `Other ${i}`,
      hostId: 'local'
    }))
    await r.resolvedWorktrees.getSnapshot(async () => ({worktrees, platformByRepoId:new Map()}), 60000, 1)
    visits = 0
    const { sendDeliveryHoldWarning } = await import('../../../rpc/methods/orchestration/messaging/send-delivery-hold')
    const lookup = vi.spyOn(r.resolvedWorktrees, 'lookup')
    const counts: number[] = []
    for (let i=0;i<10;i++) {
      visits=0
      const warning = await sendDeliveryHoldWarning(m.runtime, m.db, m.mailboxes[0])
      expect(warning?.code).toBe('recipient_delivery_held')
      expect(warning?.message).toContain(manual ? 'Open its tab' : 'Target workspace')
      counts.push(visits)
    }
    expect(counts).toEqual(Array(10).fill(0))
    console.log('BENCH held-send-catalog', JSON.stringify({head:HEAD,workspaces,manual,receipts:10,visitsPerReceipt:counts[0],keyedLookupsPerReceipt:lookup.mock.calls.length/10,totalVisits:counts.reduce((a,b)=>a+b,0)}))
  } finally { m.empty(); await flush(); m.runtime.setNotifier(null); m.db.close() }
}, 120000)


it.each([100,1000])('pane availability snapshot and unnamed crew bursts at %i held mailboxes',async n=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date']})
 const m=mount(n,true)
 try{
  await vi.advanceTimersByTimeAsync(5000)
  const r=m.runtime as any
  let snapshotVisits=0
  for(const map of [r.sleptMailboxWake.owed,r.sleptMailboxWake.succeeded]){
   const keys=map.keys.bind(map)
   vi.spyOn(map,'keys').mockImplementation(function*(){for(const key of {[Symbol.iterator]:keys}){snapshotVisits++;yield key}})
  }
  const refresh=vi.spyOn(r.sleptMailboxWake,'refresh')
  m.runtime.retrySleptMailboxWakes(Object.keys(m.records)[0]);await flush()
  const paneCounts={snapshotVisits,refreshes:refresh.mock.calls.length}
  expect(snapshotVisits).toBe(0)
  refresh.mockClear();snapshotVisits=0
  const bursts=[]
  for(let second=0;second<3;second++){
   for(let event=0;event<n;event++)m.db.crewChanges.notify(new Set(['topology']))
   await vi.advanceTimersByTimeAsync(1000)
   bursts.push(refresh.mock.calls.length);refresh.mockClear()
  }
  expect(bursts).toEqual([n,n,n])
  await vi.advanceTimersByTimeAsync(60000)
  expect(refresh).toHaveBeenCalledTimes(0)
  console.log('BENCH availability-and-unnamed',JSON.stringify({head:HEAD,held:n,paneCounts,unnamedEventsPerBurst:n,mailboxRefreshesPerBurst:bursts,idleRefreshes60s:0}))
 }finally{m.empty();await flush();m.runtime.setNotifier(null);m.db.close()}
},120000)

it.each([100,1000])('scoped terminal list reads one of %i workspace sleep records',async n=>{
 vi.useFakeTimers({toFake:['setTimeout','Date']})
 const m=mount(n,false,false)
 try{
  await m.initialGraph;await vi.advanceTimersByTimeAsync(5000)
  const r=m.runtime as any
  vi.spyOn(r,'getResolvedWorktreeMap').mockResolvedValue(new Map())
  let globalVisits=0
  const values=r.sleepingRecords.values.bind(r.sleepingRecords)
  vi.spyOn(r.sleepingRecords,'values').mockImplementation(function*(){for(const row of {[Symbol.iterator]:values}){globalVisits++;yield row}})
  const gets=vi.spyOn(r.sleepingRecords,'get')
  const listed=await m.runtime.listTerminals('id:folder:0',n+10,{includeVisualLayouts:false})
  expect(globalVisits).toBe(0)
  expect(listed.terminals).toHaveLength(1)
  const scopedGets=gets.mock.calls.length
  gets.mockClear()
  const oneHandle=await m.runtime.listTerminals(undefined,n+10,{includeVisualLayouts:false,handles:['term_0']})
  expect(oneHandle.terminals).toHaveLength(1)
  const oneHandleGets=gets.mock.calls.length
  expect(globalVisits).toBe(0)
  console.log('BENCH scoped-list',JSON.stringify({head:HEAD,records:n,scopedGlobalVisits:0,scopedGets,outputs:listed.terminals.length,oneHandleGlobalVisits:globalVisits,oneHandleGets,oneHandleOutputs:oneHandle.terminals.length}))
 }finally{m.empty();await flush();m.runtime.setNotifier(null);m.db.close()}
},120000)

it.each([100,1000])('archive pruning extra leaf reads at %i unrelated panes',async n=>{
 vi.useFakeTimers({toFake:['setTimeout','Date']})
 const m=mount(0,false)
 try{
  await m.initialGraph
  const leaves=Array.from({length:n},(_,i)=>({tabId:'live-'+i,worktreeId:'folder:live',leafId:`${String(i).padStart(8,'0')}-1111-4111-8111-111111111111`,paneRuntimeId:1,ptyId:null}))
  await m.runtime.syncWindowGraph(1,{tabs:leaves.map(l=>({tabId:l.tabId,worktreeId:l.worktreeId,title:'Live',activeLeafId:l.leafId,layout:null})),leaves})
  await vi.advanceTimersByTimeAsync(5000)
  const r=m.runtime as any
  for(let i=0;i<128;i++)r.recordPtyWorktree('archive-'+i,'folder:other',{connected:false})
  let visits=0,calls=0
  const scan=r.isSleptPanePty.bind(r)
  vi.spyOn(r,'isSleptPanePty').mockImplementation((id:string)=>{
   calls++
   const iter=r.leaves[Symbol.iterator].bind(r.leaves)
   const probe=vi.spyOn(r.leaves,Symbol.iterator).mockImplementation(function*(){for(const row of {[Symbol.iterator]:iter}){visits++;yield row}})
   try{return scan(id)}finally{probe.mockRestore()}
  })
  for(let i=0;i<10;i++){
   const id='new-exit-'+i;r.recordPtyWorktree(id,'folder:other',{connected:true})
   await m.runtime.onPtyExit(id,0,undefined,{providerExitObserved:true})
  }
  expect({calls,visits}).toEqual({calls:1290,visits:0})
  console.log('BENCH archive-pruning',JSON.stringify({head:HEAD,leaves:n,exits:10,archiveKeyedChecksPerExit:calls/10,extraLeafVisitsPerExit:visits/10}))
 }finally{m.runtime.setNotifier(null);m.db.close()}
},120000)


it.each([100,1000])('retained wake owner rechecks probe %i historical Runs',async n=>{
 vi.useFakeTimers({toFake:['setTimeout','Date']})
 const m=mount(1,false,false)
 try{
  await m.initialGraph;await vi.advanceTimersByTimeAsync(5000)
  const pane=Object.keys(m.records)[0], record=m.records[pane]
  const runs=Array.from({length:n},(_,i)=>m.db.createRun({objective:'old-'+i,coordinatorHandle:null,coordinatorPaneKey:pane}))
  await flush()
  const r=m.runtime as any
  const prepare=m.db.db.prepare.bind(m.db.db)
  let probes=0,queries=0,rows=0
  m.db.db.function('perf_owner_probe',(id:unknown)=>{probes++;return id})
  vi.spyOn(m.db.db,'prepare').mockImplementation((sql:string)=>{
   if(!sql.includes('CROSS JOIN runs'))return prepare(sql)
   queries++
   const stmt=prepare(sql.replaceAll('substr(mail.to_handle, 5)','perf_owner_probe(substr(mail.to_handle, 5))'))
   return new Proxy(stmt,{get(target,key){if(key==='all')return (...args:any[])=>{const found=target.all(...args);rows+=found.length;return found};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})
  })
  r.mailWakeAttempts.claim(record)
  r.publishSleepingMail({panes:[pane]});await flush()
  const empty={queries,rows,probes}
  expect(empty).toEqual({queries:1,rows:0,probes:0})
  m.db.insertMessage({runId:runs[0].id,from:'worker',to:'run:'+runs[0].id,subject:'historical'})
  await flush()
  queries=rows=probes=0
  r.mailWakeAttempts.claim(record)
  r.publishSleepingMail({panes:[pane]});await flush()
  expect({queries,rows,probes}).toEqual({queries:1,rows:1,probes:1})
  console.log('BENCH retained-owner-history',JSON.stringify({head:HEAD,runs:n,empty,historical:{queries,rows,probes}}))
 }finally{m.empty();await flush();m.runtime.setNotifier(null);m.db.close()}
},120000)

it.each([100,1000])('unmounted read after unrelated graph title replacement at %i leaves',async n=>{
 vi.useFakeTimers({toFake:['setTimeout','Date']})
 const m=mount(1,false,false)
 try{
  await m.initialGraph
  const leaves=Array.from({length:n},(_,i)=>({tabId:'other-'+i,worktreeId:'folder:other',leafId:`${String(i+10000).padStart(8,'0')}-1111-4111-8111-111111111111`,paneRuntimeId:1,ptyId:null}))
  const tabs=leaves.map(l=>({tabId:l.tabId,worktreeId:l.worktreeId,title:'Other',activeLeafId:l.leafId,layout:null}))
  const r=m.runtime as any
  let visits=0
  const find=r.leavesByLeafId.find.bind(r.leavesByLeafId)
  vi.spyOn(r.leavesByLeafId,'find').mockImplementation((graph:any,id:string)=>{
   const iter=graph[Symbol.iterator].bind(graph)
   const probe=vi.spyOn(graph,Symbol.iterator).mockImplementation(function*(){for(const row of {[Symbol.iterator]:iter}){visits++;yield row}})
   try{return find(graph,id)}finally{probe.mockRestore()}
  })
  const counts=[]
  for(let i=0;i<10;i++){
   await m.runtime.syncWindowGraph(1,{tabs:tabs.map((t,j)=>j===0?{...t,title:'Other '+i}:t),leaves})
   visits=0
   expect((await m.runtime.readTerminal('term_0',{})).status).toBe('running')
   const cold=visits;visits=0
   expect((await m.runtime.readTerminal('term_0',{})).status).toBe('running')
   counts.push({cold,warm:visits})
  }
  expect(counts).toEqual(Array.from({length:10},()=>({cold:0,warm:0})))
  console.log('BENCH unmounted-graph-invalidations',JSON.stringify({head:HEAD,leaves:n,titlePublications:10,perRead:counts[0]}))
 }finally{m.empty();await flush();m.runtime.setNotifier(null);m.db.close()}
},120000)

it.each([100,1000])('empty sleep watcher enumerates %i saved hosts on each session write',async n=>{
 vi.useFakeTimers({toFake:['setTimeout','Date']})
 const m=mount(0,false)
 try{
  await m.initialGraph;await vi.advanceTimersByTimeAsync(5000)
  const {SessionHostPartitionOperations}=await import('../../../../persistence/loading-store/workspace-sessions/session-host-partitions')
  let visited=0
  const saved=new Proxy(Object.fromEntries(Array.from({length:n},(_,i)=>['host-'+i,{}])),{ownKeys(target){const keys=Reflect.ownKeys(target);visited+=keys.length;return keys}})
  const partitions=new SessionHostPartitionOperations({state:{workspaceSessionsByHostId:saved}} as any,{} as any,{} as any)
  const r=m.runtime as any
  vi.spyOn(r.store,'getWorkspaceSessionHostIds').mockImplementation(()=>partitions.getWorkspaceSessionHostIds())
  for(let i=0;i<10;i++)m.touchSession()
  expect(visited).toBe(0)
  console.log('BENCH empty-session-host-enumeration',JSON.stringify({head:HEAD,savedHosts:n,sessionWrites:10,sleepRecords:0,hostKeysVisitedPerWrite:visited/10}))
 }finally{m.runtime.setNotifier(null);m.db.close()}
},120000)
