import { expect, it, vi } from 'vitest'
import { AgentSessionTabTable } from './agent-session-tab-table'
import { notifyAgentSessionStoreCacheChanges } from './agent-session-store-cache'
import { sessionCrewChanges } from '../../orchestration/crew/crew-changes'

it.each([100, 1000].flatMap(n => [false, true].map(listening => ({ n, listening }))))(
  'session tab notification producer at $n tabs, listening=$listening', ({ n, listening }) => {
    const before = new AgentSessionTabTable(Array.from({ length: n }, (_, i) => [`tab-${i}`, `session-${i}`] as const))
    const after = before.clone()
    after.hide('session-0')
    after.show('session-0', 'changed-tab-0')
    let copiedIds = 0
    let lookups = 0
    for (const table of [before, after]) {
      const ids = table.sessionIds.bind(table)
      vi.spyOn(table, 'sessionIds').mockImplementation(() => {
        const result = ids()
        copiedIds += result.length
        return result
      })
      const tabIdFor = table.tabIdFor.bind(table)
      vi.spyOn(table, 'tabIdFor').mockImplementation(id => { lookups++; return tabIdFor(id) })
    }
    expect(sessionCrewChanges.hasListeners()).toBe(false)
    const notices: any[] = []
    const release = listening ? sessionCrewChanges.subscribe(change => notices.push(change)) : () => {}
    try {
      notifyAgentSessionStoreCacheChanges(
        { sessionTabs: before, records: new Map() } as never,
        { sessionTabs: after, records: new Map() } as never,
        { records: { upsert: [], remove: [] }, sessionTabs: {} } as never
      )
      expect(copiedIds).toBe(2 * n)
      expect(lookups).toBe(4 * n)
      expect(notices).toHaveLength(listening ? 1 : 0)
      if (listening) expect([...notices[0].trafficAddresses]).toEqual(['orca_session_id:session-0'])
      console.log('BENCH tab-notification-producer', JSON.stringify({
        head: 'e76eca5b42752b584f1724d4f8ffc2783af83af4', tabs: n,
        changedMemberships: 1, subscribers: listening ? 1 : 0,
        copiedIds, membershipLookups: lookups, notices: notices.length
      }))
    } finally { release(); vi.restoreAllMocks() }
  }
)
