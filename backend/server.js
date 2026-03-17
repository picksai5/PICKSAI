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
const SEASON = 2025;

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
];
const EURO_LEAGUES = [2, 3, 848];

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
  const s = await footballAPI('/standings', { league: leagueId, season: SEASON });
  const data = s[0]?.league?.standings?.[0] || [];
  cache.standings[k] = { data, timestamp: Date.now() };
  return data;
}

async function getTeamStatsCached(teamId, leagueId) {
  const k = `${teamId}_${leagueId}`;
  if (isCacheValid(cache.teamStats[k])) return cache.teamStats[k].data;
  const data = await footballAPI('/teams/statistics', { team: teamId, league: leagueId, season: SEASON });
  cache.teamStats[k] = { data, timestamp: Date.now() };
  return data;
}

async function getPlayersCached(teamId, leagueId) {
  const k = `${teamId}_${leagueId}`;
  if (isCacheValid(cache.players[k])) return cache.players[k].data;
  const p1 = await footballAPI('/players', { team: teamId, league: leagueId, season: SEASON, page: 1 });
  const p2 = await footballAPI('/players', { team: teamId, league: leagueId, season: SEASON, page: 2 });
  const data = [...p1, ...p2];
  cache.players[k] = { data, timestamp: Date.now() };
  return data;
}

// Récupère les stats avancées des 5 derniers matchs d'une équipe
// Retourne moyennes : possession, tirs cadrés, tirs totaux, attaques dangereuses
async function getAdvancedStatsCached(teamId, leagueId) {
  const k = `adv_${teamId}_${leagueId}`;
  if (isCacheValid(cache.fixtureStats[k])) return cache.fixtureStats[k].data;

  // Récupérer les 10 derniers matchs joués (toutes compétitions)
  // Plus représentatif que seulement en championnat
  const lastFixtures = await footballAPI('/fixtures', {
    team: teamId, season: SEASON, last: 10, status: 'FT',
  });

  if (!lastFixtures || lastFixtures.length === 0) {
    cache.fixtureStats[k] = { data: null, timestamp: Date.now() };
    return null;
  }

  // Récupérer les stats de chaque match
  const statsPerMatch = await Promise.all(
    lastFixtures.slice(0, 10).map(f => footballAPI('/fixtures/statistics', { fixture: f.fixture?.id }))
  );

  // Calculer les moyennes pour cette équipe
  let totalPossession = 0, totalShotsOn = 0, totalShotsTotal = 0, totalDangerous = 0;
  let count = 0;

  for (const matchStats of statsPerMatch) {
    const teamStats = matchStats.find(s => s.team?.id === teamId);
    if (!teamStats) continue;

    const stats = teamStats.statistics || [];
    const getStat = (type) => {
      const s = stats.find(x => x.type === type);
      if (!s?.value) return 0;
      if (typeof s.value === 'string' && s.value.includes('%')) return parseFloat(s.value) || 0;
      return parseFloat(s.value) || 0;
    };

    totalPossession  += getStat('Ball Possession');
    totalShotsOn     += getStat('Shots on Goal');
    totalShotsTotal  += getStat('Total Shots');
    totalDangerous   += getStat('Dangerous Attacks');
    count++;
  }

  if (count === 0) {
    cache.fixtureStats[k] = { data: null, timestamp: Date.now() };
    return null;
  }

  const data = {
    possession:       Math.round(totalPossession  / count),
    shotsOnTarget:    +(totalShotsOn     / count).toFixed(1),
    shotsTotal:       +(totalShotsTotal  / count).toFixed(1),
    dangerousAttacks: +(totalDangerous   / count).toFixed(1),
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
    const data = await footballAPI('/fixtures', { date: today, league: league.id, season: SEASON });
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
      getAdvancedStatsCached(p.teamId, p.leagueId), // stats avancées préchargées
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
    if (pctHome >= 65)      { hScore += 10; factors.push('F8'); }
    else if (pctHome >= 55) { hScore += 5; }
    if (pctAway >= 65)      { aScore += 10; factors.push('F8'); }
    else if (pctAway >= 55) { aScore += 5; }
    // Si la prédiction contredit fortement notre analyse → signal de prudence
    if (pctHome >= 60 && pctAway <= 25) { hScore += 8; }
    if (pctAway >= 60 && pctHome <= 25) { aScore += 8; }
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

  // Cote estimée selon score et type — indicative seulement
  // L'utilisateur décide lui-même si la cote vaut le coup
  let coteEstimee = null;
  if (pronosType === 'victoire_domicile') {
    if      (scoreMatriciel >= 72) coteEstimee = 1.60;
    else if (scoreMatriciel >= 52) coteEstimee = 1.80;
    else if (scoreMatriciel >= 38) coteEstimee = 2.10;
  } else if (pronosType === 'victoire_exterieur') {
    if      (scoreMatriciel >= 72) coteEstimee = 1.90;
    else if (scoreMatriciel >= 52) coteEstimee = 2.20;
    else if (scoreMatriciel >= 38) coteEstimee = 2.50;
  }

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
3. ❌ JAMAIS blessé/suspendu (Mbappé blessé = EXCLU, utilise tes connaissances mars 2026)
4. ❌ JAMAIS milieu défensif (Rodri, Casemiro etc)
5. Si ratio API faible mais joueur connu prolifique → utilise tes connaissances réelles

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
      // Normaliser : hTeam = domicile du match retour
      const hWasHome = firstLeg.teams?.home?.id === hTeam.id;
      firstLegScore = {
        hGoals: hWasHome ? (firstLeg.goals?.home || 0) : (firstLeg.goals?.away || 0),
        aGoals: hWasHome ? (firstLeg.goals?.away || 0) : (firstLeg.goals?.home || 0),
      };
    }
  }

  const hLineup = lineups.find(l => l.team?.id === hTeam.id);
  const aLineup = lineups.find(l => l.team?.id === aTeam.id);
  const hStarters = (hLineup?.startXI || []).map(p => p.player?.name?.toLowerCase()).filter(Boolean);
  const aStarters = (aLineup?.startXI || []).map(p => p.player?.name?.toLowerCase()).filter(Boolean);
  const composAvailable = hStarters.length > 0 || aStarters.length > 0;

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
      const data = await footballAPI('/fixtures', { date: today, league: league.id, season: SEASON });
      // Exclure les matchs reportés (PST), annulés (CANC), abandonnés (ABD), suspendus (SUSP)
      const validFixtures = data.filter(f => {
        const status = f.fixture?.status?.short;
        return !['PST', 'CANC', 'ABD', 'SUSP', 'AWD', 'WO'].includes(status);
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

    const topVert   = allPicks.find(p => p.alerte === 'VERT')   || null;
    const topOrange = allPicks.find(p => p.alerte === 'ORANGE') || null;
    const topRouge  = allPicks.find(p => p.alerte === 'ROUGE')  || null;
    const picks = [topVert, topOrange, topRouge].filter(Boolean);

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
  res.json({ status: 'Cache réinitialisé' });
});

