import { afterEach, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import { createRuntime, createBoundRun, PANE_KEY, PTY_ID } from '../terminal-pointer/orchestration-mailbox-notification-test-harness'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it.each([100, 1000])('real sleep admission with %i owned Runs and no mail', async n => {
  vi.useFakeTimers({toFake:['setTimeout','Date']})
  const db = new OrchestrationDb(':memory:')
  const {runtime} = await createRuntime(db)
  try {
    const runs = Array.from({length:n}, (_,i) => createBoundRun(db, `history-${i}`))
    await vi.advanceTimersByTimeAsync(5000)
    let ownerRows=0
    const real = db.runsBoundToPane.bind(db)
    const reads = vi.spyOn(db,'runsBoundToPane').mockImplementation(pane => {
      const rows=real(pane); ownerRows+=rows.length; return rows
    })
    const mailFilter=vi.spyOn(db,'getMailboxesWithPointerWork')
    const results: {queries:number;rows:number;mailboxCandidates:number}[]=[]
    for (let i=0;i<10;i++) {
      ownerRows=0; reads.mockClear(); mailFilter.mockClear()
      expect(() => runtime.assertAgentSleepAdmitted(PTY_ID)).not.toThrow()
      results.push({queries:reads.mock.calls.length,rows:ownerRows,mailboxCandidates:mailFilter.mock.calls.reduce((sum,[ids])=>sum+ids.length,0)})
    }
    expect(results).toEqual(Array.from({length:10},()=>({queries:2,rows:2*n,mailboxCandidates:n-1})))
    db.insertMessage({runId:runs[n-1].id,from:'worker',to:`run:${runs[n-1].id}`,subject:'Must refuse'})
    expect(() => runtime.assertAgentSleepAdmitted(PTY_ID)).toThrow('orchestration_busy')
    expect(db.runsBoundToPane(PANE_KEY)).toHaveLength(n)
    console.log('BENCH sleep-admission-history',JSON.stringify({head:'75da9c1ef46bd90e4a784ed050f1df52f425301e',ownedRuns:n,checks:10,perCheck:results[0],mailControlRefused:true}))
  } finally { runtime.setNotifier(null); db.close() }
},120000)
