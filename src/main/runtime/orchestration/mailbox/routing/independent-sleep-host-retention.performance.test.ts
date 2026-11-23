import { expect, it, vi } from 'vitest'
import { retryOnHostConnect } from './sleeping-mail-crew-watch'

it.each([100, 1000])('host reader retention after %i connect/remove lifecycles', n => {
  let deliver: (event: any) => void = () => {}
  let statuses: Map<string, string> | undefined
  const set = Map.prototype.set
  const spy = vi.spyOn(Map.prototype, 'set').mockImplementation(function (key: any, value: any) {
    if (typeof key === 'string' && key.startsWith('removed-host-')) statuses = this
    return set.call(this, key, value)
  })
  try {
    const publish = vi.fn()
    retryOnHostConnect(callback => { deliver = callback }, { retryFailed() {}, trackedMailboxes: () => [] }, publish)
    for (let i = 0; i < n; i++) {
      const targetId = `removed-host-${i}`
      deliver({ type: 'sshStateChanged', targetId, state: { status: 'connected' } })
      // Target removal disconnects before deleting its connection and saved target. No subsequent
      // runtime client event names that removal; this is the last state the reader receives.
      deliver({ type: 'sshStateChanged', targetId, state: { status: 'disconnected' } })
    }
    expect(publish).toHaveBeenCalledTimes(n)
    expect(statuses?.size).toBe(n)
    expect([...statuses!.values()].every(status => status === 'disconnected')).toBe(true)
    console.log('BENCH host-retention', JSON.stringify({ head: '22ca84dded198ded40a3d2093f934d6b9c3f8479', completedHostLifecycles: n, liveHosts: 0, retainedEntries: statuses!.size, retainedKeyCharacters: [...statuses!.keys()].reduce((sum, key) => sum + key.length, 0) }))
  } finally { spy.mockRestore() }
})
