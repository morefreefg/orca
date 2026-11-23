import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return { ipcMain: new EventEmitter() }
})
import { ipcMain } from 'electron'
import { requestSleepingPaneWake } from './sleeping-mail-window-relay'
import { requestRendererReply } from './renderer-reply-request'
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
it.each([100, 1000])('native sleeping wake reply routing at %i pending requests', async (n) => {
  vi.useFakeTimers()
  const web = Object.assign(new EventEmitter(), { isDestroyed: () => false,
    send: vi.fn((_channel: string, _payload: any) => {}) })
  const window = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: web })
  const pending = Array.from({ length: n }, (_, i) => requestSleepingPaneWake(window as never,
    { worktreeId: 'folder:' + i, paneKey: 'tab-' + i + ':leaf' }))
  expect(web.send).toHaveBeenCalledTimes(n)
  expect(ipcMain.listenerCount('ui:resumeSleepingAgentsReply')).toBe(1)
  expect(web.listenerCount('destroyed')).toBe(1)
  expect(window.listenerCount('closed')).toBe(1)
  let comparisons = 0
  const reply = (requestId: string) => new Proxy({ requestId, woke: true }, {
    get(target, key) { if (key === 'requestId') comparisons++; return Reflect.get(target, key) }
  })
  ipcMain.emit('ui:resumeSleepingAgentsReply', { sender: web }, reply('unrelated'))
  expect(comparisons).toBe(1)
  comparisons = 0
  for (const [, payload] of web.send.mock.calls) {
    ipcMain.emit('ui:resumeSleepingAgentsReply', { sender: web }, reply(payload.requestId))
  }
  expect(await Promise.all(pending)).toEqual(Array(n).fill(true))
  expect(comparisons).toBe(n)
  expect(ipcMain.listenerCount('ui:resumeSleepingAgentsReply')).toBe(0)
  expect(web.listenerCount('destroyed')).toBe(0)
  expect(window.listenerCount('closed')).toBe(0)
  console.log('BENCH native-replies', JSON.stringify({ head: 'e76eca5b42752b584f1724d4f8ffc2783af83af4', requests: n,
    unrelatedReplyComparisons: 1, successfulReplyComparisons: comparisons, nativeReplyListeners: 1, listenersAfter: 0 }))
})

it.each([100, 1000])('reply abort, timeout and document-loss cleanup at %i requests', async (n) => {
  vi.useFakeTimers()
  for (const outcome of ['abort', 'timeout', 'gone'] as const) {
    const web = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() })
    const window = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: web })
    const cancel = new AbortController()
    const pending = Array.from({length:n}, () => requestRendererReply(window as never, {
      requestChannel:'test:cleanup-request', replyChannel:'test:cleanup-reply', payload:{},
      timeoutMs:1000, timeoutError:'deadline', signal:cancel.signal
    }).then(()=>'unexpected', ()=>'released'))
    expect(ipcMain.listenerCount('test:cleanup-reply')).toBe(1)
    if (outcome === 'abort') cancel.abort()
    if (outcome === 'gone') web.emit('did-navigate')
    if (outcome === 'timeout') await vi.advanceTimersByTimeAsync(1001)
    expect(await Promise.all(pending)).toEqual(Array(n).fill('released'))
    for (const event of ['destroyed','render-process-gone','did-navigate']) expect(web.listenerCount(event)).toBe(0)
    expect(window.listenerCount('closed')).toBe(0)
    expect(ipcMain.listenerCount('test:cleanup-reply')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  }
  console.log('BENCH reply-cleanup', n, 'abort/timeout/document-loss=all-released')
})
