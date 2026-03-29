require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY;
const FOOTBALL_API_BASE = 'https://v3.football.api-sports.io';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Saison dynamique : commence en août (mois >= 7)
function getCurrentSeason() {
  const now = new Date();
  return now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
}
const SEASON = getCurrentSeason();

// ── COMPARAISON SOUPLE DES NOMS JOUEURS ──────────────────
// Gère les variations : "A. Garnacho" vs "Alejandro Garnacho"
function nomMatch(nom1, nom2) {
  if (!nom1 || !nom2) return false;
  const n1 = nom1.toLowerCase().trim();
  const n2 = nom2.toLowerCase().trim();
  if (n1 === n2) return true;
  // Comparer le dernier mot (nom de famille)
  const parts1 = n1.split(' ');
  const parts2 = n2.split(' ');
  const lastName1 = parts1[parts1.length - 1];
  const lastName2 = parts2[parts2.length - 1];
  if (lastName1.length >= 4 && lastName1 === lastName2) return true;
  // L'un contient l'autre
  if (n1.includes(lastName2) || n2.includes(lastName1)) return true;
  return false;
}

function isInStarters(playerName, starters) {
  return starters.some(s => nomMatch(playerName, s));
}

function isInjuredPlayer(playerName, injuredNames) {
  return [...injuredNames].some(n => nomMatch(playerName, n));
}



// Saison spécifique par league — les qualifs CdM utilisent l'année du tournoi
const LEAGUE_SEASON_OVERRIDE = {
  32: 2024,  // Qualifs CdM UEFA — saison 2024 dans l'API
  35: 2026, 36: 2026, 30: 2026, 31: 2026, 33: 2026,
};
function getLeagueSeason(leagueId) {
  return LEAGUE_SEASON_OVERRIDE[leagueId] || SEASON;
}

// Essaye plusieurs saisons et retourne les fixtures de la première non-vide
// IDs alternatifs pour les confédérations (l'API a parfois des IDs différents)
const LEAGUE_ALT_IDS = {
  35: [35, 11],   // CONMEBOL — id 11 = qualifs Am. Sud dans certaines versions
  36: [36, 29],   // CAF
  30: [30, 26],   // AFC
  31: [31, 30],   // CONCACAF
};

async function getFixturesWithFallback(leagueId, date) {
  // Saisons à tester : override, puis 2024, 2025, 2026, saison courante
  const baseSeasons = LEAGUE_SEASON_OVERRIDE[leagueId]
    ? [LEAGUE_SEASON_OVERRIDE[leagueId], 2024, 2025, 2026]
    : [SEASON, SEASON - 1];
  const seasons = [...new Set(baseSeasons)];
  
  // IDs à tester pour cette league
  const ids = LEAGUE_ALT_IDS[leagueId] ? LEAGUE_ALT_IDS[leagueId] : [leagueId];

  for (const lid of ids) {
    for (const season of seasons) {
      const data = await footballAPI('/fixtures', { date, league: lid, season });
      if (data.length > 0) {
        console.log(`[Fixtures] League ${lid} (demandé: ${leagueId}) saison ${season}: ${data.length} matchs`);
        return data;
      }
    }
  }
  return [];
}

const LEAGUES = [
  { id: 61,  name: 'Ligue 1' },
  { id: 140, name: 'La Liga' },
  { id: 39,  name: 'Premier League' },
  { id: 135, name: 'Serie A' },
  { id: 78,  name: 'Bundesliga' },
  { id: 2,   name: 'Champions League' },
  { id: 3,   name: 'Europa League' },
  { id: 848, name: 'Conference League' },
  { id: 88,  name: 'Eredivisie' },
  { id: 94,  name: 'Liga Portugal' },
  // Qualifications Coupe du Monde 2026
  { id: 32,  name: 'Qualifs CdM UEFA' },
  { id: 35,  name: 'Qualifs CdM CONMEBOL' },
  { id: 36,  name: 'Qualifs CdM CAF' },
  { id: 30,  name: 'Qualifs CdM AFC' },
  { id: 31,  name: 'Qualifs CdM CONCACAF' },
  { id: 33,  name: 'Qualifs CdM OFC' },
];
const EURO_LEAGUES = [2, 3, 848];

// Ligues analysées pour les tirs — l'utilisateur adapte selon son bookmaker
const TIRS_LEAGUES = [
  { id: 61,  name: 'Ligue 1' },
  { id: 140, name: 'La Liga' },
  { id: 39,  name: 'Premier League' },
  { id: 135, name: 'Serie A' },
  { id: 78,  name: 'Bundesliga' },
  { id: 2,   name: 'Champions League' },
  { id: 3,   name: 'Europa League' },
  { id: 848, name: 'Conference League' },
  { id: 88,  name: 'Eredivisie' },
  { id: 94,  name: 'Liga Portugal' },
  { id: 32,  name: 'Qualifs CdM UEFA' },
  { id: 35,  name: 'Qualifs CdM CONMEBOL' },
  { id: 36,  name: 'Qualifs CdM CAF' },
  { id: 30,  name: 'Qualifs CdM AFC' },
  { id: 31,  name: 'Qualifs CdM CONCACAF' },
  { id: 33,  name: 'Qualifs CdM OFC' },
];

// ── CACHE ─────────────────────────────────────────────────
const cache = { standings: {}, teamStats: {}, players: {}, natLeagues: {}, fixtureStats: {}, predictions: {}, lastDate: null };
const CACHE_TTL = 6 * 60 * 60 * 1000;
function isCacheValid(e) { return e && Date.now() - e.timestamp < CACHE_TTL; }
function getTodayStr() { return new Date().toISOString().split('T')[0]; }

async function footballAPI(endpoint, params = {}) {
  await sleep(200);
  try {
    const res = await axios.get(`${FOOTBALL_API_BASE}${endpoint}`, {
      headers: { 'x-apisports-key': FOOTBALL_API_KEY },
      params,
    });
    return res.data?.response || [];
  } catch (e) { console.error('API error:', endpoint, e.message); return []; }
}

async function getStandingsCached(leagueId) {
  const k = `${leagueId}_${SEASON}`;
  if (isCacheValid(cache.standings[k])) return cache.standings[k].data;
  const s = await footballAPI('/standings', { league: leagueId, season: getLeagueSeason(leagueId) });
  const data = s[0]?.league?.standings?.[0] || [];
  cache.standings[k] = { data, timestamp: Date.now() };
  return data;
}

async function getTeamStatsCached(teamId, leagueId) {
  const k = `${teamId}_${leagueId}`;
  if (isCacheValid(cache.teamStats[k])) return cache.teamStats[k].data;
  const data = await footballAPI('/teams/statistics', { team: teamId, league: leagueId, season: getLeagueSeason(leagueId) });
  cache.teamStats[k] = { data, timestamp: Date.now() };
  return data;
}

async function getPlayersCached(teamId, leagueId) {
  const k = `${teamId}_${leagueId}`;
  if (isCacheValid(cache.players[k])) return cache.players[k].data;
  const p1 = await footballAPI('/players', { team: teamId, league: leagueId, season: getLeagueSeason(leagueId), page: 1 });
  const p2 = await footballAPI('/players', { team: teamId, league: leagueId, season: getLeagueSeason(leagueId), page: 2 });
  const data = [...p1, ...p2];
  cache.players[k] = { data, timestamp: Date.now() };
  return data;
}