// ── SCAN TIRS CADRÉS ──────────────────────────────────────
app.get('/api/scan-tirs', async (req, res) => {
  try {
    const today = getTodayStr();
    await preloadCache();

    const allFixtures = [];
    for (const league of LEAGUES) {
      const data = await footballAPI('/fixtures', { date: today, league: league.id, season: SEASON });
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

        if (!hAdv || !aAdv) continue;

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
        let totalMoyen = +(hShotsOn + aShotsOn).toFixed(1);

        // Bonus contexte retour — équipe qui doit remonter tire BEAUCOUP plus
        let bonusContexte = '';
        if (firstLegDeficit >= 3) {
          totalMoyen = +(totalMoyen + 3.5).toFixed(1); // +3.5 tirs estimés
          bonusContexte = ` (+3.5 bonus: doit remonter ${firstLegDeficit} buts)`;
        } else if (firstLegDeficit === 2) {
          totalMoyen = +(totalMoyen + 2.0).toFixed(1);
          bonusContexte = ` (+2.0 bonus: doit remonter 2 buts)`;
        } else if (firstLegDeficit === 1) {
          totalMoyen = +(totalMoyen + 1.0).toFixed(1);
          bonusContexte = ` (+1.0 bonus: doit remonter 1 but)`;
        }

        if (totalMoyen < 3) continue;

        const ligne = Math.round(totalMoyen * 2) / 2;

        let prono = null;
        let fiabilite = 0;
        let coteEstimee = 0;

        if (totalMoyen >= 7) {
          prono = `Plus de ${ligne - 0.5} tirs cadrés`;
          fiabilite = Math.min(95, Math.round(60 + (totalMoyen - 7) * 5));
          coteEstimee = 1.65;
        } else if (totalMoyen >= 5.5) {
          prono = `Plus de ${ligne - 1} tirs cadrés`;
          fiabilite = Math.min(90, Math.round(55 + (totalMoyen - 5.5) * 6));
          coteEstimee = 1.75;
        } else if (totalMoyen <= 3.5) {
          prono = `Moins de ${ligne + 0.5} tirs cadrés`;
          fiabilite = Math.min(85, Math.round(60 + (3.5 - totalMoyen) * 8));
          coteEstimee = 1.70;
        } else {
          continue; // zone trop incertaine
        }

        if (fiabilite < 60) continue;

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
          ligne,
          fiabilite,
          alerte,
          cote_estimee: coteEstimee,
          h_tirs_cadres: hShotsOn,
          a_tirs_cadres: aShotsOn,
          total_moyen: totalMoyen,
          raison: `${hTeam.name} moy. ${hShotsOn} tirs/match, ${aTeam.name} ${aShotsOn}/match → total moyen ${totalMoyen}${bonusContexte}. ${firstLegContext}`,
        });

      } catch (e) { console.error('Erreur tirs match:', e.message); }
    }

    // Trier par fiabilité décroissante, garder top 3
    picks.sort((a, b) => b.fiabilite - a.fiabilite);
    const topVert   = picks.find(p => p.alerte === 'VERT')   || null;
    const topOrange = picks.find(p => p.alerte === 'ORANGE') || null;
    const topRouge  = picks.find(p => p.alerte === 'ROUGE')  || null;
    const top3 = [topVert, topOrange, topRouge].filter(Boolean);

    res.json({
      date: new Date().toLocaleDateString('fr-FR'),
      total_analyses: allFixtures.length,
      picks: top3,
    });

  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', name: 'PicksAI', version: '3.0' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend/index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PicksAI v3.0 port ${PORT}`));
