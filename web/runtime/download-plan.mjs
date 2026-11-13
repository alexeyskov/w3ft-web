import {BLOCK, blockCount} from './game-cache.mjs';

export const DOWNLOAD_PHASES = ['menu', 'multiplayer', 'match', 'campaign'];
export function filePhase(path) {
  const name=path.replaceAll('\\','/').toLowerCase();
  if (/campaign|webmedia\/|sound\/dialogue|\/cinematic/.test(name) || name.endsWith('.w3n')) return 'campaign';
  if (/multiplayer|battlenet|\/lan\b|\/chat\b/.test(name)) return 'multiplayer';
  if (/^(ui|font|fonts)\/|\.(dll|exe|ax|ttf|fdf|toc)$/.test(name)) return 'menu';
  return 'match';
}

// The generated plan contains MPQ byte ranges, not extracted game content.
// Changed files reject their old plan; every unclassified block is still
// downloaded, after the classified menu/multiplayer/match data.
export function downloadTasks(entries, plan, maxBlocks=4) {
  const valid=plan?.schemaVersion===1 && plan.blockSize===BLOCK && Array.isArray(plan.files);
  const recorded=new Map((valid?plan.files:[]).filter(file=>typeof file?.path==='string').map(file=>[file.path.toLowerCase(),file]));
  const phases=Object.fromEntries(DOWNLOAD_PHASES.map(name=>[name,[]]));
  for (const entry of entries) {
    const count=blockCount(entry.size), ranks=new Uint8Array(count);
    const saved=recorded.get(entry.label.toLowerCase());
    const archive=/\.mpq$/i.test(entry.label) && !/^(maps|campaigns)\//i.test(entry.label);
    ranks.fill(archive?3:DOWNLOAD_PHASES.indexOf(filePhase(entry.label)));
    if (saved?.version===entry.version && saved.size===entry.size) {
      for (let rank=3;rank>=0;rank--) for (const pair of Array.isArray(saved.phases?.[DOWNLOAD_PHASES[rank]])?saved.phases[DOWNLOAD_PHASES[rank]]:[]) {
        if (!Array.isArray(pair)||pair.length!==2) continue;
        const [first,last]=pair;
        if (Number.isInteger(first)&&Number.isInteger(last)&&0<=first&&first<=last&&last<count) ranks.fill(rank,first,last+1);
      }
    }
    for(let first=0;first<count;) {
      let last=first;
      while(last+1<count && last-first+1<maxBlocks && ranks[last+1]===ranks[first]) last++;
      const phase=DOWNLOAD_PHASES[ranks[first]];
      phases[phase].push({entry,first,last,phase}); first=last+1;
    }
  }
  return DOWNLOAD_PHASES.flatMap(phase=>phases[phase]);
}
