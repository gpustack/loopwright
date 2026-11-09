/* global process, URL */
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, lstatSync, realpathSync, readdirSync } from 'node:fs';
import { canonical, same, readPrivate, sha, fail } from './native-context.mjs';
/** Literal stock grammar qualified against frozen source, never imported from a private adapter module. */
export function stockCreateArguments(identity,candidate,role,seccomp=fileURLToPath(new URL('../../agent-pi/runtime/seccomp.json',import.meta.url))) {
  return ['create','--pull=never','--interactive','--init','--name',identity.name,
    ...Object.entries(identity.labels).flatMap(([key,value])=>['--label',key+'='+value]),'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges=true',
    '--security-opt','seccomp='+seccomp,'--user','1000:1000','--memory','512m','--memory-swap','512m','--cpus','1','--pids-limit','64','--log-driver','none',
    '--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=33554432','--tmpfs','/scratch:rw,nosuid,nodev,noexec,size=134217728','--mount','type=bind,src='+candidate+',dst=/workspace/candidate,readonly',
    '--env','HOME=/tmp/home','--env','PI_OFFLINE=1','--env','PATH=/usr/local/bin:/usr/bin:/bin','--env','LANG=C.UTF-8','--env','TERM=dumb',
    identity.image,'/opt/loopwright/packages/agent-pi/dist/'+(role==='sdk'?'sdk-worker.js':role==='tool'?'tool-worker.js':'workspace-mcp.js'),identity.nonce];
}
function descendant(root,path){const rel=relative(root,path);return rel!==''&&!rel.startsWith('..')&&!isAbsolute(rel);}
function ownedDirectory(path){const st=lstatSync(path);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid()||st.mode&0o077||realpathSync(path)!==resolve(path))fail('QUALIFICATION_STOCK_DIRECTORY');}
function optionalDirectory(path){try{lstatSync(path);}catch(error){if(error.code==='ENOENT')return false;throw error;}ownedDirectory(path);return true;}
function emptyClient(path){try{lstatSync(path);}catch(error){if(error.code==='ENOENT')return;throw error;}ownedDirectory(path);if(readdirSync(path).length)fail('QUALIFICATION_STOCK_CLIENT');}
/** Registration is explicit trusted admission data, not a final-read owner or a task-supplied policy. */
export class StockIntentRegistry {
  #commands=new Map();#identities=new Map();
  constructor(registration){this.registration=Object.freeze({...registration});}
  resolve(args,options){
    const r=this.registration,home=options?.env?.HOME;
    if(!Array.isArray(args)||typeof home!=='string'||!descendant(r.runtimeRoot,home)||args[0]!=='--config'||args[2]!=='--host'||args[3]!=='unix://'+r.socket)fail('QUALIFICATION_STOCK_BINDING');
    ownedDirectory(r.runtimeRoot);
    const roleBinding=r.roles.find(row=>home===row.hostDirectory||home===join(row.hostDirectory,'sdk-'+row.sessionId)||home===join(row.hostDirectory,'mcp-'+row.sessionId)||(row.operationIds??[]).some(id=>home===join(row.hostDirectory,'tool-'+id)));
    if(!roleBinding)fail('QUALIFICATION_STOCK_ROLE_DIRECTORY');
    ownedDirectory(roleBinding.hostDirectory);
    const key=canonical({args,environment:options.env});if(this.#commands.has(key))return this.#commands.get(key);
    const tail=args.slice(4);let entry;
    if(args[1]===join(home,'guard-docker-client')&&same(tail,['info','--format','{{.ID}}'])&&same(options.env,{PATH:'/usr/bin:/bin:/usr/sbin',HOME:home,LANG:'C'})){
      ownedDirectory(home);emptyClient(args[1]);entry={kind:'preflight',argv:[...args],environment:{...options.env},identity:null,source:'stock-daemon-binding'};
    }else{
      if(args[1]!==join(home,'docker-client')||!same(options.env,{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:home,LANG:'C.UTF-8'}))fail('QUALIFICATION_STOCK_ENVIRONMENT');
      const present=optionalDirectory(home);if(!present&&!same(tail,['image','inspect',r.image]))fail('QUALIFICATION_STOCK_DIRECTORY');
      emptyClient(args[1]);
      if(same(tail,['image','inspect',r.image]))entry={kind:'preflight',argv:[...args],environment:{...options.env},identity:null,source:'stock-image-binding'};
      else{
        ownedDirectory(home);
        const path=join(home,'container-intent.json'),bytes=readPrivate(path),intent=JSON.parse(bytes),labels=intent.labels;
        if(intent.image!==r.image||!/^[a-f0-9]{32}$/.test(intent.nonce)||labels?.['org.loopwright.nonce']!==intent.nonce||labels['org.loopwright.run']!==r.runId||labels['org.loopwright.generation']!==String(r.owner.generation)||labels['org.loopwright.session']!==roleBinding.sessionId)fail('QUALIFICATION_STOCK_IDENTITY');
        const role=labels['org.loopwright.role']??'sdk',allowed=role==='sdk'?['org.loopwright.generation','org.loopwright.run','org.loopwright.session','org.loopwright.nonce']:['org.loopwright.generation','org.loopwright.run','org.loopwright.session','org.loopwright.nonce','org.loopwright.role','org.loopwright.operation'];
        if(!['sdk','tool','mcp'].includes(role)||!same(Object.keys(labels).sort(),allowed.sort())||intent.name!=='lw-pi-'+(role==='sdk'?'':role+'-')+intent.nonce)fail('QUALIFICATION_STOCK_LABELS');
        if(role==='sdk'&&home!==join(roleBinding.hostDirectory,'sdk-'+roleBinding.sessionId)||role==='mcp'&&home!==join(roleBinding.hostDirectory,'mcp-'+roleBinding.sessionId)||role==='tool'&&home!==join(roleBinding.hostDirectory,'tool-'+labels['org.loopwright.operation']))fail('QUALIFICATION_STOCK_ROLE_DIRECTORY');
        const identity={name:intent.name,nonce:intent.nonce,labels,image:intent.image},candidate=roleBinding.candidate;
        if(typeof candidate!=='string'||!descendant(r.runtimeRoot,candidate)||realpathSync(candidate)!==candidate)fail('QUALIFICATION_STOCK_CANDIDATE');
        const original=this.#identities.get(intent.nonce);if(original&&original.sha256!==sha(bytes))fail('QUALIFICATION_STOCK_INTENT_CHANGED');
        const idPath=join(home,'container-id.json'),id=existsSync(idPath)?JSON.parse(readPrivate(idPath)):null;
        if(id&&(id.nonce!==intent.nonce||!/^[a-f0-9]{64}$/.test(id.id)))fail('QUALIFICATION_STOCK_RETURN_ID');
        let kind;
        if(same(tail,stockCreateArguments(identity,candidate,role)))kind='create';
        else if(id&&same(tail,['start','--attach','--interactive',id.id]))kind='start';
        else if(same(tail,['inspect',id?.id??intent.name]))kind='read';
        else if(id&&(same(tail,['kill',id.id])||same(tail,['rm',id.id])))kind='cleanup';
        else fail('QUALIFICATION_STOCK_ARGUMENTS');
        this.#identities.set(intent.nonce,{sha256:sha(bytes),identity,home});
        entry={kind,argv:[...args],environment:{...options.env},identity,intent:{path,byteLength:bytes.length,sha256:sha(bytes)},source:'stock-owned-container'};
      }
    }
    // Do not cache creates/starts: every invocation must re-read the original intent before its fresh public fence.
    const frozen=Object.freeze({...entry,argv:Object.freeze(entry.argv),environment:Object.freeze(entry.environment)});
    if(entry.kind==='read'&&entry.identity===null)this.#commands.set(key,frozen);return frozen;
  }
}
