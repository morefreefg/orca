import { afterEach, expect, it, vi } from 'vitest'

const cards = vi.hoisted(() => ({ entries: [] as { calls: number; dispose: () => void }[] }))
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(),
  useSyncExternalStore: (subscribe: (listener: () => void) => () => void, snapshot: () => unknown) => {
    const entry = { calls: 0, dispose: () => {} }
    entry.dispose = subscribe(() => entry.calls++)
    cards.entries.push(entry)
    return snapshot()
  }
}))
const census = vi.hoisted(() => ({
  state: {} as any, phase: 'normal', now: 1, foreground: [] as string[],
  statusVisits: 0, tabVisits: 0, bindingCopies: 0, boundaryCopies: 0, plannerStatuses: 0, plannerTabs: 0,
  slept: 0, rechecks: 0, changeDuringAdmission: false
}))
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => census.state } }))
vi.mock('../../workspace/ownership/terminal-worktree-route', () => ({
  resolveTerminalPtyOwner: () => ({ kind: 'non-runtime' })
}))
vi.mock('../../pane-manager/mobile-driver-state', () => ({ getAllDrivers: () => new Map() }))
vi.mock('../../../components/terminal-pane/parking/retention/foreground-terminal-tabs', () => ({
  getForegroundTerminalTabIds: () => census.foreground,
  getForegroundTerminalTabLastSeenAtById: () => ({})
}))
vi.mock('./agent-hibernation-output-activity', () => ({ getAgentHibernationOutputSignature: () => 'quiet' }))
vi.mock('../../terminal/input/terminal-input-activity-coalescing', () => ({
  mergePendingTerminalInputActivity: (stamps: unknown) => stamps
}))
vi.mock('../../window-activity/window-park-visibility', () => ({
  getWindowParkVisible: () => true, subscribeWindowParkVisibility: () => () => {}
}))
vi.mock('./agent-hibernation-pane-age', async (original) => {
  const real = await original<typeof import('./agent-hibernation-pane-age')>()
  return { ...real,
    getHibernationPtyBindingFirstSeenAtByPaneKey: (paneKey?: string) => {
      const result = real.getHibernationPtyBindingFirstSeenAtByPaneKey(paneKey)
      if (census.phase === 'final') census.bindingCopies += Object.keys(result).length
      return result
    },
    getHibernationBoundaryResolvedAtByPaneKey: (paneKey?: string) => {
      const result = real.getHibernationBoundaryResolvedAtByPaneKey(paneKey)
      if (census.phase === 'final') census.boundaryCopies += Object.keys(result).length
      return result
    }
  }
})
vi.mock('./agent-hibernation-planner', async (original) => {
  const real = await original<typeof import('./agent-hibernation-planner')>()
  return { ...real, planAgentHibernationCandidates: (snapshot: any) => {
    if (census.phase === 'final') {
      census.plannerStatuses += snapshot.agentStatusByPaneKey.size
      census.plannerTabs += Object.values(snapshot.tabsByWorktree).reduce((n: number, tabs: any) => n + tabs.length, 0)
    }
    return real.planAgentHibernationCandidates(snapshot)
  } }
})
import { runAgentHibernationTick, startAgentHibernationCoordinator, stopAgentHibernationCoordinator } from './agent-hibernation-coordinator'
import { recordHibernationBoundaryResolved } from './agent-hibernation-pane-age'