// Récupère les stats avancées des 5 derniers matchs d'une équipe
// Retourne moyennes : possession, tirs cadrés, tirs totaux, attaques dangereuses
async function getAdvancedStatsCached(teamId, leagueId) {
  const k = `adv_${teamId}`; // toutes compétitions, pas par league
  if (isCacheValid(cache.fixtureStats[k])) return cache.fixtureStats[k].data;

  // /teams/statistics nécessite league + team + season
  // On essaie d'abord avec la league passée, puis les autres leagues connues si ça échoue
  // /teams/statistics ne retourne pas les tirs sur ce plan API
  // On utilise /fixtures avec last:10 puis /fixtures/statistics sur chaque match
  const lastFixtures = await footballAPI('/fixtures', {
    team: teamId, last: 10, status: 'FT',
  });

  if (!lastFixtures || lastFixtures.length === 0) {
    console.log(`[ADV] Team ${teamId} — aucun match récent trouvé`);
    cache.fixtureStats[k] = { data: null, timestamp: Date.now() };
    return null;
  }

  // Récupérer stats match par match séquentiellement pour éviter rate limit
  let totalShotsOn = 0, totalShotsTotal = 0, totalPossession = 0;
  let count = 0;
  const shotsOnList = [];

  for (const f of lastFixtures.slice(0, 8)) {
    const stats = await footballAPI('/fixtures/statistics', { fixture: f.fixture?.id });
    const teamStat = stats.find(s => s.team?.id === teamId);
    if (!teamStat) continue;

    const getStat = (type) => {
      const s = (teamStat.statistics || []).find(x => x.type === type);
      if (!s?.value && s?.value !== 0) return null;
      if (typeof s.value === 'string' && s.value.includes('%')) return parseFloat(s.value) || 0;
      return parseFloat(s.value) || 0;
    };

    const shotsOn    = getStat('Shots on Goal');
    const shotsTotal = getStat('Total Shots');
    const poss       = getStat('Ball Possession');

    // Ne compter que si on a au moins les tirs totaux
    if (shotsTotal === null) continue;

    totalShotsOn    += shotsOn    ?? 0;
    totalShotsTotal += shotsTotal ?? 0;
    totalPossession += poss       ?? 50;
    shotsOnList.push(shotsOn ?? 0);
    count++;
  }

  if (count === 0) {
    console.log(`[ADV] Team ${teamId} — stats tirs indisponibles sur ${lastFixtures.length} matchs`);
    cache.fixtureStats[k] = { data: null, timestamp: Date.now() };
    return null;
  }

  const avgShotsOn    = +(totalShotsOn    / count).toFixed(1);
  const avgShotsTotal = +(totalShotsTotal / count).toFixed(1);
  const avgPossession = Math.round(totalPossession / count);

  const variance = shotsOnList.reduce((a, v) => a + Math.pow(v - avgShotsOn, 2), 0) / count;
  const stdDev   = +Math.sqrt(variance).toFixed(2);

  console.log(`[ADV] Team ${teamId} — OK: ${avgShotsOn} cadrés/match, ${avgShotsTotal} totaux/match sur ${count} matchs`);

  const data = {
    possession:       avgPossession,
    shotsOnTarget:    avgShotsOn,
    shotsTotal:       avgShotsTotal,
    dangerousAttacks: 0,
    shotsOnList:      [],
    stdDev,
  };

  cache.fixtureStats[k] = { data, timestamp: Date.now() };
  return data;
}

// Prédiction de l'API (pourcentage de victoire domicile/extérieur/nul)
async function getPredictionCached(fixtureId) {
  const k = `pred_${fixtureId}`;
  if (isCacheValid(cache.predictions[k])) return cache.predictions[k].data;
  const data = await footballAPI('/predictions', { fixture: fixtureId });
  const pred = data[0]?.predictions || null;
  cache.predictions[k] = { data: pred, timestamp: Date.now() };
  return pred;
}


async function preloadCache() {
  const today = getTodayStr();
  if (cache.lastDate === today) return;
  console.log('Preload cache...');
  await Promise.all(LEAGUES.map(l => getStandingsCached(l.id)));
  const fixtures = [];
  for (const league of LEAGUES) {
    const data = await footballAPI('/fixtures', { date: today, league: league.id, season: getLeagueSeason(league.id) });
    fixtures.push(...data.map(f => ({ ...f, leagueId: league.id })));
  }
  const seen = new Set();
  const pairs = [];
  for (const f of fixtures) {
    for (const t of [f.teams?.home, f.teams?.away]) {
      if (!t) continue;
      const k = `${t.id}_${f.leagueId}`;
      if (!seen.has(k)) { seen.add(k); pairs.push({ teamId: t.id, leagueId: f.leagueId }); }
    }
  }
  for (let i = 0; i < pairs.length; i += 5) {
    await Promise.all(pairs.slice(i, i+5).map(p => Promise.all([
      getTeamStatsCached(p.teamId, p.leagueId),
      getPlayersCached(p.teamId, p.leagueId),
      // getAdvancedStatsCached retiré du preload — trop d'appels API séquentiels
    ])));
  }

  // Précharger les prédictions pour tous les matchs du jour
  const fixtureIds = [...new Set(fixtures.map(f => f.fixture?.id).filter(Boolean))];
  for (let i = 0; i < fixtureIds.length; i += 5) {
    await Promise.all(fixtureIds.slice(i, i+5).map(id => getPredictionCached(id)));
  }
  cache.lastDate = today;
  console.log(`Cache OK — ${pairs.length} equipes`);
}

