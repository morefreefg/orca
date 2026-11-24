import { afterEach, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import { createRuntime, createBoundRun, PANE_KEY, PTY_ID } from '../terminal-pointer/orchestration-mailbox-notification-test-harness'
const HEAD = 'd0fb8d41639d2d853d42922f7de92e2b7a26df1c'
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
it.each([100,1000])('real sleep admission, SQL probes and %i retained Runs', async n => {
 vi.useFakeTimers({toFake:['setTimeout','Date']})
 const db = new OrchestrationDb(':memory:')
 const {runtime} = await createRuntime(db)
 try {
  const runs=Array.from({length:n},(_,i)=>createBoundRun(db,`history-${i}`))
  await vi.advanceTimersByTimeAsync(5000)
  let queries=0, rows=0, probes=0
  const original=db.db.prepare.bind(db.db)
  db.db.function('perf_run_probe',(id: unknown)=>{probes++;return id})
  let queryPlan:unknown[]=[]
  vi.spyOn(db.db,'prepare').mockImplementation((sql:string)=>{
   if (!sql.includes('FROM runs') || !sql.includes('coordinator_pane_key IS NOT NULL') || !sql.includes('ORDER BY rowid DESC')) return original(sql)
   queries++
   if(sql.includes('EXISTS (SELECT 1 FROM messages')) {
    if(!queryPlan.length) queryPlan=original('EXPLAIN QUERY PLAN '+sql).all(PANE_KEY.slice(PANE_KEY.indexOf(':')+1))
    sql=sql.replaceAll("'run:' || runs.id","'run:' || perf_run_probe(runs.id)")
   }
   const stmt=original(sql)
   return new Proxy(stmt,{get(target,key){
    if(key==='all') return (...args:any[])=>{const found=target.all(...args);rows+=found.length;return found}
    if(key==='iterate') return function*(...args:any[]){for(const row of target.iterate(...args)){rows++;yield row}}
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
   }})
  })
  const counts=[]
  for(let check=0;check<10;check++){
   queries=rows=probes=0
   expect(()=>runtime.assertAgentSleepAdmitted(PTY_ID)).not.toThrow()
   counts.push({queries,rows,probes})
  }
  expect(counts).toEqual(Array.from({length:10},()=>({queries:2,rows:1,probes:n})))
  db.insertMessage({runId:runs[0].id,from:'worker',to:`run:${runs[0].id}`,subject:'old Run still holds mail'})
  queries=rows=probes=0
  expect(()=>runtime.assertAgentSleepAdmitted(PTY_ID)).toThrow('orchestration_busy')
  expect({queries,rows,probes}).toEqual({queries:2,rows:2,probes:n})
  console.log('BENCH sleep-admission-history',JSON.stringify({head:HEAD,ownedRuns:n,checks:10,noMail:counts[0],historicalMail:{queries,rows,probes,refused:true},queryPlan}))
 }finally{runtime.setNotifier(null);db.close()}
},120000)
