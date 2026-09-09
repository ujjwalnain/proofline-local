import { createView } from './view.js';
import { speechAvailability, installSpeech, captureAudio, createLocalRecognizer } from './local-speech.js';
import { modelAvailability, prepareModel as loadModel, LocalChecker } from './local-checker.js';
import { updateTranscript, sanitizeClaim } from './session-state.js';
import { startDemo } from './demo.js';

const tabId=Number(new URLSearchParams(location.search).get('tabId'));
const state={phase:'idle',status:'Checking local AI availability…',partial:'',segments:[],claims:[],error:'',elapsedMs:0,rms:0,config:{language:'en-US'},embedded:false,title:'YouTube',localReady:false,setup:{speech:'checking',model:'checking'},preparation:null,progress:null};
const drafts=new Map();
let baseModel=null, active=null, prep=null, demoCleanup=null, clock=null, renderPending=false, availabilityTimer=null, disposed=false, availabilityEpoch=0;
const view=createView({start,stop,demo,close:closePanel,prepareSpeech,prepareModel});
function render(){if(!renderPending){renderPending=true;requestAnimationFrame(()=>{renderPending=false;view.render(state);});}}
function ready(){state.localReady=state.setup.speech==='available'&&state.setup.model==='available';}
function clearResults(){drafts.clear();state.partial='';state.segments=[];state.claims=[];state.error='';state.elapsedMs=0;}
function startClock(){clearInterval(clock);const start=performance.now();clock=setInterval(()=>{state.elapsedMs=performance.now()-start;render();},200);}
function current(session){return active===session&&!session.cancelled;}
function makeUncertain(){state.claims=state.claims.map(claim=>claim.status==='checking'?{...claim,status:'uncertain',explanation:'This session ended before the local evidence check finished.',sources:[]}:claim);}
render();
void initialize();

async function initialize(){
  await refreshAvailability();
  if(disposed)return;
  state.status=state.localReady?'Local AI ready':'Set up local AI · no API keys';
  if(Number.isSafeInteger(tabId)&&tabId>0){const tab=await chrome.tabs.get(tabId).catch(()=>null);state.title=(tab?.title||'YouTube').replace(/ - YouTube$/,'');}
  render();
}
async function refreshAvailability(){
  const epoch=++availabilityEpoch;
  clearTimeout(availabilityTimer);
  const results=await Promise.allSettled([speechAvailability('en-US'),modelAvailability()]);
  if(disposed||prep||epoch!==availabilityEpoch)return;
  state.setup.speech=results[0].status==='fulfilled'?results[0].value:'unavailable';
  state.setup.model=results[1].status==='fulfilled'?results[1].value:'unavailable';
  ready();
  if(Object.values(state.setup).includes('downloading'))availabilityTimer=setTimeout(()=>void refreshAvailability(),3000);
  render();
}

function beginPreparation(kind){
  if(active||prep)return null;
  availabilityEpoch++;clearTimeout(availabilityTimer);
  demoCleanup?.();demoCleanup=null;clearInterval(clock);
  const item={kind,cancelled:false,controller:new AbortController()};prep=item;
  state.phase='preparing';state.preparation=kind;state.progress=null;state.error='';
  state.status=kind==='speech'?'Preparing local speech recognition…':'Downloading local AI…';render();return item;
}
function endPreparation(item,error){
  if(prep!==item||item.cancelled)return;
  prep=null;state.preparation=null;state.progress=null;state.phase=error?'error':'idle';state.error=error?.message||'';
  ready();state.status=error?'Local setup needs attention':state.localReady?'Local AI ready':'Prepare the remaining local model';render();
}
function prepareSpeech(){
  const item=beginPreparation('speech');if(!item)return;
  // Invoke from this click, before awaiting; language-pack installation can consume activation.
  let installation;try{installation=installSpeech('en-US');}catch(error){endPreparation(item,error);return;}
  state.setup.speech='downloading';render();
  Promise.resolve(installation).then(async success=>{
    if(item.cancelled){void refreshAvailability();return;}
    const status=await speechAvailability('en-US');
    if(item.cancelled||prep!==item)return;
    state.setup.speech=status;
    if(!success||state.setup.speech!=='available')throw new Error('Chrome could not prepare English speech recognition. Check the device support notes and try again.');
    endPreparation(item);
  }).catch(error=>{if(!item.cancelled){state.setup.speech='downloadable';endPreparation(item,error);}void refreshAvailability();});
}
function prepareModel(){
  const item=beginPreparation('model');if(!item)return;
  let loading;try{loading=loadModel({signal:item.controller.signal,onProgress:value=>{if(!item.cancelled){state.progress=value;render();}}});}catch(error){endPreparation(item,error);return;}
  state.setup.model='downloading';render();
  Promise.resolve(loading).then(model=>{
    if(item.cancelled){model.destroy();void refreshAvailability();return;}
    baseModel?.destroy();baseModel=model;state.setup.model='available';endPreparation(item);
  }).catch(error=>{if(!item.cancelled){state.setup.model='downloadable';endPreparation(item,error);}void refreshAvailability();});
}

