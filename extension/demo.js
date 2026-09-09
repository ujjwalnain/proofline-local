export const DEMO_CLAIMS = [
  { id: 'demo-1', text: 'Sunlight takes about eight minutes to reach Earth.', status: 'supported', explanation: 'Light takes roughly eight minutes to travel from the Sun to Earth. This is an appropriate approximation.', atMs: 1000, sources: [{ title: 'NASA · Facts About Earth', url: 'https://science.nasa.gov/earth/facts/' }] },
  { id: 'demo-2', text: 'Sound travels through empty space.', status: 'contradicted', explanation: 'Sound needs matter to carry vibrations. It cannot travel through a vacuum, although light and radio waves can.', atMs: 5500, sources: [{ title: 'NASA · Anatomy of an Electromagnetic Wave', url: 'https://science.nasa.gov/ems/02_anatomy/' }] },
  { id: 'demo-3', text: 'The Moon has no atmosphere.', status: 'context', explanation: 'The Moon has an extremely thin atmosphere called an exosphere. The absolute wording misses this distinction.', atMs: 10500, sources: [{ title: 'NASA · The Moon’s Atmosphere', url: 'https://science.nasa.gov/moon/lunar-atmosphere/' }] },
];
export function startDemo(onEvent, onComplete) {
  const timers = [];
  for (const claim of DEMO_CLAIMS) {
    const words = claim.text.match(/\S+\s*/g);
    words.forEach((word, index) => timers.push(setTimeout(() => onEvent({ type: 'transcript.delta', id: claim.id, text: word, atMs: claim.atMs }), claim.atMs + index * 110)));
    const end = claim.atMs + words.length * 110;
    timers.push(setTimeout(() => {
      onEvent({ type: 'transcript.final', id: claim.id, text: claim.text, atMs: claim.atMs });
      onEvent({ type: 'claim', claim: { ...claim, status: 'checking', explanation: '', sources: [] } });
    }, end));
    timers.push(setTimeout(() => onEvent({ type: 'claim', claim }), end + 700));
  }
  timers.push(setTimeout(onComplete, 14500));
  return () => timers.forEach(clearTimeout);
}
