import { afterEach, expect, it, vi } from 'vitest'

const census = vi.hoisted(() => ({
  state: {} as any, phase: 'normal', now: 1, foreground: [] as string[],
  statusVisits: 0, bindingCopies: 0, boundaryCopies: 0, plannerStatuses: 0, plannerTabs: 0,
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
    getHibernationPtyBindingFirstSeenAtByPaneKey: () => {
      const result = real.getHibernationPtyBindingFirstSeenAtByPaneKey()
      if (census.phase === 'final') census.bindingCopies += Object.keys(result).length
      return result
    },
    getHibernationBoundaryResolvedAtByPaneKey: () => {
      const result = real.getHibernationBoundaryResolvedAtByPaneKey()
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

it.each([100, 1000])('real final sleep recheck at A=%i, B=3A, W=7.5A', async (n) => {
  vi.useFakeTimers()
  const leaf = '11111111-1111-4111-8111-111111111111'
  const tabsByWorktree: any = {}, terminalLayoutsByTabId: any = {}, ptyIdsByTabId: any = {}
  const statuses = new Map<string, any>()
  for (let i = 0; i < n * 7.5; i++) {
    const tab = { id: `tab-${i}`, worktreeId: `wt-${i}`, title: 'Agent', sortOrder: 0, createdAt: 1 }
    tabsByWorktree[tab.worktreeId] = [tab]
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
    statusVisits: 0, bindingCopies: 0, boundaryCopies: 0, plannerStatuses: 0, plannerTabs: 0, changeDuringAdmission: false })
  startAgentHibernationCoordinator({ now: () => census.now })
  await runAgentHibernationTick()
  for (let i = 0; i < n * 3; i++) recordHibernationBoundaryResolved(`tab-${i}:${leaf}`, 1)
  census.now = 120001
  await runAgentHibernationTick()
  await runAgentHibernationTick()
  expect(census.slept).toBe(1)
  expect(census.rechecks).toBe(1)
  expect(census.statusVisits).toBe(n)
  expect(census.bindingCopies).toBe(3 * n)
  expect(census.boundaryCopies).toBe(3 * n)
  expect(census.plannerStatuses).toBe(1)
  expect(census.plannerTabs).toBe(1)
  console.log('BENCH final-recheck', JSON.stringify({ head: '28d8654eb7880286977bb84cec7cfb543376159f', agents: n, bindings: 3*n, workspaces: 7.5*n,
    finalRechecks: census.rechecks, hostEvidenceStatusVisits: census.statusVisits, bindingEntriesCopied: census.bindingCopies,
    boundaryEntriesCopied: census.boundaryCopies, plannerStatusVisits: census.plannerStatuses, plannerTabs: census.plannerTabs }))
  census.changeDuringAdmission = true
  await runAgentHibernationTick()
  expect(census.rechecks).toBe(2)
  expect(census.slept).toBe(1)
  console.log('BENCH recheck-control', n, 'foreground-during-admission-refused=true')
}, 120000)

