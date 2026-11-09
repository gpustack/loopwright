import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { exclusive } from './native-context.mjs';
import { comparePreflightAbsence, validateLsofHelp, validatePreflightClient } from './native-image-inspector.mjs';
import { NativeLedger } from './native-ledger.mjs';
function fixture(){const directory=mkdtempSync(resolve('.claude/s04-development/client-controls-')),path=join(directory,'book.json');exclusive(path,{version:1,providerSends:0,mcpAttempts:0,containers:[],native:{version:1,seconds:{t0:0,initial:0,finalPi:0,finalController:0},leafSeconds:{},cleanupSeconds:0}});const ledger=new NativeLedger(path),time=ledger.beginCopiedPreflightTime({phase:'initial',leaf:'image-preflight',directory});ledger.preparePreflightTime(time);ledger.beginCopiedPreflightLifecycle(time);return{directory,path,ledger,time};}
test('client: actual validation accepts an empty private directory and refuses a nonempty one',()=>{const directory=mkdtempSync(resolve('.claude/s04-development/empty-client-'));assert.equal(validatePreflightClient(directory),directory);exclusive(join(directory,'untrusted.json'),{});assert.throws(()=>validatePreflightClient(directory),/CLIENT/);});
test('client: original registered lifecycle with zero command attempts closes committed refusal time while retaining FAIL',()=>{const f=fixture(),outcome={error:{message:'arbitrary pre-command assertion'},reads:[],output:null};const result=f.ledger.completeCopiedPreflightTime(f.time,outcome);assert.equal(result.state,'recorded');assert.equal(existsSync(f.path+'.parent-time-pending.json'),false);assert.equal(existsSync(f.path+'.lock'),false);});
test('client: an attempted command stays unknown even with empty completed reads and familiar client error text',()=>{const f=fixture();f.ledger.noteCopiedPreflightCommand(f.time);assert.throws(()=>f.ledger.completeCopiedPreflightTime(f.time,{error:{message:'QUALIFICATION_PREFLIGHT_CLIENT'},reads:[],output:null}),/OUTCOME_UNKNOWN/);assert.equal(existsSync(f.path+'.parent-time-pending.json'),true);});
test('client: accounting commit failure remains fenced despite proven zero command attempts',()=>{const f=fixture();assert.throws(()=>f.ledger.completeCopiedPreflightTime(f.time,{error:{message:'before command'},reads:[],output:null},stage=>{if(stage==='before_budget_rename')throw new Error('injected commit failure');}),/commit failure/);assert.equal(existsSync(f.path+'.lock'),true);assert.equal(existsSync(f.path+'.parent-time-pending.json'),true);});
function closed(f,unknown=false){
  const parent=f.ledger.owner,owner={...parent,pid:parent.pid+1},intent=exclusive(join(f.directory,'cli-0-intent.json'),{version:1,parent}),registration=exclusive(join(f.directory,'cli-0-registered.json'),{version:1,parent,owner,pid:owner.pid,intent});
  const stdout=exclusive(join(f.directory,'cli-0.stdout.bin'),''),stderr=exclusive(join(f.directory,'cli-0.stderr.bin'),'');
  return exclusive(join(f.directory,'cli-0-exit.json'),{version:1,intent,registration,owner,pid:owner.pid,exit:{code:0,signal:null},error:null,closedObserved:!unknown,unretainedStdout:0,unretainedStderr:0,stdout,stderr});
}
test('client: copied matched started/registered/closed read permits FAILED parser accounting to close',()=>{const f=fixture();f.ledger.noteCopiedPreflightCommand(f.time);f.ledger.closeCopiedPreflightCommand(f.time,closed(f));const result=f.ledger.completeCopiedPreflightTime(f.time,{error:{message:'parser assertion'},reads:[],output:null});assert.equal(result.state,'recorded');assert.equal(existsSync(f.path+'.parent-time-pending.json'),false);});
test('client: unclosed original command cannot acquire completion merely from a saved exit-shaped object',()=>{const f=fixture();f.ledger.noteCopiedPreflightCommand(f.time);assert.throws(()=>f.ledger.closeCopiedPreflightCommand(f.time,closed(f,true)),/CLI_UNKNOWN/);assert.throws(()=>f.ledger.completeCopiedPreflightTime(f.time,{error:{message:'parser assertion'},reads:[],output:null}),/OUTCOME_UNKNOWN/);assert.equal(existsSync(f.path+'.parent-time-pending.json'),true);});

test('client: original absence accepts Docker case variants only for the exact requested identity and exit',()=>{
  const identity='lw-pi-'+'a'.repeat(32),base={code:1,signal:null,stdout:'[]\n'};
  for(const prefix of ['error: no such object: ','Error: No such object: ','ERROR: NO SUCH CONTAINER: '])assert.doesNotThrow(()=>comparePreflightAbsence({...base,stderr:prefix+identity+'\n'},identity));
  for(const value of [{...base,stderr:'permission denied'},{...base,stderr:'error: no such object: other'},{...base,code:0,stderr:'error: no such object: '+identity}])assert.throws(()=>comparePreflightAbsence(value,identity),/ABSENCE/);
});

test('client: real captured lsof help permits its native usage spelling and requires supported fixed options',()=>{
  const help={code:0,signal:null,stdout:'',stderr:'lsof 4.91\n usage: [-?abhlnNoOPRtUvVX] [-i [i]] [-F [f]]\n -n no host names -P no port names\n'};
  assert.doesNotThrow(()=>validateLsofHelp(help));
  assert.throws(()=>validateLsofHelp({...help,stderr:help.stderr.replace(/-F/g,'fields')}),/LSOF_HELP/);
  assert.throws(()=>validateLsofHelp({...help,code:2}),/LSOF_HELP/);
});
