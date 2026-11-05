import { reopenLocalRun, type Authority, type LocalRunIdentity, type LocalRunStore } from '../../src/index.js';
let store:LocalRunStore|undefined;
let token:Authority|undefined;
type Message={action:string;input?:LocalRunIdentity;ownerId?:string;guard?:{expectedGeneration:number;expectedRevision:number};authority?:Authority};
function send(value:unknown){process.send?.(value);}
process.on('message',(message:Message)=>{
  try{
    if(message.action==='open'){
      const result=reopenLocalRun(message.input!);if(result.ok)store=result.value;send({kind:'opened',result:result.ok?{ok:true}:result,pid:process.pid,clock:{wallMs:Date.now(),monotonicMs:String(process.hrtime.bigint()/1000000n)}});
    }else if(message.action==='claim'){
      const result=store!.claim({ownerId:message.ownerId!,expectedGeneration:message.guard!.expectedGeneration,expectedRevision:message.guard!.expectedRevision,mode:'active'});if(result.ok)token=result.value.authority;send({kind:'claimed',result,pid:process.pid});
    }else if(message.action==='renew'){
      send({kind:'renewed',result:store!.renew(message.authority??token!),pid:process.pid,alive:true});
    }else if(message.action==='close'){
      const result=store?.close();process.send?.({kind:'closed',result,pid:process.pid},()=>{process.disconnect?.();process.exitCode=0;});
    }
  }catch(error){send({kind:'failure',message:error instanceof Error?error.message:String(error),pid:process.pid});}
});
send({kind:'ready',pid:process.pid});
