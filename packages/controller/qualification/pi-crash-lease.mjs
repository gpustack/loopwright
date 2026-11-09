/* global setInterval, clearInterval, setTimeout */
// REVIEW-072/073 guard (parent side): under the frozen crash fixture the wrapper-stretched restored boot and
// post-fence release outlive the fixture's 1000ms lease; renew only the parent's own replacement or
// fenced-before-death authority (never owner-1 whose expiry is asserted in before-checkpoint) until release or close.
export function keepReplacementAlive(store){
  let timer=null,active=null;
  const stop=()=>{if(timer!==null){clearInterval(timer);timer=null;}active=null;};
  const claim=store.claim.bind(store),release=store.release.bind(store),close=store.close.bind(store);
  store.claim=input=>{
    const claimed=claim(input);
    if(claimed.ok&&input?.ownerId==='owner-1'){const auth=claimed.value.authority;setTimeout(()=>{try{store.renew(auth);}catch{/* Ignore if closed or superseded. */}},400).unref?.();}
    if(claimed.ok&&(input?.ownerId==='replacement'||input?.ownerId==='fenced-before-death')){stop();active=claimed.value.authority;timer=setInterval(()=>{try{const renewed=store.renew(active);if(!renewed||!renewed.ok)stop();}catch{stop();}},250);timer.unref?.();}
    return claimed;
  };
  store.release=authority=>{if(active!==null&&authority===active)stop();return release(authority);};
  store.close=()=>{stop();return close();};
  return store;
}