afterEach(() => { stopAgentHibernationCoordinator(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it.each([{n:100, concentrated:false}, {n:1000, concentrated:false}, {n:100, concentrated:true}, {n:1000, concentrated:true}])('real final sleep recheck at $n, concentrated=$concentrated', async ({n, concentrated}) => {
  vi.useFakeTimers()
  const leaf = '11111111-1111-4111-8111-111111111111'
  const tabsByWorktree: any = {}, terminalLayoutsByTabId: any = {}, ptyIdsByTabId: any = {}
  const statuses = new Map<string, any>()
  for (let i = 0; i < n * 7.5; i++) {
    const tab = { id: `tab-${i}`, worktreeId: concentrated && i < n ? 'wt-0' : `wt-${i}`, title: 'Agent', sortOrder: 0, createdAt: 1 }
    ;(tabsByWorktree[tab.worktreeId] ??= []).push(tab)
    if (i < n * 3) {
      terminalLayoutsByTabId[tab.id] = { root: { type: 'leaf', leafId: leaf }, activeLeafId: leaf, ptyIdsByLeafId: { [leaf]: `pty-${i}` } }
      ptyIdsByTabId[tab.id] = [`pty-${i}`]
    }
    if (i < n) statuses.set(`${tab.id}:${leaf}`, {
      paneKey: `${tab.id}:${leaf}`, tabId: tab.id, worktreeId: tab.worktreeId,
      state: i === 0 ? 'done' : 'working', agentType: 'codex', stateStartedAt: 1, updatedAt: 1,
      providerSession: { key: 'session_id', id: `conversation-${i}` }, prompt: '', stateHistory: []
    })
  }
  for (const tabs of Object.values(tabsByWorktree) as any[]) {
    for (const method of ['filter', 'flatMap'] as const) {
      const original = tabs[method].bind(tabs)
      tabs[method] = (callback: any) => original((...args: any[]) => {
        if (census.phase === 'final') census.tabVisits++
        return callback(...args)
      })
    }
  }
  const realGet = statuses.get.bind(statuses)
  statuses.get = (key: string) => {
    if (census.phase === 'final') census.statusVisits++
    return realGet(key)
  }
  const realValues = statuses.values.bind(statuses)
  statuses.values = function* () {
    for (const row of realValues()) {
      if (census.phase === 'final') census.statusVisits++
      yield row
    }
  }
  const attention = vi.fn(async () => ({}))
  vi.stubGlobal('window', { api: { pty: { getTerminalAttention: attention }, ui: { notifySleepingMailAvailability: () => {} } } })
  census.state = {
    settings: { experimentalAgentHibernation: true, agentHibernationIdleMs: 60000 },
    tabsByWorktree, terminalLayoutsByTabId, ptyIdsByTabId, agentStatusByPaneKey: statuses,
    sleepingAgentSessionsByPaneKey: {}, lastTerminalInputAtByPaneKey: {}, activeWorktreeId: null,
    shutdownCompletedAgentPaneForHibernation: async (_worktree: string, options: any) => {
      census.phase = 'final'; census.rechecks++
      if (census.changeDuringAdmission) census.foreground = ['tab-0']
      if (await options.stillEligible()) census.slept++
      census.phase = 'normal'
    }
  }
  Object.assign(census, { phase: 'normal', now: 1, foreground: [], slept: 0, rechecks: 0,
    statusVisits: 0, tabVisits: 0, bindingCopies: 0, boundaryCopies: 0, plannerStatuses: 0, plannerTabs: 0, changeDuringAdmission: false })
  startAgentHibernationCoordinator({ now: () => census.now })
  await runAgentHibernationTick()
  for (let i = 0; i < n * 3; i++) recordHibernationBoundaryResolved(`tab-${i}:${leaf}`, 1)
  census.now = 120001
  await runAgentHibernationTick()
  await runAgentHibernationTick()
  expect(census.slept).toBe(1)
  expect(census.rechecks).toBe(1)
  expect(census.statusVisits).toBe(2)
  expect(census.bindingCopies).toBe(1)
  expect(census.boundaryCopies).toBe(1)
  expect(census.plannerStatuses).toBe(1)
  expect(census.plannerTabs).toBe(1)
  expect(census.tabVisits).toBe(5 * (concentrated ? n : 1))
  console.log('BENCH final-recheck', JSON.stringify({ head: '79678e1d774aa78218446b70947bef30e8eac7a2', agents: n, bindings: 3*n, workspaces: Object.keys(tabsByWorktree).length, siblingTabs: concentrated ? n : 1, producerTabVisits: census.tabVisits,
    finalRechecks: census.rechecks, producerStatusReads: census.statusVisits, bindingEntriesCopied: census.bindingCopies,
    boundaryEntriesCopied: census.boundaryCopies, plannerStatusVisits: census.plannerStatuses, plannerTabs: census.plannerTabs }))
  census.changeDuringAdmission = true
  await runAgentHibernationTick()
  expect(census.rechecks).toBe(2)
  expect(census.slept).toBe(1)
  console.log('BENCH recheck-control', n, 'foreground-during-admission-refused=true')
}, 120000)



it.each([100, 1000])('held-mail card subscriptions at %i workspaces', async (n) => {
  const { applySleepingMailWorktrees, useHasSleepingMail } = await import('../../../attention/sleeping-mail-worktrees')
  applySleepingMailWorktrees({ worktreeIds: [] })
  cards.entries = []
  for (let i = 0; i < n; i++) useHasSleepingMail(`card-${i}`)
  applySleepingMailWorktrees({ worktreeIds: Array.from({ length: n }, (_, i) => `card-${i}`) })
  expect(cards.entries.reduce((sum, e) => sum + e.calls, 0)).toBe(n)
  for (const entry of cards.entries) entry.calls = 0
  applySleepingMailWorktrees({ held: [], released: ['card-0'] })
  expect(cards.entries.map((e) => e.calls)).toEqual([1, ...Array(n - 1).fill(0)])
  for (const entry of cards.entries) entry.calls = 0
  applySleepingMailWorktrees({ held: ['unrelated'], released: [] })
  expect(cards.entries.reduce((sum, e) => sum + e.calls, 0)).toBe(0)
  for (const entry of cards.entries) entry.dispose()
  applySleepingMailWorktrees({ worktreeIds: [] })
  expect(cards.entries.reduce((sum, e) => sum + e.calls, 0)).toBe(0)
  console.log('BENCH renderer-cards', n, JSON.stringify({ subscriptions: n, localChangeCallbacks: 1, unrelatedChangeCallbacks: 0, teardownCallbacks: 0 }))
})
