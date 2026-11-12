/* global Buffer */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, sha, fail, exclusive, localOwner, nonce } from './native-context.mjs';
import { requireNativeAppActivation } from './native-activation.mjs';
export const nativeCases=Object.freeze({
  cycle:Object.freeze(['changed-completed','false-submitted-pass','required-check-failed','declared-and-implicit-no-change','missing-binding-blocked','captured-first-exhausted-second-zero','blocked-evidence']),
  repair:Object.freeze(['format-only-empty-tools','implementation-candidate-change','unactionable-no-repair','persistent-repeat-cap','sender-only-retry']),
});
export function fixtureResponse(text,id='s04-prepared'){
  const frames=[{type:'message_start',message:{id,type:'message',role:'assistant',model:'claude-sonnet-5.5',content:[],usage:{input_tokens:4,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}}},
    {type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text}},{type:'content_block_stop',index:0},
    {type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:4}},{type:'message_stop'}];
  return frames.map(frame=>'event: '+frame.type+'\ndata: '+JSON.stringify(frame)+'\n\n').join('');
}
export function fixtureWriteResponse(path,content,id='s04-prepared-write'){
  const input={path,content};
  return [{type:'content_block_start',index:0,content_block:{type:'tool_use',id,name:'write',input:{}}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(input)}},{type:'content_block_stop',index:0}];
}
export function fixtureReply(reply,ordinal){
  if(reply.kind==='http-error')return JSON.stringify({type:'error',error:{type:'rate_limit_error'}});
  if(reply.kind==='text')return fixtureResponse(reply.text,'s04-'+ordinal);
  if(reply.kind!=='write')fail('QUALIFICATION_REPLY_KIND');
  return [{type:'message_start',message:{id:'s04-'+ordinal,type:'message',role:'assistant',model:'claude-sonnet-5.5',content:[],usage:{input_tokens:4,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}}},
    ...fixtureWriteResponse(reply.path,reply.content,'write-'+ordinal),{type:'message_delta',delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:4}},{type:'message_stop'}]
    .map(frame=>'event: '+frame.type+'\ndata: '+JSON.stringify(frame)+'\n\n').join('');
}
export function prepareNativeRecipe(cases){
  if(!['cycle','repair'].includes(cases))fail('QUALIFICATION_ARGUMENT_INVALID');
  return Object.freeze({version:1,status:'activation_held',cases:nativeCases[cases],leafSeconds:120,taskWallMs:600000,drainReserveMs:120000,maxModelCalls:16,outputTokens:1024,activeContainers:4,caps:Object.freeze({provider:64,mcp:0,containers:64}),providerSendMs:90000,mcpSendMs:10000,mcpGrants:Object.freeze([]),candidateMutation:'real-mediated-native-write-only',route:'public-default-runCycle',finalCLI:false});
}
export function startPreparedServices(activation,input){
  requireNativeAppActivation(activation);
  return (async()=>{
    const http=await import('node:http'),owner=localOwner(),token=nonce(),records=[];
    const intent=exclusive(join(input.directory,'provider-intent-'+token+'.json'),{version:1,nonce:token,owner,caseId:input.caseId,bind:'127.0.0.1',port:0,sourceDigest:input.sourceDigest,syntheticCredentialStored:false});
    let received=0,pending=0,unknown=false;
    const server=http.createServer({maxHeaderSize:8192,headersTimeout:2000,requestTimeout:10000},async(request,response)=>{
      received++;pending++;const ordinal=received;
      try{
        if(ordinal>input.cap||request.method!=='POST'||request.url!=='/messages'){response.writeHead(400);response.end();return;}
        let bytes=0;const chunks=[];for await(const chunk of request){bytes+=chunk.length;if(bytes>65536){request.destroy();unknown=true;return;}chunks.push(chunk);}
        const body=Buffer.concat(chunks),parsed=JSON.parse(body),requestRef=exclusive(join(input.directory,'provider-request-'+token+'-'+ordinal+'.bin'),body);
        const authorized=request.headers.authorization==='Bearer '+input.syntheticToken;
        const subject=authorized?exclusive(join(input.directory,'provider-subject-'+token+'-'+ordinal+'.json'),input.inspectRequest()):null;
        records.push({ordinal,authorized,inputBytes:bytes,request:requestRef,subject,tools:Array.isArray(parsed.tools)?parsed.tools.map(tool=>tool.name):[]});
        if(!authorized){response.writeHead(403);response.end();return;}
        const reply=input.script[ordinal-1];if(!reply){response.writeHead(400);response.end();unknown=true;return;}
        if(reply.kind==='http-error'){response.writeHead(reply.status,{'content-type':'application/json','retry-after':'0'});response.end(fixtureReply(reply));return;}
        const responseBody=fixtureReply(reply,ordinal);
        response.writeHead(200,{'content-type':'text/event-stream'});response.end(responseBody);
      }catch{unknown=true;response.destroy();}finally{pending--;}
    });
    const observation=input.observeServer?.(server,intent)??null;
    server.setTimeout(10000,socket=>{unknown=true;socket.destroy();});await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const address=server.address(),listening=exclusive(join(input.directory,'provider-listening-'+token+'.json'),{version:1,nonce:token,owner,caseId:input.caseId,intent,address});
    return {endpoint:'http://127.0.0.1:'+address.port+'/messages',listening,observation,async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));const value={version:1,nonce:token,owner,caseId:input.caseId,intent,listening,received,pending,unknown,records,ownListenerClosed:!server.listening,portAbsence:'requires-separate-owned-absence-proof'};const ref=exclusive(join(input.directory,'provider-closed-'+token+'.json'),value);return {value,ref};}};
  })();
}
/** Trusted fixture authoring only. Same frozen installed-byte algorithm; no private controller/SDK import. */
export function fixtureHandlerDigests(){
  const inventory=[];let total=0,seen=0;
  for(const name of ['controller','core','state','agent-pi']){
    const root=dirname(fileURLToPath(import.meta.resolve('@loopwright/'+name)));
    const walk=(directory,prefix,depth)=>{const entries=readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);seen+=entries.length;if(depth>32||seen>1024)fail('QUALIFICATION_HANDLER_LIMIT');for(const entry of entries){if(entry.isSymbolicLink())fail('QUALIFICATION_HANDLER_SYMLINK');if(entry.isDirectory()){walk(join(directory,entry.name),prefix+entry.name+'/',depth+1);continue;}if(!entry.name.endsWith('.js'))continue;const bytes=readFileSync(join(directory,entry.name));total+=bytes.length;if(bytes.length>1048576||total>8388608||inventory.length>=256)fail('QUALIFICATION_HANDLER_LIMIT');inventory.push({package:name,path:prefix+entry.name,digest:sha(bytes),byteLength:bytes.length});}};
    walk(root,'',1);
  }
  return Object.fromEntries(['pi.agent.v1','pi.compact.v1','scope.v1','json-artifact.v1','no-change.v1'].map(implementation=>[implementation,{algorithm:'sha256',hex:sha('loopwright.dev/controller/handler/v1\0'+canonical({implementation,inventory}))}]));
}
export function fixtureDocuments(caseId,revision,files,runtime,digests=fixtureHandlerDigests()){
  if(!Object.values(nativeCases).flat().includes(caseId))fail('QUALIFICATION_CASE_UNKNOWN');
  const unchanged=caseId==='declared-and-implicit-no-change',missing=caseId==='missing-binding-blocked',format=caseId==='format-only-empty-tools',blocked=['blocked-evidence','unactionable-no-repair'].includes(caseId),exhausted=caseId==='captured-first-exhausted-second-zero',repair=caseId==='implementation-candidate-change',repeat=caseId==='persistent-repeat-cap';
  const task={apiVersion:'loopwright.dev/v1alpha1',kind:'TaskContract',spec:{goal:'Qualify the exact finite public controller fixture',taskpack:'native-'+caseId,target:{repository:'fixture/local',baseRevision:revision,sourceRevision:revision,matrix:null},scope:{writable:['result.json'],protected:[]},roles:[{id:'builder',adapter:'pi',provider:'github-copilot',model:'claude-sonnet-5.5',thinking:'xhigh',tools:['read','write']}],trustedContext:{revision:'native-fixture-v1',discovery:'disabled',resources:[]},budgets:{wallTimeMs:600000,totalTokens:100000,perCallOutputTokens:1024,maxModelCalls:exhausted?1:16,maxConcurrency:1,maxFormatRepairs:format?1:0,maxImplementationRepairs:repair||repeat||blocked?2:0,maxTransportRetries:caseId==='sender-only-retry'?1:0,enforcement:{wallTime:'hard_admission',tokens:'soft_accounting',modelCalls:'hard_admission',concurrency:'hard_admission',formatRepairs:'hard_admission',implementationRepairs:'hard_admission',transportRetries:'hard_admission'}},steps:[{id:'build',kind:'agent',uses:'native.agent',roleId:'builder',dependsOn:[]}],acceptance:{required:['tests'],checks:[{id:'tests',allowedEvidenceLevels:[blocked?'external_service':'local_execution']}]}}};
  if(exhausted)task.spec.steps.push({id:'second',kind:'agent',uses:'native.agent',roleId:'builder',dependsOn:['build']});
  const handler=(id,implementation,parameters)=>({id,implementation,parameters,kind:implementation.startsWith('pi.')?'agent':'check',version:1,digest:digests[implementation],capabilities:implementation.startsWith('pi.')?['pi']:['inert_bytes','read_only']});
  const registry={apiVersion:'loopwright.dev/v1alpha1',kind:'TrustedRegistry',metadata:{name:'native-operator'},spec:{version:1,resourceVersion:'native-fixture-v1',handlers:[handler('native.agent','pi.agent.v1',{prompt:'Produce the declared structured submission for result.json.',purpose:'task'}),handler('tests',unchanged?'no-change.v1':'json-artifact.v1',unchanged?{checkId:'tests'}:{checkId:'tests',path:'result.json',required:['ok'],equals:{ok:true}}),handler('scope','scope.v1',{checkId:null}),handler('no-change','no-change.v1',{checkId:null})],roleProfiles:[{id:'builder',runtimeRef:'docker',providerCredentialRef:'synthetic-provider',selection:{provider:'github-copilot',model:'claude-sonnet-5.5',thinking:'xhigh',api:'anthropic-messages'},tools:['read','write'],context:{mode:'estimated_guard',estimator:'lw-pi-final-json-bytes-v1',proofId:null,version:1,evidence:'estimated',workingWindowCeiling:98304,maxRequestBytes:65536,serviceMargin:32768,toolReserve:16384,maxOutputTokens:1024},mcp:{serverId:'workspace',scriptDigest:files.localMcpScriptDigest,names:[],effects:[],idleTimeoutSeconds:2,absoluteTimeoutSeconds:10}}],runtimeProfiles:[{id:'docker',dockerExecutable:runtime.executable,dockerSocket:runtime.socket,identity:{sdkIntegrity:files.sdkIntegrity,graphDigest:runtime.graphDigest,configDigest:files.restrictionDigest,imageDigest:runtime.image,profile:'linux/arm64'}}],resources:[],credentialBindings:[{id:'synthetic-provider',consumer:'provider',destinationRef:'github-copilot',environmentNames:['S04_PROVIDER_TOKEN'],template:'${S04_PROVIDER_TOKEN}'}],environmentBindings:[{name:'S04_PROVIDER_TOKEN',classification:'credential',paths:['/spec/credentials/0/template']}]}};
  const config={apiVersion:'loopwright.dev/v1alpha1',kind:'ControllerConfig',spec:{task,registry:{name:registry.metadata.name,digest:{algorithm:'sha256',hex:sha(JSON.stringify(registry))}},profiles:{roles:[{roleId:'builder',profileRef:'builder'}],steps:task.spec.steps.map(step=>({stepId:step.id,handlerRef:'native.agent'}))},credentials:[{ref:'synthetic-provider',template:'${S04_PROVIDER_TOKEN}'}],controls:{drainReserveMs:120000,maxAttempts:repeat?3:format||repair?2:exhausted?2:1,repeatFailureLimit:2,submission:{mode:'artifact_or_assistant',path:null}}}};
  const submission={version:1,status:unchanged||missing?'no_change':'completed',checks:caseId==='false-submitted-pass'?[{checkId:'tests',status:'passed',evidenceId:'invented-evidence',reason:null}]:[],reason:null};
  const initial=Buffer.from(JSON.stringify({ok:unchanged||missing||format||exhausted||blocked||caseId==='sender-only-retry'}));
  const script=format?[{kind:'text',text:'not a submission'},{kind:'text',text:JSON.stringify(submission)}]:repair?[{kind:'text',text:JSON.stringify(submission)},{kind:'write',path:'result.json',content:'{"ok":true}'},{kind:'text',text:JSON.stringify(submission)}]:caseId==='changed-completed'?[{kind:'write',path:'result.json',content:'{"ok":true}'},{kind:'text',text:JSON.stringify(submission)}]:caseId==='sender-only-retry'?[{kind:'http-error',status:429},{kind:'text',text:JSON.stringify(submission)}]:Array.from({length:repeat?2:1},()=>({kind:'text',text:JSON.stringify(submission)}));
  return {version:1,caseId,config,registry,initial:{name:'result.json',bytes:initial},script,expected:{noChange:unchanged,blocked:missing||blocked,exhausted,originalChargeRetained:true,forgedClaimCannotSucceed:caseId==='false-submitted-pass',implicitEqualityMayFailForChanged:caseId==='changed-completed',hostCandidateMutation:false,finalCLI:false}};
}
