import { expect, it, vi } from 'vitest'
import { retryOnHostConnect } from './sleeping-mail-crew-watch'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { partialRuntimeStore } from '../../../construction/test-context/runtime-store-partial-fixture'
import { getDefaultWorkspaceSession } from '../../../../../shared/orca-profiles/constants'

it.each([100, 1000])('host reader retention after %i connect/remove lifecycles', n => {
  let deliver: (event: any) => void = () => {}
  const publish = vi.fn()
  const connected = retryOnHostConnect(callback => { deliver = callback }, { retryFailed() {}, trackedMailboxes: () => [] }, publish)
  for (let i = 0; i < n; i++) {
    const targetId = `removed-host-${i}`
    deliver({ type: 'sshStateChanged', targetId, state: { status: 'connected' } })
    deliver({ type: 'sshStateChanged', targetId, state: { status: 'connected' } })
    deliver({ type: 'sshStateChanged', targetId, state: { status: 'disconnected' } })
  }
  expect(publish).toHaveBeenCalledTimes(n)
  expect(connected.size).toBe(0)
  deliver({ type: 'sshStateChanged', targetId: 'reconnect', state: { status: 'connected' } })
  deliver({ type: 'sshStateChanged', targetId: 'reconnect', state: { status: 'disconnected' } })
  deliver({ type: 'sshStateChanged', targetId: 'reconnect', state: { status: 'connected' } })
  expect(publish).toHaveBeenCalledTimes(n + 2)
  expect(connected.size).toBe(1)
  console.log('BENCH host-retention', JSON.stringify({ head: 'd1eb8c9d8b9bbf06803f667085d2c942b8c26a32', completedHostLifecycles: n, liveHostsAfterRemoval: 0, retainedAfterRemoval: 0, reconnectRetries: 2 }))
})

it.each([100, 1000])('session input cache after %i removed host partitions', async n => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
  const sessions = new Map<string, any>()
  let written: (host: string | null) => void = () => {}
  const runtime = new OrcaRuntimeService(partialRuntimeStore({
    getWorkspaceSession: host => sessions.get(host ?? 'local') ?? getDefaultWorkspaceSession(),
    getWorkspaceSessionHostIds: () => ['local', ...sessions.keys()],
    onWorkspaceSessionWritten: listener => { written = listener; return () => {} }
  }))
  try {
    runtime.retrySleptMailboxWakes()
    for (let i = 0; i < n; i++) {
      const host = `runtime:removed-${i}`
      sessions.set(host, getDefaultWorkspaceSession())
      written(host)
      sessions.delete(host)
      written(host)
    }
    await vi.advanceTimersByTimeAsync(5000)
    const index = (runtime as any).sleepingRecordIndex
    const counts = { head: 'd1eb8c9d8b9bbf06803f667085d2c942b8c26a32', removedHostPartitions: n, liveHosts: 1, cachedInputs: index.inputs.size, obligatedHosts: index.hosts.size, sleepRecords: index.records.size }
    console.log('BENCH session-input-retention', JSON.stringify(counts))
    expect(index.records.size).toBe(0)
    expect(index.hosts.size).toBe(0)
    expect(index.inputs.size).toBe(n + 1)
  } finally { vi.useRealTimers() }
})