// ── MATRICE V4 — ANALYSE VICTOIRE ÉQUIPE ────────────────
// 14 facteurs calibrés pour prédire la victoire, pas le joueur décisif
function analyseMatchComplet(hStats, aStats, hStand, aStand, h2h, injuries, isEuropean, hPlayers, aPlayers, composH, composA, hAdvStats, aAdvStats, prediction, hFatigued, aFatigued, firstLegScore) {

  // ── DONNÉES DE BASE ───────────────────────────────────
  const hRank = hStand?.rank  || 99;
  const aRank = aStand?.rank  || 99;
  const hPts  = hStand?.points || 0;
  const aPts  = aStand?.points || 0;
  const hForm = (hStand?.form || '').slice(-5);
  const aForm = (aStand?.form || '').slice(-5);
  const hWins = (hForm.match(/W/g) || []).length;
  const aWins = (aForm.match(/W/g) || []).length;
  const hLoss = (hForm.match(/L/g) || []).length;
  const aLoss = (aForm.match(/L/g) || []).length;
  const hDraws = (hForm.match(/D/g) || []).length;

  // Stats offensives et défensives
  const hGoalsForHome     = parseFloat(hStats?.goals?.for?.average?.home)     || 0;
  const hGoalsAgainstHome = parseFloat(hStats?.goals?.against?.average?.home)  || 0;
  const aGoalsForAway     = parseFloat(aStats?.goals?.for?.average?.away)      || 0;
  const aGoalsAgainstAway = parseFloat(aStats?.goals?.against?.average?.away)  || 0;

  // Clean sheets (approximation via buts encaissés)
  const hCleanSheetRate = hGoalsAgainstHome < 0.8 ? 'high' : hGoalsAgainstHome < 1.2 ? 'mid' : 'low';
  const aCleanSheetRate = aGoalsAgainstAway < 0.8 ? 'high' : aGoalsAgainstAway < 1.2 ? 'mid' : 'low';

  // H2H sur les 5 derniers
  const h2hSlice = (h2h || []).slice(0, 5);
  const h2hHomeWins = h2hSlice.filter(m => (m.goals?.home||0) > (m.goals?.away||0)).length;
  const h2hAwayWins = h2hSlice.filter(m => (m.goals?.away||0) > (m.goals?.home||0)).length;
  const h2hDraws    = h2hSlice.filter(m => (m.goals?.home||0) === (m.goals?.away||0)).length;

  // ── SCORE POUR CHAQUE ÉQUIPE ──────────────────────────
  let hScore = 0;
  let aScore = 0;
  const factors = [];

  // F1 — ÉCART DE CLASSEMENT (max 35pts)
  const rankDiff = aRank - hRank;
  if      (rankDiff >= 15) { hScore += 35; factors.push('F1'); }
  else if (rankDiff >= 10) { hScore += 25; factors.push('F1'); }
  else if (rankDiff >= 6)  { hScore += 16; factors.push('F1'); }
  else if (rankDiff >= 3)  { hScore += 8; }
  else if (rankDiff <= -15){ aScore += 35; factors.push('F1'); }
  else if (rankDiff <= -10){ aScore += 25; factors.push('F1'); }
  else if (rankDiff <= -6) { aScore += 16; factors.push('F1'); }
  else if (rankDiff <= -3) { aScore += 8; }

  // F2 — AVANTAGE DOMICILE (fixe +8, réduit si équipe extérieure très forte)
  const homeBonus = (aRank < hRank - 5) ? 4 : 8; // réduit si visiteur nettement meilleur
  hScore += homeBonus;

  // F3 — ÉCART DE POINTS (max 18pts)
  const ptsDiff = hPts - aPts;
  if      (ptsDiff >= 25) { hScore += 18; factors.push('F14'); }
  else if (ptsDiff >= 15) { hScore += 13; factors.push('F14'); }
  else if (ptsDiff >= 8)  { hScore += 7; factors.push('F14'); }
  else if (ptsDiff >= 4)  { hScore += 3; }
  else if (ptsDiff <= -15){ aScore += 13; factors.push('F14'); }
  else if (ptsDiff <= -8) { aScore += 7; factors.push('F14'); }
  else if (ptsDiff <= -4) { aScore += 3; }

  // F4 — FORME RÉCENTE 5 MATCHS (max 18pts)
  if      (hWins >= 5) { hScore += 18; factors.push('F12'); }
  else if (hWins >= 4) { hScore += 13; factors.push('F12'); }
  else if (hWins >= 3) { hScore += 8; factors.push('F12'); }
  else if (hLoss >= 4) { hScore -= 12; }
  else if (hLoss >= 3) { hScore -= 7; }

  if      (aWins >= 5) { aScore += 15; factors.push('F12'); }
  else if (aWins >= 4) { aScore += 11; factors.push('F12'); }
  else if (aWins >= 3) { aScore += 7; }
  else if (aLoss >= 4) { aScore -= 12; }
  else if (aLoss >= 3) { aScore -= 7; }

  // F5 — DÉFENSE ADVERSE EN DÉPLACEMENT (max 15pts)
  if      (aGoalsAgainstAway >= 2.5) { hScore += 15; factors.push('F5'); }
  else if (aGoalsAgainstAway >= 2.0) { hScore += 11; factors.push('F5'); }
  else if (aGoalsAgainstAway >= 1.5) { hScore += 6; factors.push('F5'); }
  else if (aGoalsAgainstAway <= 0.8) { aScore += 8; } // défense solide en déplacement

  if      (hGoalsAgainstHome >= 2.5) { aScore += 12; factors.push('F5'); }
  else if (hGoalsAgainstHome >= 2.0) { aScore += 8; }
  else if (hGoalsAgainstHome <= 0.8) { hScore += 8; } // défense solide à domicile

  // F6 — PUISSANCE OFFENSIVE (max 12pts)
  if      (hGoalsForHome >= 2.5) { hScore += 12; factors.push('F6'); }
  else if (hGoalsForHome >= 2.0) { hScore += 8; factors.push('F6'); }
  else if (hGoalsForHome >= 1.5) { hScore += 4; }

  if      (aGoalsForAway >= 2.5) { aScore += 10; factors.push('F6'); }
  else if (aGoalsForAway >= 2.0) { aScore += 7; }
  else if (aGoalsForAway >= 1.5) { aScore += 3; }

  // F7 — H2H HISTORIQUE (max 12pts)
  if      (h2hHomeWins >= 4) { hScore += 12; factors.push('F9'); }
  else if (h2hHomeWins >= 3) { hScore += 7; factors.push('F9'); }
  else if (h2hHomeWins >= 2) { hScore += 3; }
  if      (h2hAwayWins >= 4) { aScore += 12; factors.push('F9'); }
  else if (h2hAwayWins >= 3) { aScore += 7; factors.push('F9'); }
  else if (h2hAwayWins >= 2) { aScore += 3; }
  // H2H équilibré = signal de nul, réduit les deux scores
  if (h2hDraws >= 3) { hScore -= 5; aScore -= 5; }

  // F8 — ADVERSAIRE SANS VICTOIRE RÉCENTE (série négative)
  if (aLoss >= 4 || (aLoss >= 3 && hWins >= 3)) { hScore += 10; factors.push('F8'); }
  if (hLoss >= 4 || (hLoss >= 3 && aWins >= 3)) { aScore += 10; factors.push('F8'); }

  // MALUS ÉQUIPES QUI FONT SOUVENT NUL
  // Un nul = mauvais pour un prono victoire
  if (hDraws >= 3) { hScore -= 10; } // domicile nulise souvent → pick victoire risqué
  if ((aForm.match(/D/g) || []).length >= 3) { aScore -= 10; }

  // F9 — POSITION AU CLASSEMENT (top équipe = bonus)
  if      (hRank <= 2)  { hScore += 12; factors.push('F2'); }
  else if (hRank <= 5)  { hScore += 7; factors.push('F2'); }
  else if (hRank <= 8)  { hScore += 3; }
  if      (aRank <= 2)  { aScore += 10; }
  else if (aRank <= 5)  { aScore += 6; }

  // F10 — ADVERSAIRE EN ZONE RELÉGATION (max 12pts)
  if      (aRank >= 18) { hScore += 12; factors.push('F11'); }
  else if (aRank >= 16) { hScore += 8; factors.push('F11'); }
  else if (aRank >= 14) { hScore += 4; }
  if      (hRank >= 18) { aScore += 10; factors.push('F11'); }
  else if (hRank >= 16) { aScore += 7; }

  // F11 — CLEAN SHEETS (solidité défensive)
  if (hCleanSheetRate === 'high') { hScore += 8; factors.push('F13'); }
  if (aCleanSheetRate === 'low')  { hScore += 5; }
  if (aCleanSheetRate === 'high') { aScore += 8; factors.push('F13'); }
  if (hCleanSheetRate === 'low')  { aScore += 5; }

  // F12 — ENJEU EUROPÉEN
  if (isEuropean) { factors.push('F7'); }

  // ── STATS AVANCÉES (possession, tirs cadrés, attaques dangereuses) ──
  if (hAdvStats) {
    // Possession domicile moyenne
    if (hAdvStats.possession >= 58)      { hScore += 8; factors.push('F13'); }
    else if (hAdvStats.possession >= 52) { hScore += 4; }
    else if (hAdvStats.possession <= 42) { hScore -= 4; }

    // Tirs cadrés domicile (dangerosité offensive)
    if (hAdvStats.shotsOnTarget >= 6)    { hScore += 10; factors.push('F6'); }
    else if (hAdvStats.shotsOnTarget >= 4.5) { hScore += 6; }
    else if (hAdvStats.shotsOnTarget <= 2.5) { hScore -= 5; }

    // Attaques dangereuses
    if (hAdvStats.dangerousAttacks >= 120) { hScore += 6; }
    else if (hAdvStats.dangerousAttacks >= 90)  { hScore += 3; }
  }

  if (aAdvStats) {
    // Possession équipe extérieure
    if (aAdvStats.possession >= 58)      { aScore += 7; factors.push('F13'); }
    else if (aAdvStats.possession >= 52) { aScore += 3; }
    else if (aAdvStats.possession <= 42) { aScore -= 4; }

    // Tirs cadrés extérieur
    if (aAdvStats.shotsOnTarget >= 6)    { aScore += 8; factors.push('F6'); }
    else if (aAdvStats.shotsOnTarget >= 4.5) { aScore += 5; }
    else if (aAdvStats.shotsOnTarget <= 2.5) { aScore -= 5; }
  }

  // ── PRÉDICTION API (pourcentage victoire) ──────────────
  if (prediction) {
    const pctHome = parseFloat(prediction.percent?.home?.replace('%','')) || 0;
    const pctAway = parseFloat(prediction.percent?.away?.replace('%','')) || 0;
    // Bonus si la prédiction API confirme notre analyse
    // Bonus réduit pour éviter double comptage avec F1/F3/F4 (classement/points/forme)
    if (pctHome >= 65)      { hScore += 6; factors.push('F8'); }
    else if (pctHome >= 55) { hScore += 3; }
    if (pctAway >= 65)      { aScore += 6; factors.push('F8'); }
    else if (pctAway >= 55) { aScore += 3; }
    // Confirmation forte : prédiction et notre analyse convergent
    if (pctHome >= 60 && pctAway <= 25) { hScore += 5; }
    if (pctAway >= 60 && pctHome <= 25) { aScore += 5; }
  }

  // ── IMPACT SCORE MATCH ALLER (matchs européens retour) ──
  if (isEuropean && firstLegScore) {
    const hGoalsAller = firstLegScore.hGoals; // buts marqués par l'équipe domicile au match aller
    const aGoalsAller = firstLegScore.aGoals; // buts marqués par l'équipe extérieure au match aller
    const diffAller = hGoalsAller - aGoalsAller; // positif = domicile menait à l'aller

    // L'équipe qui menait à l'aller est dans une position favorable au retour
    if (diffAller >= 3) {
      // Ex: Bodo mène 3-0 → l'équipe extérieure (Bodo) est grandement favorisée
      aScore += 35; hScore -= 20;
      factors.push('F7');
    } else if (diffAller >= 2) {
      aScore += 22; hScore -= 12;
      factors.push('F7');
    } else if (diffAller >= 1) {
      aScore += 10; hScore -= 5;
    } else if (diffAller <= -2) {
      // Domicile menait à l'aller de 2+ → position favorable
      hScore += 18; aScore -= 10;
      factors.push('F7');
    } else if (diffAller <= -1) {
      hScore += 8; aScore -= 5;
    }
    // diffAller = 0 → match aller nul → aucun avantage
  }

  // ── MALUS FATIGUE ────────────────────────────────────────
  // Equipe qui joue jeudi Europe + dimanche championnat = baisse de forme
  if (hFatigued) {
    hScore -= 15;
    factors.push('F10');
    console.log('Fatigue détectée domicile');
  }
  if (aFatigued) {
    aScore -= 12;
    factors.push('F10');
  }

  // ── MALUS DERBY/CLASICO ───────────────────────────────
  if (h2hDraws >= 2 && Math.abs(rankDiff) <= 8) {
    hScore -= 8; aScore -= 8;
  }

  // ── IMPACT BLESSÉS CLÉS ───────────────────────────────
  const injuredIds   = new Set((injuries || []).map(i => i.player?.id).filter(Boolean));
  const injuredNames = new Set((injuries || []).map(i => (i.player?.name||'').toLowerCase()));

  const getKeyPlayersMissing = (players, starters) => {
    const offPlayers = players.filter(p => {
      const pos = (p.statistics?.[0]?.games?.position || p.player?.position || '');
      return pos === 'F' || pos === 'Forward' || pos === 'Attacker' || pos === 'M' || pos === 'Midfielder';
    });
    const topScorers = offPlayers
      .map(p => ({ name: p.player?.name, goals: p.statistics?.[0]?.goals?.total || 0, id: p.player?.id }))
      .sort((a, b) => b.goals - a.goals)
      .slice(0, 3);

    let missing = 0;
    const missingNames = [];
    for (const scorer of topScorers) {
      const isInjured = injuredIds.has(scorer.id) || isInjuredPlayer(scorer.name||'', injuredNames);
      const notInCompo = starters.length > 0 && !isInStarters(scorer.name||'', starters);
      if (isInjured || notInCompo) { missing++; missingNames.push(scorer.name); }
    }
    return { missing, missingNames };
  };

  const hMissing = getKeyPlayersMissing(hPlayers, composH);
  const aMissing = getKeyPlayersMissing(aPlayers, composA);

  // Malus blessés — proportionnel à l'importance des joueurs
  if      (hMissing.missing >= 3) { hScore -= 25; }
  else if (hMissing.missing === 2) { hScore -= 16; }
  else if (hMissing.missing === 1) { hScore -= 8; }

  if      (aMissing.missing >= 3) { aScore -= 20; }
  else if (aMissing.missing === 2) { aScore -= 13; }
  else if (aMissing.missing === 1) { aScore -= 6; }

  // ── DÉTERMINER LE FAVORI ──────────────────────────────
  const diff    = hScore - aScore;
  const absDiff = Math.abs(diff);
  const uniqueFactors = [...new Set(factors)];

  let favoriIsHome = null;
  let scoreMatriciel = 0;
  let alerte = null;
  let pronosType = null;

  // Filtre rang minimum — écart de classement insuffisant = match trop équilibré
  const absRankDiff = Math.abs(rankDiff);

  // Règle 1 : écart < 5 rangs = toujours trop serré
  // Règle 2 : deux équipes dans le top 8 = écart minimum de 7 rangs requis
  const bothTopEight = hRank <= 8 && aRank <= 8;
  const minRankDiff = bothTopEight ? 7 : 5;

  if (absRankDiff < minRankDiff) {
    return {
      scoreMatriciel: 0, scoreSort: 0, factors: uniqueFactors,
      alerte: null, coteEstimee: null, favoriIsHome: null,
      pronosType: 'equilibre', hScore, aScore,
      hMissing: { missing: 0, missingNames: [] },
      aMissing: { missing: 0, missingNames: [] },
      hRank, aRank, hPts, aPts, hForm, aForm, hWins, aWins,
    };
  }

  // Seuil minimum — diff < 25 = trop équilibré (monté de 18 à 25)
  if (absDiff < 25) {
    pronosType = 'equilibre';
    scoreMatriciel = 0;
  } else if (diff >= 25) {
    favoriIsHome = true;
    pronosType = 'victoire_domicile';
    scoreMatriciel = Math.min(100, Math.round(absDiff * 1.15));
  } else {
    favoriIsHome = false;
    pronosType = 'victoire_exterieur';
    scoreMatriciel = Math.min(100, Math.round(absDiff * 0.95));
  }

  if      (scoreMatriciel >= 72) alerte = 'VERT';
  else if (scoreMatriciel >= 52) alerte = 'ORANGE';
  else if (scoreMatriciel >= 38) alerte = 'ROUGE';

  // Cote estimée basée sur l'écart de rang réel — plus réaliste
  let coteEstimee = null;
  const rankGap = Math.abs(rankDiff); // écart de classement
  if (pronosType === 'victoire_domicile') {
    if      (rankGap >= 14) coteEstimee = 1.20; // énorme favori
    else if (rankGap >= 10) coteEstimee = 1.40;
    else if (rankGap >= 7)  coteEstimee = 1.60;
    else if (rankGap >= 5)  coteEstimee = 1.85;
    else                    coteEstimee = 2.10;
  } else if (pronosType === 'victoire_exterieur') {
    if      (rankGap >= 14) coteEstimee = 1.50;
    else if (rankGap >= 10) coteEstimee = 1.80;
    else if (rankGap >= 7)  coteEstimee = 2.10;
    else if (rankGap >= 5)  coteEstimee = 2.40;
    else                    coteEstimee = 2.80;
  }

  // Pas de filtre sur la cote — c'est l'utilisateur qui décide si la cote vaut le coup

  return {
    scoreMatriciel,
    scoreSort: scoreMatriciel,
    factors: uniqueFactors,
    alerte,
    coteEstimee,
    favoriIsHome,
    pronosType,
    hScore, aScore,
    hMissing, aMissing,
    hRank, aRank, hPts, aPts, hForm, aForm,
    hWins, aWins,
  };
}