async function start(){
  if(active||prep||!state.localReady)return;
  demoCleanup?.();demoCleanup=null;clearResults();clearInterval(clock);
  const session={cancelled:false,stopping:false,stream:null,recognizer:null,checker:null,timer:null,meter:null,ending:false,recognitionEnded:false};active=session;
  state.phase='connecting';state.status='Choose the YouTube tab and share audio';render();
  try{
    const capture=captureAudio(); // Must stay before every await.
    const stream=await capture;
    if(!current(session)||session.stopping){stream.getTracks().forEach(track=>track.stop());return;}
    session.stream=stream;
    stream.getTracks().forEach(track=>track.addEventListener('ended',()=>{if(current(session)&&!session.stopping)void stop();},{once:true}));
    if(!baseModel){
      const model=await loadModel({onProgress:()=>{}});
      if(!current(session)||session.stopping){model.destroy();return;}
      baseModel=model;
    }
    session.checker=new LocalChecker({session:baseModel,emit:event=>{if(!current(session))return;receive(event);}});
    session.recognizer=createLocalRecognizer(stream,{
      language:'en-US',
      onDelta:event=>{if(current(session)){updateTranscript(state,event,drafts,false);render();}},
      onFinal:event=>{if(current(session)){updateTranscript(state,event,drafts,true);session.checker.add(event);render();}},
      onStatus:status=>{if(current(session)&&!session.stopping){state.status=status==='reconnecting'?'Restarting local captions…':'Listening · on-device AI';render();}},
      onError:error=>{if(current(session))void abort(session,error.message);},
      onEnd:()=>{if(current(session)){session.recognitionEnded=true;if(session.stopping)void drain(session);else void abort(session,'Local speech recognition ended. Start listening again to continue.');}},
    });
    session.recognizer.start();
    if(!current(session)||session.stopping)return;
    state.phase='listening';state.status='Listening · on-device AI';startClock();render();
    session.timer=setTimeout(()=>void stop(),30*60*1000);
  }catch(error){if(current(session))await abort(session,error.name==='NotAllowedError'?'Audio sharing was cancelled or blocked. Choose the YouTube tab and try again.':error.message||'Local speech recognition could not start.');}
}
function receive(event){
  if(event.type==='claim'){const claim=sanitizeClaim(event.claim);if(claim)state.claims=[...state.claims.filter(item=>item.id!==claim.id),claim].sort((a,b)=>a.atMs-b.atMs).slice(-150);}
  else if(event.type==='status')state.status=String(event.message||'').slice(0,400);
  render();
}
function releaseCapture(session){
  session.stream?.getTracks().forEach(track=>track.stop());session.stream=null;
  state.rms=0;
}
async function abort(session,message){
  if(!current(session))return;
  session.cancelled=true;clearTimeout(session.timer);clearTimeout(session.drainTimer);clearInterval(clock);
  releaseCapture(session);session.recognizer?.abort();session.checker?.close();active=null;
  makeUncertain();state.phase='error';state.error=message;state.status='Listening stopped';render();
}
async function stop(){
  if(prep){const item=prep;item.cancelled=true;item.controller.abort();prep=null;state.preparation=null;state.progress=null;state.phase='idle';state.status='Setup cancelled. Chrome may finish its model download in the background.';ready();render();void refreshAvailability();return;}
  demoCleanup?.();demoCleanup=null;clearInterval(clock);
  if(!active){state.status=state.phase==='demo'?'Demo paused · scripted example':'Stopped';render();return;}
  const session=active;if(session.stopping)return;
  session.stopping=true;clearTimeout(session.timer);state.phase='stopping';state.status='Audio stopped · finishing local checks';render();
  // SpeechRecognition.stop asks for final results. Ending tracks immediately releases capture.
  try{session.recognizer?.stop();}catch{}
  releaseCapture(session);
  if(!session.recognizer||session.recognitionEnded){void drain(session);return;}
  session.drainTimer=setTimeout(()=>void drain(session),3000);
}
async function drain(session){
  if(!current(session)||session.ending)return;
  session.ending=true;clearTimeout(session.drainTimer);session.recognizer?.abort();
  let timeout;
  try{await Promise.race([session.checker?.finish()||Promise.resolve(),new Promise(resolve=>{timeout=setTimeout(resolve,15000);})]);}
  catch{ /* A failed final check still releases capture and becomes uncertain. */ }
  finally{clearTimeout(timeout);}
  if(!current(session))return;
  session.cancelled=true;session.checker?.close();releaseCapture(session);active=null;makeUncertain();
  state.phase='idle';state.status=state.partial?'Stopped · unfinalized words remain provisional':'Stopped';render();
}
function demo(){
  if(active||prep)return;
  demoCleanup?.();clearResults();state.phase='demo';state.status='Scripted sample · not a live check';startClock();render();
  demoCleanup=startDemo(event=>{
    if(event.type==='transcript.delta'){
      const old=drafts.get(event.id)?.text||'';updateTranscript(state,{...event,text:old+event.text},drafts,false);
    }else if(event.type==='transcript.final')updateTranscript(state,event,drafts,true);
    else if(event.type==='claim')state.claims=[...state.claims.filter(claim=>claim.id!==event.claim.id),event.claim];
    render();
  },()=>{clearInterval(clock);state.status='Demo complete · prewritten NASA examples';render();});
}
async function closePanel(){await dispose();window.close();}
async function dispose(){
  disposed=true;availabilityEpoch++;clearTimeout(availabilityTimer);
  if(prep){prep.cancelled=true;prep.controller.abort();prep=null;}
  demoCleanup?.();clearInterval(clock);
  if(active){active.cancelled=true;clearTimeout(active.timer);clearTimeout(active.drainTimer);releaseCapture(active);active.recognizer?.abort();active.checker?.close();active=null;}
  baseModel?.destroy();baseModel=null;
}
chrome.runtime.onMessage.addListener(message=>{if(message.type==='proofline:stop-for-navigation'&&message.tabId===tabId&&active)void abort(active,'The YouTube page changed or closed. Start a new session for the new video.');});
window.addEventListener('pagehide',()=>void dispose());
