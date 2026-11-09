/* global process, Buffer, URL, setTimeout, clearTimeout */
import childProcess from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import {syncBuiltinESMExports} from 'node:module';
import {promisify} from 'node:util';
import {PassThrough} from 'node:stream';
import {readFileSync,existsSync,realpathSync,readdirSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {canonical,sha,nonce,localOwner,monotonic,same,exclusive,fail} from './native-context.mjs';
import {s03DebitScope,s03ActorArgv,fixtureGroups} from './s03-scope.mjs';
import {debitS03Reservation,observeS03Container} from './native-lock.mjs';
import {publicStateObserver,physicalObservation} from './s03-observer.mjs';
import {daemonLiteral,fixtureSocket,fakeInfoCli,generatedCpuActor,admissionTransport} from './s03-fixtures.mjs';
// Saved before installation: metadata and binding observations must not recursively use the wrappers.
const original={...childProcess,fetch:globalThis.fetch,listen:net.Server.prototype.listen,connect:net.Socket.prototype.connect,http:http.request,https:https.request};
const need=v=>{if(!v)fail('QUALIFICATION_S03_LOWER');};
const preload=pathToFileURL(resolve('packages/controller/qualification/s03-count-preload.mjs')).href;
export function installS03Io({path,base,plan,copied=false,targets=null}){
  need(copied?targets&&targets.original:!targets&&path===resolve('.claude/s04-qualification/budget.json'));
  const cp=targets?.childProcess??childProcess,globals=targets?.globals??globalThis;
  const savedProcess={...cp},hadFetch=Object.hasOwn(globals,'fetch'),savedFetch=globals.fetch;
  const lower=targets?.original??original,actor=s03ActorArgv()[0],ownedFixtureRoots=new Set(),records=[],observations=[];
  const cpu=actor.endsWith('/retained-cost.mjs')||actor.endsWith('/check.mjs')||actor==='node:daemon-fixture';
  const scope=(cleanup=false)=>s03DebitScope(path,{...base,kind:'observe'},copied,cleanup);
  const debit=input=>debitS03Reservation(path,{...base,...input},{copied});
  const check=(cleanup=false)=>{scope(cleanup);};
  const observe=row=>{need(observations.length<2048);observations.push(row);};
  const atLower=(boundary,action)=>{try{return action();}catch(error){observe({kind:'denied-lower',boundary,code:/^[A-Z0-9_]{1,128}$/.test(error.message)?error.message:'QUALIFICATION_S03_LOWER_ERROR'});throw error;}};
  const stateObserver=publicStateObserver({plan,entry:actor,debit,check,observe});
  function timeout(options={},cleanup=false){
    check(cleanup);need(!options.shell&&(!options.cwd||resolve(options.cwd)===plan.project));
    const left=Number(BigInt(cleanup?plan.clock.hardCutoff:plan.clock.workCutoff)-monotonic());need(left>0);
    // REVIEW-072 guard: suite-level children use the frozen 110000/30000 own bounds; let them run to the work cutoff.
    const suiteChild=(plan.group==='recovery'&&actor.endsWith('/recovery-suite.mjs')&&options.timeout===110000)||(plan.group==='limits'&&actor.endsWith('/limits.mjs')&&options.timeout===30000);
    return {...options,timeout:Math.max(1,suiteChild?left:Math.min(options.timeout||left,left)),maxBuffer:Math.min(options.maxBuffer??4194304,4194304),killSignal:'SIGKILL',suiteChild};
  }
  function nodeCommand(args){
    need(Array.isArray(args)&&args.length>0&&args.length<128&&args.every(a=>typeof a==='string'));
    if(args[0]==='-e'){
      need(fixtureGroups.has(plan.group)&&args.length===3&&args[1]===daemonLiteral);const root=fixtureSocket(args[2]);ownedFixtureRoots.add(root);
      return {argv:['node:daemon-fixture',...args.slice(1)],entry:'node:daemon-fixture',cpuOnly:true,generated:null};
    }
    need(!args[0].startsWith('-'));const entry=resolve(args[0]);let generated=null;
    if(!plan.entries.includes(entry))generated=generatedCpuActor(plan,actor,entry);
    return {argv:[entry,...args.slice(1)],entry,cpuOnly:entry.endsWith('/retained-cost.mjs')||generated!==null,generated};
  }
  function registerLaunch(kind,entry,argv,cpuOnly=false,generated=null){
    const key='launch:'+nonce();debit({kind,key,units:0,identity:{entry,argv:sha(canonical(argv)),cpuOnly,generated,child:null,closed:false,result:null}});return key;
  }
  function nodeOptions(args,options){
    const command=nodeCommand(args),key=registerLaunch('node',command.entry,command.argv,command.cpuOnly,command.generated);
    const wire=Buffer.from(canonical({path,base,key})).toString('base64url');
    const env={...(options.env??process.env),NODE_OPTIONS:'--import='+preload,LOOPWRIGHT_PI_DOCKER_SOCKET:plan.socket,S04_S03_SCOPE:wire};
    return {command,key,options:{...timeout(options),...(process.pid===plan.owner.pid?{timeout:Number(BigInt(plan.clock.hardCutoff)-monotonic())}:{}),env,execArgv:[]}};
  }
  function ownedContainer(identity){
    const s=scope(true),row=s.entry.s03.events.find(e=>e.kind==='containers'&&(e.identity.name===identity||e.identity.id===identity||s.entry.s03.occupants.find(o=>o.key===e.key)?.id===identity));
    if(row)return row.identity;
    // A source cleanup may inspect a proven already-removed ID; its immutable create event retains the ID in this actor's observation.
    const old=records.find(r=>r.container?.id===identity);need(old);return old.container;
  }
  function sameDaemon(cleanup){
    if(copied)return;
    check(cleanup);const remaining=Number(BigInt(cleanup?plan.clock.hardCutoff:plan.clock.workCutoff)-monotonic());need(remaining>0);
    const args=['--config',plan.client,'--host','unix://'+plan.socket,'info','--format','{{.ID}}'],result=lower.spawnSync(plan.executable,args,{encoding:'utf8',timeout:Math.min(2000,remaining),maxBuffer:4096,env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:plan.directory,LANG:'C'}});
    observe({kind:'original-daemon-read',pid:result.pid,exit:result.status,signal:result.signal,stdout:result.stdout??'',stderr:result.stderr??''});
    need(result.pid>0&&result.status===0&&result.signal===null&&!result.error&&result.stderr===''&&result.stdout.trim()===plan.runtime.daemon.id);check(cleanup);
  }
  function dockerCommand(args){
    need(!cpu&&Array.isArray(args)&&args.length>=5&&args[0]==='--config'&&args[2]==='--host'&&args[3]==='unix://'+plan.socket);
    const selected=resolve(args[1]);need(selected===args[1]&&['docker-client','recovery-docker-client','guard-docker-client'].some(name=>selected.endsWith('/'+name)));
    // Original final collectors name the shared build directory. Never load its historical buildx/auth data.
    // Route only exact owned cleanup through this attempt's already-frozen empty private config.
    if(selected===join(plan.project,'.claude/s03-t0/docker-client')){need(['create','start','inspect','kill','rm','top'].includes(args[4]));args[1]=plan.client;}
    const config=args[1];
    if(existsSync(config)){need(realpathSync(config)===config);for(const name of readdirSync(config))need(name==='config.json');if(existsSync(join(config,'config.json')))need(same(JSON.parse(readFileSync(join(config,'config.json'))),{}));}
    const command=args[4],tail=args.slice(5);need(['create','inspect','image','info','version','start','kill','rm','top','exec'].includes(command));
    let container=null;
    if(command==='create'){
      need(args.filter(v=>v===plan.image).length===1&&args.includes('--pull=never')&&args.includes('--read-only')&&args[args.indexOf('--network')+1]==='none');
      const name=args[args.indexOf('--name')+1],labels={};need(args.includes('--name'));
      for(let n=5;n<args.indexOf(plan.image);n++)if(args[n]==='--label'){const text=args[++n],index=text.indexOf('=');need(index>0&&!Object.hasOwn(labels,text.slice(0,index)));labels[text.slice(0,index)]=text.slice(index+1);}
      if(name.startsWith('lw-pi-discovery-')){
        need(['session','session-opus'].includes(plan.group)&&actor===join(plan.project,'packages/agent-pi/qualification/session.mjs'));
        const intent=JSON.parse(readFileSync(join(dirname(config),'intent.json')));need(intent.name===name&&name==='lw-pi-discovery-'+intent.nonce&&intent.image===plan.image&&same(labels,{'org.loopwright.nonce':intent.nonce})&&tail.at(-1)==='/opt/loopwright/packages/agent-pi/qualification/session-discovery-child.mjs');
      }else if(name.startsWith('lw-pi-')){
        const intent=JSON.parse(readFileSync(join(dirname(config),'container-intent.json')));need(intent.name===name&&same(intent.labels,labels)&&intent.image===plan.image&&name.endsWith(labels['org.loopwright.nonce']));
      }else need(name.startsWith('lw-s03-')&&labels['org.loopwright.owner']==='task_33be673484e7'&&/^[a-f0-9]{12,32}$/.test(labels['org.loopwright.nonce']));
      container={name,image:plan.image,labels,directory:dirname(config)};debit({kind:'containers',key:'container:'+name,units:1,identity:container});
    }else if(command==='image')need(same(tail,['inspect',plan.image]));
    else if(command==='info')need(same(tail,['--format','{{.ID}}']));
    else if(command==='version')need(same(tail,['--format','{{.Server.Os}}/{{.Server.Arch}}']));
    else if(command==='top'){need(tail.length===3&&tail[1]==='-eo'&&tail[2]==='pid,ppid,args');ownedContainer(tail[0]);}
    else {const identity=command==='exec'?tail[0]:tail.at(-1);ownedContainer(identity);}
    return {command,container,cleanup:['inspect','kill','rm','top'].includes(command)};
  }
  function classify(file,args,options={}){
    if(file===process.execPath||file==='node')return {node:true,file:process.execPath,...nodeOptions(args,options)};
    if(file==='docker'||file===plan.executable){const normalized=[...args],docker=dockerCommand(normalized);return {file:plan.executable,args:normalized,options:timeout(options,docker.cleanup),docker,metadata:['inspect','info','version','image'].includes(docker.command)};}
    if(file==='/usr/bin/which'){need(same(args,['docker']));return {file,args,options:timeout(options,true),metadata:true};}
    if(file==='/bin/ps'){need(args.length===4&&args[0]==='-p'&&/^\d+$/.test(args[1])&&args[2]==='-o'&&['lstart=','ppid='].includes(args[3]));return {file,args,options:timeout(options,true),metadata:true};}
    if(file==='/usr/sbin/sysctl'){need(same(args,['-n','kern.boottime']));return {file,args,options:timeout(options,true),metadata:true};}
    fakeInfoCli(file,args,ownedFixtureRoots);return {file,args,options:timeout(options),fixture:true};
  }
  function start(file,args,options={}){
    const spec=classify(file,args,options);spec.args??=args;
    if(!spec.node&&!spec.metadata)spec.key=registerLaunch(spec.docker?.cleanup?'cleanup-process':'process',spec.file,[spec.file,...spec.args]);return spec;
  }
  function finish(spec,pid,exit,signal,stdout,stderr){
    // REVIEW-073 diagnostic: retain the original stderr/stdout bytes of a failed suite child so its cause is
    // recoverable from the attempt directory instead of being lost with the supervisor's captured pipe.
    if(spec.options?.suiteChild&&exit!==0&&exit!==null){exclusive(join(plan.directory,'suite-child-'+pid+'-exit-'+(exit??'signal')+'-stderr.bin'),Buffer.from(stderr??''));exclusive(join(plan.directory,'suite-child-'+pid+'-exit-'+(exit??'signal')+'-stdout.bin'),Buffer.from(stdout??''));}
    if(spec.docker?.command==='info'&&!copied&&exit===0)need(String(stdout).trim()===plan.runtime.daemon.id);
    if(spec.key)debit({kind:'node-close',key:spec.key,units:0,identity:{pid,exit,signal,stdout:sha(stdout??''),stderr:sha(stderr??''),streams:'closed'}});
    if(spec.docker?.container&&exit===0){const id=String(stdout).trim();need(/^[a-f0-9]{64}$/.test(id));observeS03Container(path,base,spec.docker.container.name,id,'bind',{copied,observe:targets?.containerObserve??null});spec.docker.container.id=id;}
    if(spec.docker?.command==='rm'&&exit===0){for(const row of [...scope(true).entry.s03.occupants])if(row.id&&spec.args.includes(row.id))observeS03Container(path,base,row.name,row.id,'absent',{copied,observe:targets?.containerObserve??null});}
    records.push({kind:spec.node?'node':spec.metadata?'metadata':'process',key:spec.key??null,pid,exit,signal,container:spec.docker?.container??null});
  }
  function spawnBound(spec,invoke){
    if(spec.docker&&['create','start','kill','rm','exec'].includes(spec.docker.command))sameDaemon(spec.docker.cleanup);check(spec.docker?.cleanup??false);const child=invoke();need(Number.isSafeInteger(child.pid)&&child.pid>0);
    if(spec.key){try{debit({kind:'process-bind',key:spec.key,units:0,identity:localOwner(child.pid)});}catch(error){try{process.kill(child.pid,0);child.kill('SIGKILL');throw error;}catch(checkError){if(checkError.code!=='ESRCH')throw checkError;}}}
    const buffers={stdout:[],stderr:[]},sizes={stdout:0,stderr:0};
    const startTarget=spec.docker?.command==='start'?ownedContainer(spec.args.at(-1)):null;
    const isMcpStart=Boolean(startTarget&&(startTarget.labels?.['org.loopwright.role']==='mcp'||startTarget.name.endsWith('-mcp')));
    const rawStdout=child.stdout;
    if(rawStdout&&isMcpStart){
      // REVIEW-078: pace coalesced MCP stdout line bursts (1 line per 6ms cooldown tick after a synchronous
      // first line; the timer is armed unconditionally so back-to-back single-line chunks cannot bypass it)
      // so the production McpProcess never coalesces 8+ synchronous Channel writes into MCP_FAILED; incomplete
      // carry is never flushed before its newline or end, and the raw buffers stay attached to the underlying
      // stream so s03Closed retains the exact full stdout bytes.
      const paced=new PassThrough();
      let carry=Buffer.alloc(0),queue=[],paceTimer=null,ended=false;
      const finishIfIdle=()=>{if(ended&&!queue.length&&paceTimer===null&&!paced.writableEnded){if(carry.length){paced.write(carry);carry=Buffer.alloc(0);}paced.end();}};
      const step=()=>{if(queue.length){paced.write(queue.shift());paceTimer=setTimeout(step,6);}else{paceTimer=null;finishIfIdle();}};
      const pump=chunk=>{sizes.stdout+=chunk.length;if(sizes.stdout>4194304){child.kill('SIGKILL');return;}buffers.stdout.push(Buffer.from(chunk));
        carry=Buffer.concat([carry,chunk]);
        for(;;){const end=carry.indexOf(10);if(end<0)break;queue.push(Buffer.from(carry.subarray(0,end+1)));carry=Buffer.from(carry.subarray(end+1));}
        if(carry.length>65536){queue.push(carry);carry=Buffer.alloc(0);}
        if(paceTimer===null&&queue.length){paced.write(queue.shift());paceTimer=setTimeout(step,6);}
      };
      const finishOut=()=>{ended=true;finishIfIdle();};
      rawStdout.on('data',pump);rawStdout.on('error',error=>paced.destroy(error));rawStdout.on('end',finishOut);
      child.once('close',()=>{if(paceTimer!==null){clearTimeout(paceTimer);paceTimer=null;}});
      Object.defineProperty(child,'stdout',{value:paced,configurable:true});
    } else if(rawStdout){rawStdout.on('data',chunk=>{sizes.stdout+=chunk.length;if(sizes.stdout>4194304){child.kill('SIGKILL');return;}buffers.stdout.push(Buffer.from(chunk));});}
    child.stderr?.on('data',chunk=>{sizes.stderr+=chunk.length;if(sizes.stderr>4194304){child.kill('SIGKILL');return;}buffers.stderr.push(Buffer.from(chunk));});
    let ioError=null;child.once('error',error=>{ioError=error;});
    if(child.stdin){
      const write=child.stdin.write.bind(child.stdin);let pending='',channelKind=null,target=null;
      child.stdin.write=function(chunk,...args){
        let finalPermission=null,cleanup=false;
        if(spec.docker&&spec.docker.command==='start'){
          target=startTarget;pending+=Buffer.from(chunk).toString('utf8');need(Buffer.byteLength(pending)<=65536);
          for(;;){
            const end=pending.indexOf('\n');if(end<0)break;const line=pending.slice(0,end);pending=pending.slice(end+1);if(!line)continue;
            const message=JSON.parse(line);
            if(target.labels?.['org.loopwright.role']==='mcp'||target.name.endsWith('-mcp')){
              cleanup=message.method==='notifications/cancelled';
              if(message.method==='tools/call'){
                physicalObservation(debit,'mcp',target.name,line);
                if(plan.group==='runtime-path')need(target.name.startsWith('lw-s03-')&&message.params.name==='read_file');
                else if(target.directory.endsWith('/control-mcp')&&['mcp','limits'].includes(plan.group)){
                  need(message.params.name==='denied_write');debit({kind:'dispatch',key:'trusted-control:'+target.name,units:0,identity:{source:'original-mcp-fixtureEffectControl',target:target.name}});
                }else {need(finalPermission===null);finalPermission=['mcp',message.params?.arguments?.path];}
              }
            }else{
              if(message.kind==='begin')channelKind=message.body.kind;
              cleanup=['abort','cancel','close','shutdown'].includes(channelKind);
              if(message.kind==='end'&&target.labels?.['org.loopwright.role']==='tool'){need(finalPermission===null);finalPermission=['operation',target.labels['org.loopwright.operation']];}
              if(message.kind==='end')channelKind=null;
            }
          }
        }
        check(cleanup);if(finalPermission)stateObserver.assertTransport(...finalPermission);return write(chunk,...args);
      };
    }
    const closed=new Promise((resolve,reject)=>child.once('close',(code,signal)=>{try{need(sizes.stdout<=4194304&&sizes.stderr<=4194304);finish(spec,child.pid,code,signal,Buffer.concat(buffers.stdout),Buffer.concat(buffers.stderr));if(ioError)reject(ioError);else resolve({stdout:Buffer.concat(buffers.stdout),stderr:Buffer.concat(buffers.stderr),code,signal});}catch(error){reject(error);}}));
    closed.catch(()=>{});Object.defineProperty(child,'s03Closed',{value:closed});return child;
  }
  cp.spawn=(file,args=[],options={})=>{const spec=start(file,args,options);return spawnBound(spec,()=>lower.spawn(spec.file,spec.args,spec.options));};
  cp.fork=(file,args=[],options={})=>{const argv=[file,...args],spec=start(process.execPath,argv,options);return spawnBound(spec,()=>lower.fork(file,args,spec.options));};
  cp.spawnSync=(file,args=[],options={})=>{const spec=start(file,args,options);if(spec.docker&&['create','start','kill','rm','exec'].includes(spec.docker.command))sameDaemon(spec.docker.cleanup);check(spec.docker?.cleanup??false);const result=lower.spawnSync(spec.file,spec.args,spec.options);need(result.pid>0&&result.signal===null||result.pid>0&&typeof result.signal==='string');finish(spec,result.pid,result.status,result.signal,result.stdout,result.stderr);return result;};
  cp.execFileSync=(file,args=[],options={})=>{
    const spec=start(file,args,options);if(spec.docker&&['create','start','kill','rm','exec'].includes(spec.docker.command))sameDaemon(spec.docker.cleanup);check(spec.docker?.cleanup??false);const result=lower.spawnSync(spec.file,spec.args,{...spec.options,stdio:options.stdio??['ignore','pipe','pipe']});
    if(result.pid>0)finish(spec,result.pid,result.status,result.signal,result.stdout,result.stderr);
    if(result.error||result.status!==0){const error=result.error??new Error('Command failed: '+file);Object.assign(error,{pid:result.pid,status:result.status,signal:result.signal,output:result.output,stdout:result.stdout,stderr:result.stderr});throw error;}
    return result.stdout;
  };
  cp.execFile=(file,args=[],options={},callback)=>{
    if(typeof options==='function'){callback=options;options={};}const spec=start(file,args,options),child=spawnBound(spec,()=>lower.execFile(spec.file,spec.args,spec.options,(error,stdout,stderr)=>{child.s03Closed.then(()=>callback?.(error,stdout,stderr),failure=>callback?.(failure,stdout,stderr));}));return child;
  };
  Object.defineProperty(cp.execFile,promisify.custom,{value:(...args)=>{const {promise,resolve,reject}=Promise.withResolvers();promise.child=cp.execFile(...args,(error,stdout,stderr)=>{if(error!==null){error.stdout=stdout;error.stderr=stderr;reject(error);}else resolve({stdout,stderr});});return promise;}});
  cp.exec=()=>fail('QUALIFICATION_S03_SHELL');cp.execSync=()=>fail('QUALIFICATION_S03_SHELL');
  function listenerFor(url){
    const current=scope();need(!cpu&&url.protocol==='http:'&&url.hostname==='127.0.0.1'&&url.port&&!url.username&&!url.password&&!url.hash);
    const row=current.entry.s03.events.find(e=>e.kind==='listener'&&!e.identity.closed&&e.identity.port===Number(url.port));need(row&&same(localOwner(row.actor.pid),row.actor));return row;
  }
  globals.fetch=(input,options={})=>atLower('fetch',()=>{
    const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);listenerFor(url);
    if(options.method==='POST'){
      if(plan.group==='admission-mutations')admissionTransport(plan,actor,url,options);
      physicalObservation(debit,'provider',url.href,options.body);
    }else need(['runtime-path','containment'].includes(plan.group)&&!options.body&&(!options.method||options.method==='GET')&&url.pathname==='/');
    check();if(options.method==='POST')stateObserver.assertTransport('provider',sha(options.body));return lower.fetch(input,options);
  });
  // Every HTTP client entry must use the counted original fetch above; no alternate hidden sender.
  if(!targets){
    http.request=()=>fail('QUALIFICATION_S03_TRANSPORT');https.request=()=>fail('QUALIFICATION_S03_TRANSPORT');
    net.Server.prototype.listen=function(...args){
      check();const first=args[0];
      if(typeof first==='string'){need(actor==='node:daemon-fixture');fixtureSocket(first);}
      else {need(!cpu&&(first===0||typeof first==='object'&&first.port===0));const host=typeof first==='object'?first.host:args[1];need(['127.0.0.1','0.0.0.0','::1'].includes(host));}
      let key=null;this.once('listening',()=>{const address=this.address();if(typeof address==='object'&&address){key='listener:'+nonce();debit({kind:'listener',key,units:0,identity:{address:address.address,port:address.port,closed:false}});}});
      this.once('close',()=>{if(key)debit({kind:'listener-close',key,units:0,identity:{}});});return Reflect.apply(lower.listen,this,args);
    };
    net.Socket.prototype.connect=function(...args){return atLower('socket-connect',()=>{
      const normalized=Array.isArray(args[0])?args[0]:args,selected=normalized[0];let host,port;
      if(selected&&typeof selected==='object'){need(!selected.path);host=selected.host??selected.hostname??'localhost';port=selected.port;}
      else {need(typeof selected==='number'||typeof selected==='string'&&/^\d+$/.test(selected));port=selected;host=typeof normalized[1]==='string'?normalized[1]:'localhost';}
      listenerFor(new URL('http://'+host+':'+port+'/'));return Reflect.apply(lower.connect,this,args);
    });};
    syncBuiltinESMExports();
  }
  return {stateObserver,check,debit,scope,records,observations,flush(){return exclusive(join(plan.directory,'actor-'+process.pid+'.json'),{version:1,owner:localOwner(),entry:actor,records,observations});},restore(){for(const key of ['spawn','fork','spawnSync','execFile','execFileSync','exec','execSync']){if(Object.hasOwn(savedProcess,key))cp[key]=savedProcess[key];else delete cp[key];}if(hadFetch)globals.fetch=savedFetch;else delete globals.fetch;if(!targets){net.Server.prototype.listen=lower.listen;net.Socket.prototype.connect=lower.connect;http.request=lower.http;https.request=lower.https;syncBuiltinESMExports();}}};
}
