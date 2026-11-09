/* global process */
import childProcess from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import {syncBuiltinESMExports} from 'node:module';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
// Fixed synthetic retained-store readiness only. This DENIES every process/network lower and issues no native quota.
const root='/Users/thxcode/orca/workspaces/loopwright/loopwright-s04-controller',entry=resolve(root,'packages/agent-pi/qualification/retained-cost.mjs');
if(resolve('.')!==root||resolve(process.argv[1]??'')!==entry||process.argv.length!==3||resolve(process.argv[2])!==resolve(root,'.claude/s03-retained-cost')||createHash('sha256').update(readFileSync(entry)).digest('hex')!=='b90bdd4b72eca54520327a1359350eb82dc42d459789b4d37299f21f978c3508')throw new Error('QUALIFICATION_S03_CPU_ENTRY');
const denied=()=>{throw new Error('QUALIFICATION_S03_CPU_NATIVE_DENIED');};
for(const key of ['exec','execFile','execSync','execFileSync','spawn','spawnSync','fork'])childProcess[key]=denied;
for(const module of [http,https])for(const key of ['request','get'])module[key]=denied;
net.Server.prototype.listen=denied;net.Socket.prototype.connect=denied;tls.connect=denied;globalThis.fetch=denied;
syncBuiltinESMExports();
