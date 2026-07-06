import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_HTML_PATH = path.join(__dirname, '..', 'docs', 'index.html');
const RESULTS_PATH = path.join(__dirname, '..', 'docs', 'data', 'results.json');
const ESPN_SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard';

// Extrae M, TEAM_ALIASES, played y el bracket (BRACKET_ADVANCE + advanceBracket)
// directamente del HTML publicado, para no mantener una segunda copia del
// fixture que se desincroniza del que ve el usuario.
function loadAppData() {
  const src = readFileSync(APP_HTML_PATH, 'utf8');
  const grab = (re) => {
    const m = src.match(re);
    if (!m) throw new Error(`No se encontro el bloque: ${re}`);
    return m[0];
  };
  const code = [
    grab(/const M=\[[\s\S]*?\n\];/),
    grab(/const played=.*?;/),
    grab(/const TEAM_ALIASES=\{[\s\S]*?\n\};/),
    grab(/const BRACKET_ADVANCE=\[[\s\S]*?\n\];/),
    grab(/function advanceBracket\(\)\{[\s\S]*?\n\}/),
    'function normalizeTeam(v){return (v||"").toLowerCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g,"").replace(/[^a-z0-9]+/g,"");}',
    'function getEspnTeamName(n){return TEAM_ALIASES[n]||n;}',
    'module.exports={M,played,advanceBracket,normalizeTeam,getEspnTeamName};',
  ].join('\n');
  const module_ = { exports: {} };
  new Function('module', 'exports', code)(module_, module_.exports);
  return module_.exports;
}

function loadExistingResults() {
  if (!existsSync(RESULTS_PATH)) return {};
  try { return JSON.parse(readFileSync(RESULTS_PATH, 'utf8')); } catch { return {}; }
}

function applyStoredResults(M, played, stored) {
  M.forEach(x => {
    const s = stored[x.id];
    if (s && s.hr != null && s.ar != null) {
      x.hr = s.hr; x.ar = s.ar;
      if (s.win != null) x.win = s.win;
      if (s.hp != null) x.hp = s.hp;
      if (s.ap != null) x.ap = s.ap;
    }
  });
}

async function fetchEventsForDate(date) {
  const dParam = date.replace(/-/g, '');
  const res = await fetch(`${ESPN_SCOREBOARD_URL}?dates=${dParam}`, { cache: 'no-store' });
  if (!res.ok) return [];
  const data = await res.json();
  return data.events || [];
}

function findEspnMatch(events, homeName, awayName, normalizeTeam, getEspnTeamName) {
  const targetHome = normalizeTeam(getEspnTeamName(homeName));
  const targetAway = normalizeTeam(getEspnTeamName(awayName));
  return events.find(event => {
    const comp = event?.competitions?.[0];
    const teams = comp?.competitors || [];
    const home = teams.find(t => t.homeAway === 'home')?.team?.displayName || '';
    const away = teams.find(t => t.homeAway === 'away')?.team?.displayName || '';
    return normalizeTeam(home) === targetHome && normalizeTeam(away) === targetAway;
  });
}

async function main() {
  const { M, played, advanceBracket, normalizeTeam, getEspnTeamName } = loadAppData();
  const stored = loadExistingResults();
  applyStoredResults(M, played, stored);
  advanceBracket();

  const today = new Date().toISOString().slice(0, 10);
  const pending = M.filter(x => x.date <= today && !played(x) && x.h !== 'Por definir' && x.a !== 'Por definir');

  if (!pending.length) {
    console.log('Nada pendiente por sincronizar.');
    return;
  }

  const dates = [...new Set(pending.map(x => x.date))];
  const eventsByDate = {};
  for (const d of dates) {
    eventsByDate[d] = await fetchEventsForDate(d);
  }

  let changed = false;
  for (const x of pending) {
    const events = eventsByDate[x.date] || [];
    const match = findEspnMatch(events, x.h, x.a, normalizeTeam, getEspnTeamName);
    if (!match) continue;
    const comp = match.competitions?.[0];
    const state = comp?.status?.type?.state;
    if (state !== 'post') continue;
    const homeTeam = comp?.competitors?.find(c => c.homeAway === 'home');
    const awayTeam = comp?.competitors?.find(c => c.homeAway === 'away');
    const hr = homeTeam?.score != null ? Number(homeTeam.score) : null;
    const ar = awayTeam?.score != null ? Number(awayTeam.score) : null;
    if (hr == null || ar == null) continue;
    const win = homeTeam?.winner === true ? 'h' : (awayTeam?.winner === true ? 'a' : null);
    const hp = homeTeam?.shootoutScore != null ? Number(homeTeam.shootoutScore) : null;
    const ap = awayTeam?.shootoutScore != null ? Number(awayTeam.shootoutScore) : null;
    const prev = stored[x.id];
    const next = { hr, ar, win, hp, ap };
    if (!prev || prev.hr !== next.hr || prev.ar !== next.ar || prev.win !== next.win || prev.hp !== next.hp || prev.ap !== next.ap) {
      stored[x.id] = next;
      changed = true;
      console.log(`Resultado sincronizado: ${x.h} ${hr}-${ar} ${x.a} (id ${x.id})`);
    }
  }

  if (changed) {
    mkdirSync(path.dirname(RESULTS_PATH), { recursive: true });
    writeFileSync(RESULTS_PATH, JSON.stringify(stored, null, 2) + '\n');
    console.log('data/results.json actualizado.');
  } else {
    console.log('Sin cambios nuevos.');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
