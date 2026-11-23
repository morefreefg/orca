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
  owner: 'non-runtime' as 'non-runtime' | 'ambiguous', state: {} as any, phase: 'normal', now: 1, foreground: [] as string[],
  ownerPtyChecks: 0, statusVisits: 0, tabVisits: 0, bindingCopies: 0, boundaryCopies: 0, plannerStatuses: 0, plannerTabs: 0,
  foregroundCopies: 0, slept: 0, rechecks: 0, changeDuringAdmission: false
}))
vi.mock('../../../../../shared/remote-runtime/remote-runtime-pty-id', async (original) => {
  const real = await original<typeof import('../../../../../shared/remote-runtime/remote-runtime-pty-id')>()
  return { ...real, isRemoteRuntimePtyId: (id: string) => {
    if (census.phase === 'final') census.ownerPtyChecks++
    return real.isRemoteRuntimePtyId(id)
  } }
})
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => census.state } }))
vi.mock('../../workspace/ownership/terminal-worktree-route', () => ({
  resolveTerminalPtyOwner: () => ({ kind: census.owner })
}))
vi.mock('../../pane-manager/mobile-driver-state', () => ({ getAllDrivers: () => new Map() }))
vi.mock('../../../components/terminal-pane/parking/retention/foreground-terminal-tabs', async (original) => {
  const real = await original<typeof import('../../../components/terminal-pane/parking/retention/foreground-terminal-tabs')>()
  return { ...real, getForegroundTerminalTabIds: () => census.foreground,
    getForegroundTerminalTabLastSeenAtById: () => {
      const snapshot = real.getForegroundTerminalTabLastSeenAtById()
      if (census.phase === 'final') census.foregroundCopies += Object.keys(snapshot).length
      return snapshot
    }
  }
})
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

const populations = [100, 1000].map(n => ({ n, concentrated: false, owner: 'non-runtime' as const }))
it.each(populations)('real final sleep recheck at $n, concentrated=$concentrated, owner=$owner', async ({n, concentrated, owner}) => {
  vi.useFakeTimers()
  vi.setSystemTime(1)
  const foreground = await import('../../../components/terminal-pane/parking/retention/foreground-terminal-tabs')
  const historyIds = Array.from({length: n * 7.5}, (_, i) => `history-${i}`)
  foreground.setForegroundTerminalTabIds(historyIds)
  foreground.setForegroundTerminalTabIds([])
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
    for (const method of ['filter', 'flatMap', 'map', 'some', 'find'] as const) {
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
  Object.assign(census, { owner, phase: 'normal', now: 1, foreground: [], slept: 0, rechecks: 0,
    ownerPtyChecks: 0, statusVisits: 0, tabVisits: 0, bindingCopies: 0, boundaryCopies: 0, plannerStatuses: 0, plannerTabs: 0, changeDuringAdmission: false })
  census.foregroundCopies = 0
  startAgentHibernationCoordinator({ now: () => census.now })
  await runAgentHibernationTick()
  for (let i = 0; i < n * 3; i++) recordHibernationBoundaryResolved(`tab-${i}:${leaf}`, 1)
  census.now = 120001
  await runAgentHibernationTick()
  await runAgentHibernationTick()
  expect(census.slept).toBe(1)
  expect(census.rechecks).toBe(1)
  expect(census.foregroundCopies).toBe(n * 7.5)
  console.log('BENCH final-foreground-copies', JSON.stringify({head: '22ca84dded198ded40a3d2093f934d6b9c3f8479', historyTabs: n * 7.5, finalRechecks: census.rechecks, entriesCopied: census.foregroundCopies, targetTabs: census.plannerTabs, baseFinalCallbacks: 0}))
  expect(census.statusVisits).toBe(2)
  expect(census.bindingCopies).toBe(1)
  expect(census.boundaryCopies).toBe(1)
  expect(census.plannerStatuses).toBe(1)
  expect(census.plannerTabs).toBe(1)
  expect(census.tabVisits).toBe(0)
  expect(census.ownerPtyChecks).toBe(0)
  console.log('BENCH final-recheck', JSON.stringify({ head: '22ca84dded198ded40a3d2093f934d6b9c3f8479', owner, agents: n, bindings: 3*n, workspaces: Object.keys(tabsByWorktree).length, siblingTabs: concentrated ? n : 1, producerTabVisits: census.tabVisits, ownerPtyChecks: census.ownerPtyChecks,
    finalRechecks: census.rechecks, producerStatusReads: census.statusVisits, bindingEntriesCopied: census.bindingCopies,
    boundaryEntriesCopied: census.boundaryCopies, plannerStatusVisits: census.plannerStatuses, plannerTabs: census.plannerTabs }))
  census.changeDuringAdmission = true
  await runAgentHibernationTick()
  expect(census.rechecks).toBe(2)
  expect(census.slept).toBe(1)
  console.log('BENCH recheck-control', n, 'foreground-during-admission-refused=true')
  foreground.forgetForegroundTerminalTabs(historyIds)
}, 120000)