// ── CLAUDE : RÉDIGE L'ANALYSE + JOUEUR DÉCISIF ───────────
async function genererAnalyse(matchInfo, favoriPlayers, context) {
  const favori = matchInfo.favoriNom;
  const adversaire = matchInfo.adversaireNom;

  const playerList = favoriPlayers.slice(0, 8).map(p => {
    const s = p.statistics?.[0];
    const goals = s?.goals?.total || 0;
    const assists = s?.goals?.assists || 0;
    const apps = s?.games?.appearences || 1;
    const pos = s?.games?.position || p.player?.position || '?';
    const ratio = apps > 0 ? (goals/apps).toFixed(2) : '0';
    return `  - ${p.player?.name} | ${pos} | ${goals}B ${assists}PD en ${apps}M (ratio ${ratio})`;
  }).join('\n') || '  (données non disponibles)';

  const missingStr = matchInfo.hMissing?.missingNames?.length > 0
    ? `⚠️ Absents ${favori}: ${matchInfo.hMissing.missingNames.join(', ')}`
    : '✅ Pas d\'absents majeurs détectés';

  const prompt = `Expert football. Justifie le pronostic avec des données concrètes.

MATCH: ${matchInfo.match} | ${matchInfo.competition} | ${matchInfo.heure}
PRONOSTIC: Victoire ${favori} (score fiabilité: ${matchInfo.scoreMatriciel}/100)
${favori}: rang ${matchInfo.favoriRang}e (${matchInfo.favoriPts}pts, forme:${matchInfo.favoriForm})
${adversaire}: rang ${matchInfo.adversaireRang}e (${matchInfo.adversairePts}pts, forme:${matchInfo.adversaireForm})
${missingStr}
CONTEXTE COMPLET: ${context}

JOUEURS OFFENSIFS DE ${favori} (triés par ratio buts/match):
${playerList}

RÈGLES STRICTES:
1. 2 phrases MAX justifiant la victoire — cite des stats concrètes du contexte
2. Joueur décisif: choisis l'ATTAQUANT ou AILIER avec le meilleur ratio
3. ❌ JAMAIS blessé/suspendu/parti du club (Lacazette a quitté Lyon, Mbappé au Real = EXCLUS)
4. ❌ JAMAIS milieu défensif (Rodri, Casemiro etc)
5. ❌ VÉRIFIE que le joueur joue ENCORE dans ce club en ${new Date().toLocaleDateString('fr-FR', {month:'long', year:'numeric'})} avant de le choisir
6. Si ratio API faible mais joueur connu prolifique → utilise tes connaissances réelles

JSON UNIQUEMENT:
{"raison":"2 phrases pourquoi victoire avec stats","joueur_decisif":{"joueur":"Prénom Nom","type":"Joueur décisif","prob":72,"cote_estimee":1.75,"raison":"1 phrase avec stat concrète"}}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = response.content[0].text;
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    return null;
  } catch (e) { console.error('Claude error:', e.message); return null; }
}

// ── FILTRER JOUEURS OFFENSIFS ─────────────────────────────
function filtrerOffensifs(players, injuries, starters) {
  const injuredNames = new Set((injuries || []).map(i => (i.player?.name||'').toLowerCase()));

  let filtered = players.filter(p => {
    const pos = (p.statistics?.[0]?.games?.position || p.player?.position || '').trim();
    const name = (p.player?.name || '').toLowerCase();
    if (pos === 'G' || pos === 'Goalkeeper') return false;
    if (pos === 'D' || pos === 'Defender') return false;
    if (isInjuredPlayer(name, injuredNames)) return false;
    return true;
  });

  if (starters.length > 0) {
    filtered = filtered.filter(p => isInStarters(p.player?.name || '', starters));
  }

  return filtered.map(p => {
    const pos = (p.statistics?.[0]?.games?.position || p.player?.position || '').trim();
    const priority = (pos === 'F' || pos === 'Forward' || pos === 'Attacker') ? 3
      : (pos === 'M' || pos === 'Midfielder') ? 2 : 1;
    return { ...p, _priority: priority };
  }).sort((a, b) => b._priority - a._priority);
}

// ── COLLECTE DONNÉES MATCH ────────────────────────────────
async function collectMatchData(fixture, leagueId, leagueName, standings) {
  const hTeam = fixture.teams?.home;
  const aTeam = fixture.teams?.away;
  const fixtureId = fixture.fixture?.id;
  if (!hTeam || !aTeam) return null;

  const hTime = fixture.fixture?.date
    ? new Date(fixture.fixture.date).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    : '?';
  const isEuropean = EURO_LEAGUES.includes(leagueId);

  const [hStats, aStats, hPlayers, aPlayers, injuries, h2h, lineups, hAdvStats, aAdvStats, prediction, hRecentFixtures, aRecentFixtures] = await Promise.all([
    getTeamStatsCached(hTeam.id, leagueId),
    getTeamStatsCached(aTeam.id, leagueId),
    getPlayersCached(hTeam.id, leagueId),
    getPlayersCached(aTeam.id, leagueId),
    footballAPI('/injuries', { fixture: fixtureId }),
    footballAPI('/fixtures/headtohead', { h2h: `${hTeam.id}-${aTeam.id}`, last: 5 }),
    footballAPI('/fixtures/lineups', { fixture: fixtureId }),
    getAdvancedStatsCached(hTeam.id, leagueId),
    getAdvancedStatsCached(aTeam.id, leagueId),
    getPredictionCached(fixtureId),
    footballAPI('/fixtures', { team: hTeam.id, last: 3, status: 'FT' }), // 3 derniers matchs domicile
    footballAPI('/fixtures', { team: aTeam.id, last: 3, status: 'FT' }), // 3 derniers matchs extérieur
  ]);

  // Détecter fatigue : match joué dans les 4 derniers jours ?
  const matchDate = new Date(fixture.fixture?.date || Date.now());
  const fatigueSeuil = 4 * 24 * 60 * 60 * 1000; // 4 jours en ms

  const hasFatigue = (recentFixtures) => {
    if (!recentFixtures || recentFixtures.length === 0) return false;
    const lastMatch = recentFixtures[0];
    const lastDate = new Date(lastMatch.fixture?.date || 0);
    return (matchDate - lastDate) < fatigueSeuil;
  };

  const hFatigued = hasFatigue(hRecentFixtures);
  const aFatigued = hasFatigue(aRecentFixtures);

  // Pour les matchs européens, récupérer le score du match aller
  let firstLegScore = null;
  if (isEuropean) {
    const round = fixture.league?.round || '';
    // Chercher le match aller entre les mêmes équipes dans cette compétition
    const firstLegFixtures = await footballAPI('/fixtures', {
      league: leagueId, season: SEASON,
      team: hTeam.id, status: 'FT', last: 20,
    });
    // Trouver le match aller : même équipes, résultat connu, avant ce match
    const firstLeg = firstLegFixtures.find(f => {
      const isVsAway = (f.teams?.home?.id === aTeam.id && f.teams?.away?.id === hTeam.id) ||
                       (f.teams?.home?.id === hTeam.id && f.teams?.away?.id === aTeam.id);
      const isBefore = new Date(f.fixture?.date) < matchDate;
      const isCompleted = f.fixture?.status?.short === 'FT';
      return isVsAway && isBefore && isCompleted;
    });

    if (firstLeg) {
      const hWasHome = firstLeg.teams?.home?.id === hTeam.id;
      firstLegScore = {
        hGoals: hWasHome ? (firstLeg.goals?.home ?? 0) : (firstLeg.goals?.away ?? 0),
        aGoals: hWasHome ? (firstLeg.goals?.away ?? 0) : (firstLeg.goals?.home ?? 0),
      };
      console.log(`[ALLER] ${hTeam.name} vs ${aTeam.name} — aller trouvé: ${firstLegScore.hGoals}-${firstLegScore.aGoals}`);
    } else {
      console.log(`[ALLER] ${hTeam.name} vs ${aTeam.name} — aucun match aller trouvé sur ${firstLegFixtures.length} fixtures`);
    }
  }

  const hLineup = lineups.find(l => l.team?.id === hTeam.id);
  const aLineup = lineups.find(l => l.team?.id === aTeam.id);
  const hStarters = (hLineup?.startXI || []).map(p => p.player?.name?.toLowerCase()).filter(Boolean);
  const aStarters = (aLineup?.startXI || []).map(p => p.player?.name?.toLowerCase()).filter(Boolean);
  const composAvailable = hStarters.length > 0 || aStarters.length > 0;

  const hStand = standings.find(s => s.team?.id === hTeam.id);
  const aStand = standings.find(s => s.team?.id === aTeam.id);

  const analyse = analyseMatchComplet(
    hStats, aStats, hStand, aStand, h2h, injuries, isEuropean,
    hPlayers, aPlayers, hStarters, aStarters,
    hAdvStats, aAdvStats, prediction,
    hFatigued, aFatigued, firstLegScore
  );

  if (!analyse.alerte) return null; // match trop équilibré ou score trop bas

  // Déterminer favori et ses joueurs offensifs
  const favoriIsHome = analyse.favoriIsHome;
  const favoriTeam  = favoriIsHome ? hTeam : aTeam;
  const favoriStand = favoriIsHome ? hStand : aStand;
  const adversStand = favoriIsHome ? aStand : hStand;
  const favoriPlayers = favoriIsHome
    ? filtrerOffensifs(hPlayers, injuries, hStarters)
    : filtrerOffensifs(aPlayers, injuries, aStarters);

  const favoriRang = favoriIsHome ? analyse.hRank : analyse.aRank;
  const adversaireRang = favoriIsHome ? analyse.aRank : analyse.hRank;
  const favoriPts  = favoriIsHome ? analyse.hPts : analyse.aPts;
  const adversairePts = favoriIsHome ? analyse.aPts : analyse.hPts;
  const favoriForm = favoriIsHome ? analyse.hForm : analyse.aForm;
  const adversaireForm = favoriIsHome ? analyse.aForm : analyse.hForm;

  const blessesStr = injuries.slice(0, 4).map(i => i.player?.name).join(', ') || 'Aucun';
  const h2hStr = h2h.slice(0, 3).map(m => `${m.teams?.home?.name} ${m.goals?.home}-${m.goals?.away} ${m.teams?.away?.name}`).join(' | ') || '-';
  const hAdvStr = hAdvStats
    ? `Possession moy:${hAdvStats.possession}%, Tirs cadrés/match:${hAdvStats.shotsOnTarget}`
    : '';
  const aAdvStr = aAdvStats
    ? `Possession moy:${aAdvStats.possession}%, Tirs cadrés/match:${aAdvStats.shotsOnTarget}`
    : '';
  const predStr = prediction
    ? `Prédiction API: ${hTeam.name} ${prediction.percent?.home||'?'} / Nul ${prediction.percent?.draw||'?'} / ${aTeam.name} ${prediction.percent?.away||'?'}`
    : '';

  const firstLegStr = firstLegScore
    ? `Match aller: ${hTeam.name} ${firstLegScore.hGoals}-${firstLegScore.aGoals} ${aTeam.name}.`
    : '';

  const context = `${hTeam.name} ${analyse.hRank}e (${analyse.hPts}pts, forme:${analyse.hForm}${hAdvStr ? ', ' + hAdvStr : ''}) vs ${aTeam.name} ${analyse.aRank}e (${analyse.aPts}pts, forme:${analyse.aForm}${aAdvStr ? ', ' + aAdvStr : ''}). ${firstLegStr} H2H: ${h2hStr}. ${predStr} Blessés: ${blessesStr}`;

  return {
    match: `${hTeam.name} vs ${aTeam.name}`,
    competition: leagueName,
    heure: hTime,
    favoriNom: favoriTeam.name,
    adversaireNom: favoriIsHome ? aTeam.name : hTeam.name,
    favoriRang, adversaireRang, favoriPts, adversairePts, favoriForm, adversaireForm,
    pronosType: analyse.pronosType,
    scoreMatriciel: analyse.scoreMatriciel,
    scoreSort: analyse.scoreSort,
    score_total: analyse.scoreMatriciel,
    factors: analyse.factors,
    alerte: analyse.alerte,
    coteEstimee: analyse.coteEstimee,
    hMissing: analyse.hMissing,
    aMissing: analyse.aMissing,
    favoriPlayers,
    composAvailable,
    context,
    domicile: hTeam.name,
    exterieur: aTeam.name,
  };
}

// ── SCAN ──────────────────────────────────────────────────
app.get('/api/scan', async (req, res) => {
  try {
    const today = getTodayStr();
    await preloadCache();

    const allFixtures = [];
    for (const league of LEAGUES) {
      const data = await getFixturesWithFallback(league.id, today);
      // Exclure matchs reportés, annulés, abandonnés, suspendus
      const validFixtures = data.filter(f => {
        const status = f.fixture?.status?.short;
        return !['PST','CANC','ABD','SUSP','AWD','WO'].includes(status);
      });
      if (validFixtures.length > 0) allFixtures.push(...validFixtures.map(f => ({ ...f, leagueName: league.name, leagueId: league.id })));
    }

    if (allFixtures.length === 0) {
      return res.json({ picks: [], rejected: [], total_analyses: 0, date: new Date().toLocaleDateString('fr-FR') });
    }

    const allPicks = [];
    const rejected = [];

    for (const fixture of allFixtures) {
      try {
        const leagueId = fixture.leagueId || fixture.league?.id;
        const isEuro = EURO_LEAGUES.includes(leagueId);

        // Pour les matchs européens : utiliser standings de la compétition européenne
        // Les rangs UEFA (1-36 en CL, 1-36 en EL/UECL) sont comparables entre eux
        // C'est mieux que de tout rejeter
        const standings = await getStandingsCached(leagueId);

        const matchData = await collectMatchData(fixture, leagueId, fixture.leagueName, standings);

        if (!matchData) {
          const hTeam = fixture.teams?.home?.name || '?';
          const aTeam = fixture.teams?.away?.name || '?';
          rejected.push({ match: `${hTeam} vs ${aTeam}`, competition: fixture.leagueName, raison: 'Match trop équilibré ou données insuffisantes' });
          continue;
        }

        const analyse = await genererAnalyse(matchData, matchData.favoriPlayers, matchData.context);

        allPicks.push({
          fixture_id: fixture.fixture?.id,
          score_matriciel: matchData.scoreMatriciel,
          score_total: matchData.score_total,
          score_sort: matchData.scoreSort,
          facteurs: matchData.factors,
          alerte: matchData.alerte,
          cote_estimee_victoire: matchData.coteEstimee,
          favori: matchData.favoriNom,
          adversaire: matchData.adversaireNom,
          favori_rang: matchData.favoriRang,
          adversaire_rang: matchData.adversaireRang,
          favori_forme: matchData.favoriForm,
          adversaire_forme: matchData.adversaireForm,
          prono_type: matchData.pronosType,
          raison_victoire: analyse?.raison || `${matchData.favoriNom} largement favori`,
          joueur_decisif: analyse?.joueur_decisif || null,
          absents: [
            ...(matchData.hMissing?.missingNames || []),
            ...(matchData.aMissing?.missingNames || []),
          ],
          compos_officielles: matchData.composAvailable,
          alerte_compo: null, // sera rempli par /api/check-compos
          match: matchData.match,
          competition: matchData.competition,
          heure: matchData.heure,
          domicile: matchData.domicile,
          exterieur: matchData.exterieur,
        });

      } catch (e) { console.error('Erreur match:', e.message); }
    }

    allPicks.sort((a, b) => (b.score_sort || 0) - (a.score_sort || 0));

    // 2 VERT max + 1 ORANGE + 1 ROUGE
    const vertsAll   = allPicks.filter(p => p.alerte === 'VERT').sort((a,b) => b.score_sort - a.score_sort).slice(0, 2);
    const topOrange  = allPicks.filter(p => p.alerte === 'ORANGE').sort((a,b) => b.score_sort - a.score_sort).slice(0, 1);
    const topRouge   = allPicks.filter(p => p.alerte === 'ROUGE').sort((a,b) => b.score_sort - a.score_sort).slice(0, 1);
    const picks = [...vertsAll, ...topOrange, ...topRouge];

    res.json({
      date: new Date().toLocaleDateString('fr-FR'),
      total_analyses: allFixtures.length,
      picks,
      rejected,
      top_pick: picks[0] || null,
    });

  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── VÉRIFICATION COMPOS — ne change pas les picks, ajoute juste des alertes ──
app.post('/api/check-compos', async (req, res) => {
  try {
    const { picks } = req.body; // picks sauvegardés côté frontend
    if (!picks || picks.length === 0) return res.json({ picks: [] });

    const updatedPicks = await Promise.all(picks.map(async (pick) => {
      if (!pick.fixture_id) return { ...pick, alerte_compo: null };

      const [lineups, injuries] = await Promise.all([
        footballAPI('/fixtures/lineups', { fixture: pick.fixture_id }),
        footballAPI('/injuries', { fixture: pick.fixture_id }),
      ]);

      const hLineup = lineups.find(l => l.team?.name === pick.domicile);
      const aLineup = lineups.find(l => l.team?.name === pick.exterieur);
      const hStarters = (hLineup?.startXI || []).map(p => p.player?.name?.toLowerCase());
      const aStarters = (aLineup?.startXI || []).map(p => p.player?.name?.toLowerCase());
      const composDispo = hStarters.length > 0 || aStarters.length > 0;

      const injuredNames = new Set(injuries.map(i => (i.player?.name || '').toLowerCase()));

      // Vérifier si le joueur décisif est titulaire
      let alerteCompo = null;
      if (pick.joueur_decisif?.joueur) {
        const nomJoueur = pick.joueur_decisif.joueur.toLowerCase();
        const favoriIsHome = pick.prono_type !== 'victoire_exterieur';
        const starters = favoriIsHome ? hStarters : aStarters;

        if (isInjuredPlayer(nomJoueur, injuredNames)) {
          alerteCompo = `⚠️ ${pick.joueur_decisif.joueur} BLESSÉ — joueur décisif bonus non disponible`;
        } else if (composDispo && starters.length > 0 && !isInStarters(nomJoueur, starters)) {
          alerteCompo = `⚠️ ${pick.joueur_decisif.joueur} sur le BANC — pick victoire reste valable`;
        }
      }

      return {
        ...pick,
        compos_officielles: composDispo,
        alerte_compo: alerteCompo,
      };
    }));

    res.json({ picks: updatedPicks });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/reset-cache', (req, res) => {
  cache.lastDate = null;
  ['standings','teamStats','players','natLeagues','fixtureStats','predictions'].forEach(k => { cache[k] = {}; });
  cache.tennisRankMap = null;
  res.json({ status: 'Cache réinitialisé' });
});

// ── SCAN TIRS CADRÉS ──────────────────────────────────────
app.get('/api/scan-tirs', async (req, res) => {
  try {
    const today = getTodayStr();
    await preloadCache();

    const allFixtures = [];
    for (const league of TIRS_LEAGUES) {
      const data = await getFixturesWithFallback(league.id, today);
      const valid = data.filter(f => !['PST','CANC','ABD','SUSP','AWD','WO'].includes(f.fixture?.status?.short));
      if (valid.length > 0) allFixtures.push(...valid.map(f => ({ ...f, leagueName: league.name, leagueId: league.id })));
    }

    if (allFixtures.length === 0) {
      return res.json({ picks: [], total_analyses: 0, date: new Date().toLocaleDateString('fr-FR') });
    }

    const picks = [];

    for (const fixture of allFixtures) {
      try {
        const hTeam = fixture.teams?.home;
        const aTeam = fixture.teams?.away;
        const leagueId = fixture.leagueId;
        if (!hTeam || !aTeam) continue;

        const hTime = fixture.fixture?.date
          ? new Date(fixture.fixture.date).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
          : '?';

        // Récupérer stats avancées des deux équipes
        const isEuro = EURO_LEAGUES.includes(leagueId);
        const [hAdv, aAdv] = await Promise.all([
          getAdvancedStatsCached(hTeam.id, leagueId),
          getAdvancedStatsCached(aTeam.id, leagueId),
        ]);

        if (!hAdv || !aAdv) {
          console.log(`[TIRS] Skip ${hTeam.name} vs ${aTeam.name} — stats manquantes (h:${!!hAdv} a:${!!aAdv})`);
          continue;
        }

        // Score aller pour matchs européens
        let firstLegDeficit = 0; // buts à remonter par l'équipe domicile
        let firstLegContext = '';
        if (isEuro) {
          const matchDate = new Date(fixture.fixture?.date || Date.now());
          const firstLegFixtures = await footballAPI('/fixtures', {
            league: leagueId, season: SEASON, team: hTeam.id, status: 'FT', last: 10,
          });
          const firstLeg = firstLegFixtures.find(f => {
            const isVsAway = (f.teams?.home?.id === aTeam.id && f.teams?.away?.id === hTeam.id) ||
                             (f.teams?.home?.id === hTeam.id && f.teams?.away?.id === aTeam.id);
            return isVsAway && new Date(f.fixture?.date) < matchDate && f.fixture?.status?.short === 'FT';
          });
          if (firstLeg) {
            const hWasHome = firstLeg.teams?.home?.id === hTeam.id;
            const hGoals = hWasHome ? (firstLeg.goals?.home||0) : (firstLeg.goals?.away||0);
            const aGoals = hWasHome ? (firstLeg.goals?.away||0) : (firstLeg.goals?.home||0);
            firstLegDeficit = aGoals - hGoals; // positif = domicile doit remonter
            firstLegContext = `Match aller: ${hTeam.name} ${hGoals}-${aGoals} ${aTeam.name}`;
          }
        }

        // Tirs cadrés moyens combinés
        const hShotsOn = hAdv.shotsOnTarget || 0;
        const aShotsOn = aAdv.shotsOnTarget || 0;
        const hShotsTotal = hAdv.shotsTotal || 0;
        const aShotsTotal = aAdv.shotsTotal || 0;
        let totalMoyen = +(hShotsOn + aShotsOn).toFixed(1);
        let totalMoyenShots = +(hShotsTotal + aShotsTotal).toFixed(1);

        // Régularité combinée des deux équipes (écart-type moyen)
        const hStdDev = hAdv.stdDev || 2.0;
        const aStdDev = aAdv.stdDev || 2.0;
        const combinedStdDev = +((hStdDev + aStdDev) / 2).toFixed(2);
        // Régulier = stdDev < 1.5 | Moyen = 1.5-2.5 | Irrégulier = > 2.5
        const isRegular = combinedStdDev < 1.5;
        const isIrregular = combinedStdDev > 2.5;

        // Bonus contexte retour — équipe qui doit remonter tire plus
        let bonusContexte = '';
        if (firstLegDeficit >= 3) {
          totalMoyen = +(totalMoyen + 2.0).toFixed(1);
          totalMoyenShots = +(totalMoyenShots + 5.0).toFixed(1); // plus de tirs totaux car équipe ouvre le jeu
          bonusContexte = ` (+2.0 cadrés / +5.0 totaux retour: doit remonter ${firstLegDeficit} buts)`;
        } else if (firstLegDeficit === 2) {
          totalMoyen = +(totalMoyen + 1.0).toFixed(1);
          totalMoyenShots = +(totalMoyenShots + 3.0).toFixed(1);
          bonusContexte = ` (+1.0 cadrés / +3.0 totaux retour: doit remonter 2 buts)`;
        } else if (firstLegDeficit === 1) {
          totalMoyen = +(totalMoyen + 0.5).toFixed(1);
          totalMoyenShots = +(totalMoyenShots + 1.5).toFixed(1);
          bonusContexte = ` (+0.5 cadrés / +1.5 totaux retour: doit remonter 1 but)`;
        }

        if (totalMoyen < 3) {
          console.log(`[TIRS] Skip ${hTeam.name} vs ${aTeam.name} — totalMoyen trop bas: ${totalMoyen}`);
          continue;
        }

        // L'app fournit l'estimation brute + tendance
        // L'utilisateur choisit lui-même la ligne chez son bookmaker
        let tendance = null;
        let fiabilite = 0;

        if (totalMoyen >= 7) {
          tendance = 'OVER';
          fiabilite = Math.min(92, Math.round(65 + (totalMoyen - 7) * 4 + (isRegular ? 4 : 0)));
        } else if (totalMoyen >= 5.5) {
          tendance = 'OVER';
          fiabilite = Math.min(84, Math.round(60 + (totalMoyen - 5.5) * 4 + (isRegular ? 3 : 0)));
        } else if (totalMoyen >= 4.5) {
          if (isRegular) {
            tendance = 'UNDER';
            fiabilite = Math.min(80, Math.round(62 + (5.0 - totalMoyen) * 4));
          } else {
            tendance = 'OVER';
            fiabilite = Math.min(72, Math.round(58 + (totalMoyen - 4.5) * 4));
          }
        } else if (totalMoyen >= 3.5) {
          tendance = 'UNDER';
          fiabilite = Math.min(84, Math.round(62 + (4.5 - totalMoyen) * 6 + (isRegular ? 4 : 0)));
        } else {
          tendance = 'UNDER';
          fiabilite = Math.min(90, Math.round(68 + (3.5 - totalMoyen) * 6 + (isRegular ? 4 : 0)));
        }

        // Malus irrégularité réduit — les équipes LDC jouent beaucoup de compétitions
        if (isIrregular) fiabilite = Math.max(0, fiabilite - 4);

        // Prono = estimation brute + tendance (pas de ligne fixe)
        const regulariteLabel = isRegular ? '✅ Bonne' : isIrregular ? '⚠️ Irrégulier' : '➖ Moyenne';
        const prono = `Estimation ${totalMoyen} tirs — tendance ${tendance}`;
        const coteEstimee = tendance === 'OVER' ? (totalMoyen >= 7 ? 1.60 : 1.75) : 1.75;

        if (fiabilite < 60) {
          console.log(`[TIRS] Skip ${hTeam.name} vs ${aTeam.name} — fiabilité trop basse: ${fiabilite}% (moy:${totalMoyen}, stdDev:${combinedStdDev})`);
          continue;
        }

        // Niveau de confiance
        let alerte = null;
        if (fiabilite >= 80) alerte = 'VERT';
        else if (fiabilite >= 70) alerte = 'ORANGE';
        else if (fiabilite >= 60) alerte = 'ROUGE';

        picks.push({
          match: `${hTeam.name} vs ${aTeam.name}`,
          competition: fixture.leagueName,
          heure: hTime,
          domicile: hTeam.name,
          exterieur: aTeam.name,
          prono,
          fiabilite,
          alerte,
          cote_estimee: coteEstimee,
          tendance,
          estimation: totalMoyen,
          regularite: regulariteLabel,
          h_tirs_cadres: hShotsOn,
          a_tirs_cadres: aShotsOn,
          h_tirs_totaux: hShotsTotal,
          a_tirs_totaux: aShotsTotal,
          total_moyen: totalMoyen,
          estimation_totaux: totalMoyenShots,
          raison: `${hTeam.name} ${hShotsOn} cadrés / ${hShotsTotal} totaux · ${aTeam.name} ${aShotsOn} cadrés / ${aShotsTotal} totaux${bonusContexte} · Régularité ${regulariteLabel}${firstLegContext ? ' · ' + firstLegContext : ''}`,
        });

      } catch (e) { console.error('Erreur tirs match:', e.message); }
    }

    // Trier par fiabilité décroissante, garder top 3
    picks.sort((a, b) => b.fiabilite - a.fiabilite);
    // Tous les VERT + 1 seul ORANGE + 1 seul ROUGE
    const tirsVerts   = picks.filter(p => p.alerte === 'VERT').sort((a,b) => b.fiabilite - a.fiabilite).slice(0, 2);
    const tirsOrange  = picks.filter(p => p.alerte === 'ORANGE').sort((a,b) => b.fiabilite - a.fiabilite).slice(0, 1);
    const tirsRouge   = picks.filter(p => p.alerte === 'ROUGE').sort((a,b) => b.fiabilite - a.fiabilite).slice(0, 1);
    const top3 = [...tirsVerts, ...tirsOrange, ...tirsRouge];

    res.json({
      date: new Date().toLocaleDateString('fr-FR'),
      total_analyses: allFixtures.length,
      picks: top3,
    });

  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ══════════════════════════════════════════════════════════
// ── SCAN TENNIS ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════

const TENNIS_API_KEY  = process.env.TENNIS_API_KEY || process.env.FOOTBALL_API_KEY;

// API Tennis — api-tennis.com
const TENNIS_API_BASE = 'https://api.api-tennis.com/tennis/';

async function tennisAPI(method, params = {}) {
  await sleep(300);
  try {
    const res = await axios.get(TENNIS_API_BASE, {
      params: { method, APIkey: TENNIS_API_KEY, ...params },
      timeout: 10000,
    });
    const data = res.data;
    if (!data.success) {
      console.error('[Tennis] API error:', data);
      return [];
    }
    return data.result || [];
  } catch(e) {
    console.error('[Tennis] API error:', method, e.message);
    return [];
  }
}

// Matrice tennis v2 — F1 rang ATP, F2 forme, F3 surface, F4 H2H global, F5 H2H surface, F6 niveau tournoi
function scoreTennisMatch({ rankFavori, rankAdversaire, h2hFavori, h2hTotal, h2hSurfFavori, h2hSurfTotal, grandSlam, masters1000, atp500 }) {
  let score = 0;

  // F1 — Écart de rang ATP/WTA (principal indicateur)
  if (rankFavori && rankAdversaire && rankFavori < 900 && rankAdversaire < 900) {
    const diff = rankAdversaire - rankFavori;
    if (diff >= 200) score += 35;
    else if (diff >= 100) score += 28;
    else if (diff >= 50)  score += 20;
    else if (diff >= 20)  score += 12;
    else if (diff >= 5)   score += 6;
    // diff < 5 → match serré, pas de bonus rang
  } else if (rankFavori < 50 && rankAdversaire >= 900) {
    score += 30; // Top 50 vs non classé
  } else {
    score += 10; // Rangs inconnus → score neutre
  }

  // F2 — H2H global
  if (h2hTotal >= 2) {
    const rate = h2hFavori / h2hTotal;
    if (rate >= 0.80) score += 25;
    else if (rate >= 0.65) score += 18;
    else if (rate >= 0.55) score += 10;
    else if (rate >= 0.50) score += 5;
    else score -= 8;
  } else if (h2hTotal === 1) {
    score += h2hFavori === 1 ? 10 : -3;
  } else {
    score += 5; // 1ère rencontre → neutre
  }

  // F3 — H2H sur la surface actuelle
  if (h2hSurfTotal >= 2) {
    const surfRate = h2hSurfFavori / h2hSurfTotal;
    if (surfRate >= 0.80) score += 15;
    else if (surfRate >= 0.65) score += 10;
    else if (surfRate >= 0.50) score += 4;
    else score -= 4;
  }

  // F4 — Niveau du tournoi
  if (grandSlam)        score += 12;
  else if (masters1000) score += 10;
  else if (atp500)      score += 6;
  else                  score += 3;

  return Math.max(0, Math.min(score, 100));
}

function getTennisAlerte(score) {
  if (score >= 60) return 'VERT';
  if (score >= 38) return 'ORANGE';
  if (score >= 20) return 'ROUGE';
  return null;
}

app.get('/api/scan-tennis', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const today = getTodayStr();
    console.log('[Tennis] Scan du', today);

    // 1. Récupérer tous les matchs du jour
    const allGames = await tennisAPI('get_fixtures', { date_start: today, date_stop: today });
    console.log('[Tennis] Matchs bruts:', allGames.length);

    // 2. Garder uniquement les Singles ATP + WTA (pas ITF, pas Doubles)
    const singles = allGames.filter(g => {
      const type = (g.event_type_type || '').toLowerCase();
      return (type.includes('atp') || type.includes('wta')) && type.includes('singles');
    });
    console.log('[Tennis] ATP/WTA Singles:', singles.length);

    if (!singles.length) {
      return res.json({ picks: [], rejected: [], total_analyses: 0, date: new Date().toLocaleDateString('fr-FR') });
    }

    // 3. Récupérer les rangs des joueurs uniques en parallèle
    const playerKeys = [...new Set(singles.flatMap(g => [g.first_player_key, g.second_player_key].filter(Boolean)))];
    console.log('[Tennis] Joueurs uniques à charger:', playerKeys.length);

    const rankMap = {};
    // Appels par batch de 5 pour ne pas surcharger l'API
    for (let i = 0; i < playerKeys.length; i += 5) {
      const batch = playerKeys.slice(i, i + 5);
      await Promise.all(batch.map(async key => {
        try {
          const data = await tennisAPI('get_players', { player_key: key });
          if (data && data.length > 0) {
            const p = data[0];
            const rank = parseInt(p.player_singles_rank || p.player_rank || p.ranking || 9999);
            if (rank < 9999) rankMap[String(key)] = rank;
          }
        } catch(e) { /* rang optionnel */ }
      }));
    }
    console.log('[Tennis] Rangs récupérés:', Object.keys(rankMap).length, 'joueurs');

    const picks = [];
    const rejected = [];

    for (const game of singles) {
      try {
        const p1Name = game.event_first_player  || '?';
        const p2Name = game.event_second_player || '?';
        if (!p1Name || !p2Name || p1Name === '?') {
          rejected.push({ match: '?', raison: 'Joueurs manquants' }); continue;
        }
        if (p1Name.includes('/') || p2Name.includes('/')) continue; // doubles ignorés

        const matchStr = `${p1Name} vs ${p2Name}`;
        const p1Key = String(game.first_player_key  || '');
        const p2Key = String(game.second_player_key || '');

        const rank1 = rankMap[p1Key] || 999;
        const rank2 = rankMap[p2Key] || 999;

        // Favori = meilleur rang (plus petit chiffre)
        const favoriIsP1    = rank1 <= rank2;
        const favoriName    = favoriIsP1 ? p1Name : p2Name;
        const adversaireName= favoriIsP1 ? p2Name : p1Name;
        const favoriRank    = favoriIsP1 ? rank1 : rank2;
        const adversaireRank= favoriIsP1 ? rank2 : rank1;
        const favoriId      = favoriIsP1 ? p1Key  : p2Key;
        const adversaireId  = favoriIsP1 ? p2Key  : p1Key;

        // Surface et tournoi
        const tournament  = game.tournament_name || '—';
        const isWTA       = (game.event_type_type || '').toLowerCase().includes('wta');
        const circuit     = isWTA ? 'WTA' : 'ATP';
        const surface     = /clay|roland|terre|barcelona|madrid|rome/i.test(tournament) ? 'Clay'
                          : /grass|wimbledon|halle|queen/i.test(tournament) ? 'Grass' : 'Hard';
        const heure       = game.event_time || '—';
        const grandSlam   = /australian|roland|wimbledon|us open/i.test(tournament);
        const masters1000 = /miami|indian wells|madrid|rome|montreal|toronto|cincinnati|shanghai|paris/i.test(tournament);
        const atp500      = /barcelona|dubai|rotterdam|washington|vienna|beijing/i.test(tournament);

        // H2H
        let h2hFavori = 0, h2hTotal = 0, h2hSurfFavori = 0, h2hSurfTotal = 0;
        if (favoriId && adversaireId) {
          try {
            const h2hData = await tennisAPI('get_H2H', { first_player_key: favoriId, second_player_key: adversaireId });
            if (h2hData && h2hData.length) {
              const firstLast = favoriName.split(' ').pop().toLowerCase();
              h2hTotal = h2hData.length;
              h2hFavori = h2hData.filter(g => (g.event_winner || '').toLowerCase().includes(firstLast)).length;
              const surf = h2hData.filter(g => (g.event_surface || '').toLowerCase() === surface.toLowerCase());
              h2hSurfTotal = surf.length;
              h2hSurfFavori = surf.filter(g => (g.event_winner || '').toLowerCase().includes(firstLast)).length;
            }
          } catch(e) { /* H2H optionnel */ }
        }

        // Score matriciel
        const score = scoreTennisMatch({ rankFavori: favoriRank, rankAdversaire: adversaireRank, h2hFavori, h2hTotal, h2hSurfFavori, h2hSurfTotal, grandSlam, masters1000, atp500 });
        const alerte = getTennisAlerte(score);
        if (!alerte) { rejected.push({ match: matchStr, raison: `Score trop faible (${score})` }); continue; }

        picks.push({
          match:           matchStr,
          favori:          favoriName,
          adversaire:      adversaireName,
          favori_rang:     favoriRank < 900 ? favoriRank : null,
          adversaire_rang: adversaireRank < 900 ? adversaireRank : null,
          favori_forme:    '—',
          adversaire_forme:'—',
          favori_bilan:    '',
          adversaire_bilan:'',
          competition:     `${circuit} · ${tournament}`,
          surface,
          heure,
          scoreMatriciel:  score,
          alerte,
          h2h_global:      h2hTotal > 0 ? `${h2hFavori}/${h2hTotal}` : '—',
          h2h_surface:     h2hSurfTotal > 0 ? `${h2hSurfFavori}/${h2hSurfTotal}` : '—',
          h2h_total_matchs: h2hTotal,
          factors: [
            (favoriRank < 900 && adversaireRank < 900) ? `#${favoriRank} vs #${adversaireRank}` : null,
            h2hTotal > 0 ? `H2H ${h2hFavori}/${h2hTotal}` : 'H2H: 1ère rencontre',
            h2hSurfTotal > 0 ? `H2H ${surface}: ${h2hSurfFavori}/${h2hSurfTotal}` : null,
            grandSlam ? '🏆 Grand Slam' : masters1000 ? '🎯 Masters 1000' : atp500 ? 'ATP/WTA 500' : null,
          ].filter(Boolean),
          raison: `${favoriName}${favoriRank < 900 ? ' (#'+favoriRank+')' : ''} favori vs ${adversaireName}${adversaireRank < 900 ? ' (#'+adversaireRank+')' : ''} — score ${score}/100`,
        });

      } catch(e) { console.error('[Tennis] Erreur match:', e.message); }
    }

    picks.sort((a, b) => b.scoreMatriciel - a.scoreMatriciel);
    const verts   = picks.filter(p => p.alerte === 'VERT').slice(0, 2);
    const oranges = picks.filter(p => p.alerte === 'ORANGE').slice(0, 2);
    const rouges  = picks.filter(p => p.alerte === 'ROUGE').slice(0, 1);
    const finalPicks = [...verts, ...oranges, ...rouges];

    console.log(`[Tennis] ${finalPicks.length} picks (${singles.length} matchs analysés)`);
    res.json({
      date: new Date().toLocaleDateString('fr-FR'),
      total_analyses: singles.length,
      picks: finalPicks,
      rejected,
    });

  } catch(e) {
    console.error('[Tennis] Erreur scan:', e.message);
    res.status(500).json({ error: e.message });
  }
});


