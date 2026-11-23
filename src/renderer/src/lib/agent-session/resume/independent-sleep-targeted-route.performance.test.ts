import { afterEach, expect, it, vi } from 'vitest'
const store = vi.hoisted(()=>({state:{} as any}))
vi.mock('@/store/index',()=>({useAppStore:{getState:()=>store.state}}))
vi.mock('@/store/terminals/agent-pane-sleep-in-flight',()=>({waitForAgentPaneSleep:async()=>{}}))
vi.mock('@/components/terminal/workspace-mounting/background-terminal-worktree-mount',()=>({requestBackgroundTerminalWorktreeMount:vi.fn()}))
vi.mock('./resume-sleeping-agent-session',()=>({resumeSleepingAgentSessionsForWorktree:vi.fn()}))
vi.mock('./sleeping-agent-wake-requests',()=>({getSleepingRecordTabId:(r:any)=>r.tabId}))
vi.mock('../../workspace/activation/worktree-activation-pty-inventory',()=>({resolveActivationPtyListScope:()=>null}))
vi.mock('../../workspace/activation/worktree-agent-activation-gate',()=>({gateWorktreeAgentActivation:vi.fn()}))
vi.mock('./sleeping-agent-pane-ownership',()=>({activationTreatsNoteAsFinished:()=>true,isStrandedWorkspaceSleepRecord:()=>false,recordPaneIsOwnedByPreservedPane:()=>true}))
vi.mock('@/store/terminals/sleep/sleeping-agent-record-index',()=>({sleepingAgentRecordIndex:{entries:()=>[]}}))
import { createBackgroundSleepingAgentWakeDispatcher } from './wake-sleeping-agents-in-background'
import { listenForHibernatedAgentWake } from '../../../components/terminal-pane/mounting/hibernated-agent-wake-listener'
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks()})
it.each([100,1000])('real targeted wake producer and mounted listeners at %i owners',async(n)=>{
  let ownerCallbacks=0,bindingChecks=0
  const callbacks=new Map<(event:any)=>void,(event:any)=>void>()
  class WakeEvent { constructor(readonly type:string,readonly options:{detail:unknown}){} get detail(){return this.options.detail} }
  const window={
    addEventListener:(_type:string,cb:(event:any)=>void)=>callbacks.set(cb,(event:any)=>{ownerCallbacks++;cb(event)}),
    removeEventListener:(_type:string,cb:(event:any)=>void)=>callbacks.delete(cb),
    dispatchEvent:(event:any)=>{for(const cb of callbacks.values())cb(event);return true}
  }
  vi.stubGlobal('window',window);vi.stubGlobal('CustomEvent',WakeEvent)
  const records=Object.fromEntries(Array.from({length:n},(_,i)=>['tab-'+i+':11111111-1111-4111-8111-111111111111',{
    paneKey:'tab-'+i+':11111111-1111-4111-8111-111111111111',tabId:'tab-'+i,worktreeId:'folder:'+i,origin:'worktree-sleep',state:'done',agent:'codex',providerSession:{key:'session_id',id:'conversation-'+i},prompt:'',capturedAt:1,updatedAt:1,restoreOnTabOpenOnly:false
  }]))
  store.state={workspaceSessionReady:true,sleepingAgentSessionsByPaneKey:records}
  const releases=Array.from({length:n},(_,i)=>listenForHibernatedAgentWake('folder:'+i,'tab-'+i,()=>{ownerCallbacks++;return [{
    dispose:()=>{},wakeHibernatedAgentIfArmed:(_claims?:Set<string>,paneKey?:string)=>{
      bindingChecks++;expect(paneKey).toBe('tab-'+i+':11111111-1111-4111-8111-111111111111');return 'claim:'+i
    }
  }]}))
  const dispatcher=createBackgroundSleepingAgentWakeDispatcher()
  expect(callbacks.size).toBe(0)
  await dispatcher.request('folder:0','tab-0:11111111-1111-4111-8111-111111111111',true)
  expect(ownerCallbacks).toBe(0)
  expect(await dispatcher.request('folder:0','tab-0:11111111-1111-4111-8111-111111111111')).toBe(true)
  expect(ownerCallbacks).toBe(1);expect(bindingChecks).toBe(1)
  ownerCallbacks=0;bindingChecks=0
  await Promise.all(Array.from({length:n},(_,i)=>dispatcher.request('folder:'+i,'tab-'+i+':11111111-1111-4111-8111-111111111111')))
  expect(ownerCallbacks).toBe(n);expect(bindingChecks).toBe(n)
  const measured=ownerCallbacks
  store.state.sleepingAgentSessionsByPaneKey={}
  await dispatcher.request('folder:0','tab-0:11111111-1111-4111-8111-111111111111')
  expect(ownerCallbacks).toBe(measured)
  releases.forEach(release=>release());dispatcher.dispose()
  const after = ownerCallbacks
  const { dispatchHibernatedAgentWake } = await import('./hibernated-agent-wake-owners')
  dispatchHibernatedAgentWake({worktreeId:'folder:0',paneKey:'tab-0:11111111-1111-4111-8111-111111111111'})
  expect(ownerCallbacks).toBe(after)
  expect(callbacks.size).toBe(0)
  console.log('BENCH targeted-wake-listeners',JSON.stringify({head:'e76eca5b42752b584f1724d4f8ffc2783af83af4',mountedOwners:n,callbacksPerTargetedWake:1,burstWakes:n,burstOwnerCallbacks:measured,requiredBindingCalls:bindingChecks,listenersAfterDispose:callbacks.size}))
})
