import { expect, it, vi } from 'vitest'
import { retryOnHostConnect } from './sleeping-mail-crew-watch'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { partialRuntimeStore } from '../../../construction/test-context/runtime-store-partial-fixture'
import { getDefaultWorkspaceSession } from '../../../../../shared/orca-profiles/constants'
import { SleepingMailRecordIndex } from './sleeping-mail-record-index'

it('a removed host returning and a newly added host both register arriving sleepers', () => {
  const index = new SleepingMailRecordIndex()
  index.refresh('local', {}, () => {})
  index.refresh('returning', {}, () => {})
  index.finishInitialRead()
  index.refresh('returning', {}, () => {})
  index.forgetUnlessLive('returning', ['local'])
  for (const host of ['returning', 'new']) {
    const paneKey = `tab-${host}:11111111-1111-4111-8111-111111111111`
    index.refresh(host, { [paneKey]: {
      paneKey, worktreeId: 'wt', agent: 'codex', origin: 'worktree-sleep', state: 'done',
      providerSession: { key: 'session_id', id: host }, prompt: '', capturedAt: 1, updatedAt: 1
    } }, () => {})
    expect(index.takeArrival(paneKey)).toBe(true)
    expect(index.takeArrival(paneKey)).toBe(false)
  }
})

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
  console.log('BENCH host-retention', JSON.stringify({ head: 'e76eca5b42752b584f1724d4f8ffc2783af83af4', completedHostLifecycles: n, liveHostsAfterRemoval: 0, retainedAfterRemoval: 0, reconnectRetries: 2 }))
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
    const counts = { head: 'e76eca5b42752b584f1724d4f8ffc2783af83af4', removedHostPartitions: n, liveHosts: 1, cachedInputs: index.inputs.size, obligatedHosts: index.hosts.size, sleepRecords: index.records.size }
    console.log('BENCH session-input-retention', JSON.stringify(counts))
    expect(index.records.size).toBe(0)
    expect(index.hosts.size).toBe(0)
    expect(index.inputs.size).toBe(1)
  } finally { vi.useRealTimers() }
})
