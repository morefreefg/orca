import { afterEach, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import { sleepingPaneInboxes } from './sleeping-mail-owner-mailboxes'
import { createRuntime, createBoundRun, PANE_KEY, PTY_ID } from '../terminal-pointer/orchestration-mailbox-notification-test-harness'
const HEAD = '8b158734cf68241878246ef605134392cbd845ac'
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
function census(db: OrchestrationDb) {
 const c={queries:0,rows:0,probes:0,candidates:0}, plans:unknown[]=[]
 const original=db.db.prepare.bind(db.db)
 db.db.function('perf_run_probe',(id:unknown)=>{c.probes++;return id})
 db.db.function('perf_mail_candidate',(_id:unknown)=>{c.candidates++;return 1})
 const spy=vi.spyOn(db.db,'prepare').mockImplementation((sql:string)=>{
  const pointer=sql.includes('CROSS JOIN runs')
  const newest=sql.includes('FROM runs')&&sql.includes('coordinator_pane_key IS NOT NULL')&&sql.includes('ORDER BY rowid DESC')
  if(!pointer&&!newest)return original(sql)
  c.queries++
  if(pointer){
   if(!plans.length)plans.push(...original('EXPLAIN QUERY PLAN '+sql).all(PANE_KEY.slice(PANE_KEY.indexOf(':')+1)))
   sql=sql.replaceAll('substr(mail.to_handle, 5)','perf_run_probe(substr(mail.to_handle, 5))')
    .replaceAll('WHERE to_handle >=','WHERE perf_mail_candidate(to_handle) AND to_handle >=')
  }
  const stmt=original(sql)
  return new Proxy(stmt,{get(target,key){
   if(key==='all')return (...args:any[])=>{const rows=target.all(...args);c.rows+=rows.length;return rows}
   if(key==='iterate')return function*(...args:any[]){for(const row of target.iterate(...args)){c.rows++;yield row}}
   const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
  }})
 })
 return {c,plans,original,stop:()=>spy.mockRestore(),reset:()=>Object.assign(c,{queries:0,rows:0,probes:0,candidates:0})}
}
it.each([100,1000])('real admission with %i retained Runs, empty and historical mail',async n=>{
 vi.useFakeTimers({toFake:['setTimeout','Date']})
 const db=new OrchestrationDb(':memory:');const {runtime}=await createRuntime(db)
 try{
  const runs=Array.from({length:n},(_,i)=>createBoundRun(db,'history-'+i))
  await vi.advanceTimersByTimeAsync(5000)
  const counter=census(db),counts=[]
  for(let i=0;i<10;i++){
   counter.reset();expect(()=>runtime.assertAgentSleepAdmitted(PTY_ID)).not.toThrow();counts.push({...counter.c})
  }
  expect(counts).toEqual(Array.from({length:10},()=>({queries:2,rows:1,probes:0,candidates:0})))
  db.insertMessage({runId:runs[0].id,from:'worker',to:'run:'+runs[0].id,subject:'old Run mail'})
  counter.reset();expect(()=>runtime.assertAgentSleepAdmitted(PTY_ID)).toThrow('orchestration_busy')
  expect(counter.c).toEqual({queries:2,rows:2,probes:1,candidates:1})
  console.log('BENCH sleep-admission-history',JSON.stringify({head:HEAD,runs:n,checks:10,empty:counts[0],historical:{...counter.c},queryPlan:counter.plans}))
 }finally{runtime.setNotifier(null);db.close()}
},120000)
it.each([100,1000].flatMap(n=>[false,true].flatMap(sharedMailbox=>[false,true].map(reserved=>({n,sharedMailbox,reserved})))))(
 'unrelated stranded mail n=$n sharedMailbox=$sharedMailbox reserved=$reserved',async({n,sharedMailbox,reserved})=>{
 vi.useFakeTimers({toFake:['setTimeout','Date']})
 const db=new OrchestrationDb(':memory:');const {runtime}=await createRuntime(db)
 try{
  const own=Array.from({length:100},(_,i)=>createBoundRun(db,'target-'+i))
  let foreign:any
  for(let i=0;i<n;i++){
   if(!sharedMailbox||!foreign)foreign=db.createRun({objective:'stranded-'+i,coordinatorHandle:null,coordinatorPaneKey:'unrelated:22222222-2222-4222-8222-222222222222'})
   const message=db.insertMessage({runId:foreign.id,from:'worker',to:'run:'+foreign.id,subject:'stranded'})
   if(reserved)db.db.prepare("UPDATE messages SET delivered_at = datetime('now'), pointer_enter_pending = 1 WHERE id = ?").run(message.id)
  }
  await vi.advanceTimersByTimeAsync(5000)
  const counter=census(db),expectedProbes=sharedMailbox?1:n
  let admission:any,wakeOwner:any
  for(let i=0;i<10;i++){
   counter.reset();expect(()=>runtime.assertAgentSleepAdmitted(PTY_ID)).not.toThrow();admission={...counter.c}
   expect(admission).toEqual({queries:2,rows:1,probes:expectedProbes,candidates:n})
   counter.reset();expect(sleepingPaneInboxes(db,PANE_KEY,null,true)).toEqual([]);wakeOwner={...counter.c}
   expect(wakeOwner).toEqual({queries:1,rows:0,probes:reserved?0:expectedProbes,candidates:reserved?0:n})
  }
  // The old pane-led predicate is independent of the unrelated backlog, on the same database.
  let oldProbes=0;db.db.function('perf_old_probe',(id:unknown)=>{oldProbes++;return id})
  const legacy=counter.original(`SELECT id, coordinator_pane_key FROM runs
   WHERE coordinator_pane_key IS NOT NULL AND legacy = 0
    AND substr(coordinator_pane_key, instr(coordinator_pane_key, ':') + 1) = ?
    AND EXISTS (SELECT 1 FROM messages WHERE to_handle = 'run:' || perf_old_probe(runs.id)
     AND read = 0 AND delivery_contract = 'current_delivery'
     AND (delivered_at IS NULL OR pointer_enter_pending > 0)) ORDER BY rowid DESC`)
  const oldRows=legacy.all(PANE_KEY.slice(PANE_KEY.indexOf(':')+1));expect(oldRows).toHaveLength(0);expect(oldProbes).toBe(own.length)
  counter.stop()
  expect(()=>runtime.assertAgentSleepAdmitted(PTY_ID)).not.toThrow();expect(sleepingPaneInboxes(db,PANE_KEY,null,true)).toEqual([])
  console.log('BENCH stranded-mail',JSON.stringify({head:HEAD,ownRuns:own.length,unrelatedMessages:n,unrelatedMailboxes:expectedProbes,sharedMailbox,reserved,repeatedChecks:10,admission,wakeOwner,oldPaneProbes:oldProbes,oldUnrelatedProbes:0,queryPlan:counter.plans}))
 }finally{runtime.setNotifier(null);db.close()}
},120000)
