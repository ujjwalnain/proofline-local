export function updateTranscript(state, event, drafts, final = false) {
  if (typeof event.id !== 'string' || typeof event.text !== 'string') return;
  const segment = { id: event.id, text: event.text.slice(0, 20000), atMs: Number.isFinite(event.atMs) ? event.atMs : 0 };
  if (final) {
    drafts.delete(event.id);
    state.segments = [...state.segments.filter(item => item.id !== event.id), segment].sort((a,b) => a.atMs-b.atMs).slice(-300);
  } else if (!segment.text) drafts.delete(event.id);
  else if (!state.segments.some(item => item.id === event.id)) drafts.set(event.id, segment);
  state.partial = [...drafts.values()].sort((a,b)=>a.atMs-b.atMs).map(item=>item.text).join(' ');
}
export function sanitizeClaim(value) {
  if (!value || typeof value.id !== 'string' || typeof value.text !== 'string') return null;
  if (!['checking','supported','contradicted','context','uncertain'].includes(value.status)) return null;
  const sources=(Array.isArray(value.sources)?value.sources:[]).filter(source=>{
    try { const url=new URL(source.url);return url.protocol==='https:' && url.hostname==='en.wikipedia.org' && !url.username && !url.password && !url.port && typeof source.title==='string'; } catch {return false;}
  }).slice(0,4);
  const ungrounded=!sources.length&&['supported','contradicted','context'].includes(value.status);
  return {id:value.id,text:value.text.slice(0,2000),status:ungrounded?'uncertain':value.status,explanation:ungrounded?'No retrieved evidence was supplied for this assessment.':String(value.explanation||'').slice(0,6000),sources,atMs:Number.isFinite(value.atMs)?value.atMs:0};
}