app.get('/api/debug-tennis', async (req, res) => {
  try {
    const today = getTodayStr();
    
    // Trouver le match Lehecka vs Sinner dans les fixtures du jour
    const fixtures = await tennisAPI('get_fixtures', { date_start: today, date_stop: today });
    const sinnerMatch = fixtures.find(g => 
      (g.event_first_player||'').toLowerCase().includes('sinner') || 
      (g.event_second_player||'').toLowerCase().includes('sinner')
    );
    
    const p1key = sinnerMatch?.first_player_key;
    const p2key = sinnerMatch?.second_player_key;
    
    // Tester get_players avec ces keys
    const [p1data, p2data] = await Promise.all([
      p1key ? tennisAPI('get_players', { player_key: p1key }) : Promise.resolve([]),
      p2key ? tennisAPI('get_players', { player_key: p2key }) : Promise.resolve([]),
    ]);

    res.json({
      today,
      sinner_match_found: !!sinnerMatch,
      match_raw: sinnerMatch ? JSON.stringify(sinnerMatch).substring(0, 300) : null,
      p1_key: p1key,
      p2_key: p2key,
      p1_player_data: p1data.length ? JSON.stringify(p1data[0]) : 'empty',
      p2_player_data: p2data.length ? JSON.stringify(p2data[0]) : 'empty',
      all_methods_tried: ['get_ranking→0', 'get_standings→0', 'get_players→?'],
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', name: 'PicksAI', version: '4.1', season: SEASON }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend/index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PicksAI v3.0 port ${PORT}`));
