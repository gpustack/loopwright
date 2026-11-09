/* global process, setInterval */
// Fixed copied bootstrap fixture only. It cannot open the actual native budget or issue a capability.
import { resolve,join } from 'node:path';
import { beginCopiedLauncherBootstrap,launcherBootstrapState } from './native-preflight-launcher.mjs';
import { localOwner } from './native-context.mjs';
const path=process.argv[2];
if(typeof path!=='string'||!path.startsWith(resolve('.claude/s04-qualification/launcher-source-'))||resolve(path)!==path||!path.endsWith('/budget.json'))throw new Error('COPIED_BOOTSTRAP_FIXTURE_PATH');
const handle=beginCopiedLauncherBootstrap(path);
if(!process.send)throw new Error('COPIED_BOOTSTRAP_FIXTURE_CHANNEL');
process.send({kind:'copied-bootstrap-open',owner:localOwner(),bootstrap:launcherBootstrapState(handle),entry:join(resolve('.'),'packages/controller/qualification/native-preflight-bootstrap-fixture.mjs')});
setInterval(()=>{},1000);
