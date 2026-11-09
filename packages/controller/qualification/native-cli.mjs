/* global process, Buffer */
import {requireNativeAppActivation} from './native-activation.mjs';
import {freezeAdmission} from './native-public.mjs';
import {fail,same} from './native-context.mjs';

/** Observe the production main's awaited JSONL sink; no controller or adapter port is replaced. */
export async function observeCliJson(main,argv,onEvent){
  const original=process.stdout.write,rows=[];let total=0,terminal=null;
  process.stdout.write=function(chunk,encoding,callback){
    const done=typeof encoding==='function'?encoding:callback;
    const write=async()=>{
      const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);total+=bytes.length;
      if(bytes.length>1048576||total>4194304||rows.length>=4096||bytes.at(-1)!==10)fail('QUALIFICATION_CLI_OUTPUT');
      let row;try{row=JSON.parse(bytes);}catch{fail('QUALIFICATION_CLI_OUTPUT');}
      if(row.version!==1||row.sequence!==rows.length+1||!['event','result','diagnostic','incident'].includes(row.kind))fail('QUALIFICATION_CLI_OUTPUT');
      rows.push(row);if(row.kind==='event')await onEvent(row.data);
      if(row.kind==='result'||row.kind==='incident'){if(terminal)fail('QUALIFICATION_CLI_OUTPUT');terminal=row;}
    };
    void write().then(()=>done?.(),error=>done?.(error));return true;
  };
  try{const exit=await main(argv);return {exit,rows,terminal};}
  finally{process.stdout.write=original;}
}
export async function executePreparedPublicCli(activation,input){
  requireNativeAppActivation(activation);
  const {main,executionExit}=await import('../../cli/dist/main.js');let admission=null;
  const argv=['run','--config',input.load.configPath,'--registry',input.load.registryPath,'--registry-sha256',input.load.registrySha256,'--repo',input.repository,'--run-root',input.runRoot,'--run-id',input.runId,'--json'];
  const observed=await observeCliJson(main,argv,async event=>{
    // The qualification signal independently follows the same real process SIGINT/SIGTERM as CLI main.
    // It revokes the private outer transport guards; CLI retains its own production AbortController.
    if(event.stage==='admission'){if(admission)fail('QUALIFICATION_ADMISSION_REPLAY');admission=freezeAdmission(input.declared,event,input.signal,activation);}
    await input.observe(event,admission);
  });
  await input.retainCli({version:1,scope:'production CLI main argv/parser/public imports/JSONL; same owned native child, no execution port injection',argv,...observed});
  if(!admission||!observed.terminal||observed.terminal.runId!==input.runId)fail('QUALIFICATION_CLI_RESULT');
  const value=observed.terminal.kind==='incident'?{version:1,kind:'incident',incident:observed.terminal.data}:observed.terminal.data;
  if(observed.exit!==executionExit(value,null))fail('QUALIFICATION_CLI_RESULT');
  return {ok:true,value};
}

/** Same production CLI resume, with the existing outer guard still revoking the released original owner. */
export async function resumePreparedPublicCli(activation,input){
  requireNativeAppActivation(activation);const {main,executionExit}=await import('../../cli/dist/main.js');
  const argv=['resume','--config',input.load.configPath,'--registry',input.load.registryPath,'--registry-sha256',input.load.registrySha256,'--repo',input.repository,'--run-root',input.runRoot,'--run-id',input.runId,'--json'];
  const observed=await observeCliJson(main,argv,async()=>{}),ref=await input.retainCli({version:1,scope:'production CLI resume of original retained terminal; original input/deadline/accounting',argv,...observed});
  return {ref,matched:input.original.value.kind==='incident'?observed.exit===7&&observed.rows.at(-1)?.kind==='diagnostic'&&observed.rows.at(-1)?.data.code==='RECOVERY_REQUIRED':observed.terminal?.kind==='result'&&observed.terminal.runId===input.runId&&same(observed.terminal.data,input.original.value)&&observed.exit===executionExit(input.original.value,null),exit:observed.exit};
}
