/* global Buffer */
import {readFileSync,realpathSync,lstatSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {sha,fail} from './native-context.mjs';
export const daemonLiteral="require('node:net').createServer().listen(process.argv[1],()=>process.exit(0))";
export function fixtureSocket(path){
  const directory=dirname(path);if(realpathSync(directory)!==directory||dirname(directory)!==realpathSync(tmpdir())||!/^loopwright-pi-request-[a-zA-Z0-9]{6}$/.test(directory.split('/').at(-1))||path!==join(directory,'fixture.sock'))fail('QUALIFICATION_S03_FIXTURE');return directory;
}
export function fakeInfoCli(file,args,owned){
  const root=dirname(file);if(!owned.has(root)||file!==join(root,'docker-fixture')||lstatSync(file).isSymbolicLink())fail('QUALIFICATION_S03_FIXTURE');
  const quote=v=>"'"+v.replaceAll("'","'\\''")+"'";
  const expected=`#!/bin/sh\nprintf '%s\\n' "$@" >> ${quote(join(root,'daemon-calls'))}\n[ "$#" -eq 7 ] && [ "$1" = --config ] && [ "$3" = --host ] && [ "$4" = ${quote('unix://'+join(root,'fixture.sock'))} ] && [ "$5" = info ] && [ "$6" = --format ] && [ "$7" = '{{.ID}}' ] || exit 64\n[ "$(/bin/cat ${quote(join(root,'daemon-id'))})" != unavailable ] || exit 7\n/bin/cat ${quote(join(root,'daemon-id'))}\nprintf '\\n'\n`;
  if(readFileSync(file,'utf8')!==expected||args.length!==7||args[0]!=='--config'||args[2]!=='--host'||args[3]!=='unix://'+join(root,'fixture.sock')||args[4]!=='info'||args[5]!=='--format'||args[6]!=='{{.ID}}')fail('QUALIFICATION_S03_FIXTURE');return true;
}
export function generatedCpuActor(plan,parent,entry){
  // The frozen probe spawns check.mjs under raw tmpdir(); on macOS /var is the system symlink to /private/var, so
  // accept exactly that prefix while still refusing any other symlink indirection or path identity mismatch.
  const real=realpathSync(entry);
  if(plan.group!=='mutations'||parent!==join(plan.project,'packages/agent-pi/qualification/mutation-probe.mjs')||!(real===entry||real==='/private'+entry)||real!==realpathSync(real)||!entry.endsWith('/check.mjs'))fail('QUALIFICATION_S03_FIXTURE');
  const generator=readFileSync(parent,'utf8'),setup=/const setup = `([^`]+)`;/.exec(generator)?.[1];if(!setup)fail('QUALIFICATION_S03_FIXTURE');
  const context=readFileSync(join(plan.project,'packages/agent-pi/dist/context.js'),'utf8'),response=readFileSync(join(plan.project,'packages/agent-pi/dist/response.js'),'utf8');
  const rows=[
    [context.replace("policy.mode !== 'estimated_guard'",'false'),response,"assert.equal(assess(bytes(300),{},selection).ok,false);"],
    [context.replace('bytes.byteLength <= 65536','true'),response,'assert.equal(checkRequestBytes(bytes(65537)),false);'],
    [context.replace('integer(total + reserve, 1) <= window','integer(total + reserve, 1) < window'),response,"assert.equal(assess(bytes(48128),{mode:'estimated_guard'},selection).ok,true);"],
    [context,response.replace('this.#failed = true;','this.#failed = false;'),"const latch=new TurnFailureLatch();latch.observe({ok:false,code:'MODEL_FAILED'});latch.observe({ok:true,toolCalls:[{id:'call',name:'read'}]});assert.equal(latch.canAdmitTool('call'),false);"],
  ];
  const directory=dirname(entry),check=readFileSync(entry,'utf8'),actualContext=readFileSync(join(directory,'context.js'),'utf8'),actualResponse=readFileSync(join(directory,'response.js'),'utf8');
  if(readFileSync(join(directory,'package.json'),'utf8')!=='{"type":"module"}'||!rows.some(([c,r,t])=>check===setup+t&&(actualContext===context&&actualResponse===response||actualContext===c&&actualResponse===r)))fail('QUALIFICATION_S03_FIXTURE');
  return {entry:resolve(entry),files:['check.mjs','context.js','response.js','package.json'].map(n=>({path:join(directory,n),sha256:sha(readFileSync(join(directory,n)))}))};
}
export function admissionTransport(plan,entry,url,options){
  if(plan.group!=='admission-mutations'||entry!==join(plan.project,'packages/agent-pi/qualification/admission-mutations.mjs')||url.pathname!=='/'||options.method!=='POST'||!Buffer.from(options.body??'').equals(Buffer.from('controlled request body'))||options.headers?.authorization!=='Bearer SYNTHETIC_HOST_SECRET'||options.headers?.['content-type']!=='application/json')fail('QUALIFICATION_S03_FIXTURE');
}
