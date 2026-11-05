import { canonical, enumeration, id, integer, record, snapshot, STATE_LIMITS } from './boundary.js';
import { fail } from './errors.js';
import type { Data } from './model.js';
import type { Page, PageCursor } from './types.js';
type Collection=PageCursor['collection'];
export function pageInput(input:unknown):{limit:number;cursor:PageCursor|null} {
  const v=record(snapshot(input),['limit','cursor']);let cursor:PageCursor|null=null;
  if(v.cursor!==null){const c=record(v.cursor,['storeId','runId','collection','revision','afterSequence']);cursor={storeId:id(c.storeId),runId:id(c.runId),collection:enumeration(c.collection,['requests','operations','checkpoints']),revision:integer(c.revision),afterSequence:integer(c.afterSequence,'',0,2048)};}
  return {limit:integer(v.limit,'/limit',1,100),cursor};
}
export function page<T extends {readonly sequence:number}>(data:Data,collection:Collection,values:readonly T[],input:ReturnType<typeof pageInput>):Page<T> {
  const cursor=input.cursor;
  if(cursor){if(cursor.storeId!==data.identity.storeId||cursor.runId!==data.identity.lock.spec.runId)fail('IDENTITY_CONFLICT','/cursor');if(cursor.collection!==collection)fail('INVALID_INPUT','/cursor/collection');if(cursor.revision!==data.revision)fail('REVISION_CONFLICT','/cursor/revision');if(cursor.afterSequence>values.length)fail('INVALID_INPUT','/cursor/afterSequence');}
  const remaining=values.filter(v=>v.sequence>(cursor?.afterSequence??0));const items:T[]=[];let result:Page<T>={revision:data.revision,items,next:null};
  for(const item of remaining){if(items.length>=input.limit)break;const candidate=[...items,item];const next:PageCursor|null=candidate.length<remaining.length?{storeId:data.identity.storeId,runId:data.identity.lock.spec.runId,collection,revision:data.revision,afterSequence:item.sequence}:null;const proposed={revision:data.revision,items:candidate,next};if(Buffer.byteLength(canonical(proposed))>STATE_LIMITS.pageBytes)break;items.push(item);result=proposed;}
  if(!items.length&&remaining.length)fail('LIMIT_EXCEEDED','/page');return result;
}
