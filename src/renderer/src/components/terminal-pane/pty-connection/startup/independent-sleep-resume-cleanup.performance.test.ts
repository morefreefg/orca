import { afterEach, expect, it, vi } from 'vitest'
const store = vi.hoisted(() => ({ state: {} as any }))
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => store.state } }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => store.state } }))
vi.mock('./saved-resume-startup-cancellation', () => ({ installSavedResumeStartupCancellation: () => {} }))
vi.mock('../agent-identity/command-inferred-pane-agent', () => ({ installCommandInferredPaneAgent: () => {} }))
import { installSleepingRecordAccess } from './sleeping-record-access'
import { sleepingAgentRecordIndex } from '@/store/terminals/sleep/sleeping-agent-record-index'
import { installHibernatedPaneWake, wakeHibernatedPaneIfArmed } from '../lifecycle/hibernated-pane-wake'
import { listenForHibernatedAgentWake } from '../../mounting/hibernated-agent-wake-listener'
import { dispatchHibernatedAgentWake } from '@/lib/agent-session/resume/hibernated-agent-wake-owners'

afterEach(() => vi.restoreAllMocks())
it.each([100, 1000])('targeted mounted resume cleanup among %i distinct conversations in one workspace', async n => {
  const leaf = '11111111-1111-4111-8111-111111111111'
  const records = Object.fromEntries(Array.from({ length: n }, (_, i) => {
    const paneKey = `tab-${i}:${leaf}`
    return [paneKey, { paneKey, tabId: `tab-${i}`, worktreeId: 'wt', origin: 'worktree-sleep', state: 'done',
      agent: 'codex', providerSession: { key: 'session_id', id: `conversation-${i}` }, capturedAt: 1, updatedAt: 1 }]
  }))
  store.state = { sleepingAgentSessionsByPaneKey: records, suppressedPtyExitIds: {}, clearSleepingAgentSession: vi.fn() }
  // Bootstrap once, so the counter measures resume cleanup, not the index's initial population.
  sleepingAgentRecordIndex.entries(records as never, 'wt')
  let visits = 0
  const realEntries = sleepingAgentRecordIndex.providerSessionEntries.bind(sleepingAgentRecordIndex)
  vi.spyOn(sleepingAgentRecordIndex, 'providerSessionEntries').mockImplementation((...args) => {
    const entries = realEntries(...args)
    return new Proxy(entries, { get(target, key, receiver) {
      if (key === Symbol.iterator) return function* () { for (const entry of target) { visits++; yield entry } }
      return Reflect.get(target, key, receiver)
    } })
  })
  const pending: Promise<string | null>[] = []
  const releases: (() => void)[] = []
  try {
    for (let i = 0; i < n; i++) {
      const cacheKey = `tab-${i}:${leaf}`
      const transport = { getPtyId: () => null, isConnected: () => false }
      const session: any = { cacheKey, pane: { id: 1, leafId: leaf }, disposed: false, paneStartup: null,
        transport, deps: { worktreeId: 'wt', tabId: `tab-${i}`, paneTransportsRef: { current: new Map([[1, transport]]) } } }
      installSleepingRecordAccess(session)
      installHibernatedPaneWake(session)
      // Process boundary: a successful spawn calls this exact cleanup with its retained record.
      session.wakeHibernatedAgentPane = () => {
        const consumed = { paneKey: cacheKey, record: records[cacheKey] }
        session.clearSleepingRecordProviderDuplicates(store.state, consumed, cacheKey)
        const result = Promise.resolve('resumed')
        pending.push(result)
        return result
      }
      releases.push(listenForHibernatedAgentWake('wt', `tab-${i}`, () => [{ dispose() {},
        wakeHibernatedAgentIfArmed: (claims?: Set<string>, paneKey?: string) => wakeHibernatedPaneIfArmed(session, claims, paneKey) }]))
    }
    dispatchHibernatedAgentWake({ worktreeId: 'wt', paneKey: `tab-0:${leaf}`, wokenClaimKeys: new Set() })
    await Promise.all(pending)
    await Promise.resolve()
    expect(visits).toBe(1)
    const single = visits
    visits = 0
    for (let i = 0; i < n; i++) dispatchHibernatedAgentWake({ worktreeId: 'wt', paneKey: `tab-${i}:${leaf}`, wokenClaimKeys: new Set() })
    await Promise.all(pending)
    expect(visits).toBe(n)
    expect(store.state.clearSleepingAgentSession).not.toHaveBeenCalled()
    console.log('BENCH resume-cleanup', JSON.stringify({ head: 'e76eca5b42752b584f1724d4f8ffc2783af83af4',
      sleptConversations: n, singleTargetSiblingRecordVisits: single, burstTargets: n, burstRecordVisits: visits, duplicateRecords: 0, requiredRemovals: 0 }))
  } finally { releases.forEach(release => release()) }
})
