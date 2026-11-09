import {readFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {canonical,checkedRef,readPrivate,sha,same,fail} from './native-context.mjs';
const project='/Users/thxcode/orca/workspaces/loopwright/loopwright-s04-controller';
export function currentS03Preflight(){
  const directory=join(project,'.claude/s04-qualification/delivery-preflight-031'),input=JSON.parse(readPrivate(join(directory,'input.json'))),consumed=readdirSync(directory).filter(name=>name.startsWith('attempt-consumed-'));
  if(resolve('.')!==project||consumed.length!==1)fail('QUALIFICATION_S03_PREFLIGHT');
  const consumption=JSON.parse(readPrivate(join(directory,consumed[0]))),receipt=JSON.parse(checkedRef(consumption.receipt)),ack=JSON.parse(checkedRef(consumption.ack));
  if(receipt.outcome.error!==null||!same(ack.transition.receipt,consumption.receipt)||ack.id!==receipt.commandId||receipt.leaf!=='image-preflight'||receipt.phase!=='initial'||receipt.seconds>60||receipt.originalBudget.sha256!==input.expectedBudgetSha256)fail('QUALIFICATION_S03_PREFLIGHT');
  const result=JSON.parse(checkedRef(receipt.outcome.output));checkedRef(result.intent);
  if(result.image.Id!=='sha256:6c52d01f4514b2376422399be1b7909233373b0063d0d10920fbdc98343a7257'||result.image.Config.User!=='1000:1000'||result.compared.entries!==19746||result.reads.length!==37)fail('QUALIFICATION_S03_PREFLIGHT');
  const current={};for(const name of readdirSync(join(project,'packages/controller/qualification')).filter(n=>n.endsWith('.mjs')).sort())current['packages/controller/qualification/'+name]=sha(readFileSync(join(project,'packages/controller/qualification',name)));
  if(!same(current,input.source)||sha(canonical(current))!==input.sourceDigest)fail('QUALIFICATION_S03_PREFLIGHT_SOURCE');
  return {directory,result:receipt.outcome.output,receipt:consumption.receipt,ack:consumption.ack,image:result.image.Id,socket:result.socket,executable:result.executable,daemon:result.daemon,entries:result.compared.entries,baseScope:result.baseScope,scope:'fresh existing pinned image/profile/layers/complete current payload; no build; original initial:image-preflight seconds counted once; no SDK/provider acceptance'};
}
