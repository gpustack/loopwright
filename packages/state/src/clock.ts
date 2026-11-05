import { addMono, checkedAdd, integer, mono, record, text } from './boundary.js';
import { fail } from './errors.js';
import type { ClockBasis, ClockSample } from './types.js';
export type ClockSource = () => ClockSample;
export const systemClock: ClockSource = () => ({wallMs:Date.now(),monotonicMs:String(process.hrtime.bigint()/1000000n)});
export function clockSample(input:unknown):ClockSample {
  const v=record(input,['wallMs','monotonicMs']);return {wallMs:integer(v.wallMs),monotonicMs:mono(v.monotonicMs)};
}
export function clockBasis(input:unknown):ClockBasis {
  const v=record(input,['clockEpoch','created','taskDeadlineMonotonicMs']);return {clockEpoch:text(v.clockEpoch),created:clockSample(v.created),taskDeadlineMonotonicMs:mono(v.taskDeadlineMonotonicMs)};
}
export function makeBasis(clockEpoch:string,created:ClockSample,budgetMs:number):ClockBasis {return {clockEpoch,created:{...created},taskDeadlineMonotonicMs:addMono(created.monotonicMs,budgetMs)};}
const abs=(value:bigint)=>value<0n?-value:value;
export function clockValid(basis:ClockBasis,last:ClockSample,now:ClockSample):boolean {
  const monoNow=BigInt(now.monotonicMs),monoLast=BigInt(last.monotonicMs),monoBase=BigInt(basis.created.monotonicMs);
  if(monoNow<monoLast||now.wallMs<last.wallMs)return false;
  const adjacent=(BigInt(now.wallMs)-BigInt(last.wallMs))-(monoNow-monoLast);
  const cumulative=(BigInt(now.wallMs)-BigInt(basis.created.wallMs))-(monoNow-monoBase);
  return abs(adjacent)<=1000n&&abs(cumulative)<=1000n;
}
export function project(basis:ClockBasis,expiry:string):number {
  const delta=BigInt(expiry)-BigInt(basis.created.monotonicMs);if(delta<0n||delta>BigInt(Number.MAX_SAFE_INTEGER))fail('ARITHMETIC_OVERFLOW');
  return checkedAdd(basis.created.wallMs,Number(delta));
}
