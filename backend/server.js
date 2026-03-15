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
const cache = { standings: {}, teamStats: {}, players: {}, natLeagues: {}, lastDate: null };
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
    ])));
  }
  cache.lastDate = today;
  console.log(`Cache OK — ${pairs.length} equipes`);
}

// ── ANALYSE COMPLETE DU MATCH ─────────────────────────────
// Détermine quelle équipe est favorite ET avec quelle fiabilité
function analyseMatchComplet(hStats, aStats, hStand, aStand, h2h, injuries, isEuropean, hPlayers, aPlayers, composH, composA) {
  
  // ── DONNÉES DE BASE ───────────────────────────────────
  const hRank = hStand?.rank || 99;
  const aRank = aStand?.rank || 99;
  const hPts  = hStand?.points || 0;
  const aPts  = aStand?.points || 0;
  const hForm = (hStand?.form || '').slice(-5);
  const aForm = (aStand?.form || '').slice(-5);
  const hWins = (hForm.match(/W/g) || []).length;
  const aWins = (aForm.match(/W/g) || []).length;
  const hLoss = (hForm.match(/L/g) || []).length;
  const aLoss = (aForm.match(/L/g) || []).length;

  // Stats offensives/défensives
  const hGoalsFor     = parseFloat(hStats?.goals?.for?.average?.home)     || 0;
  const hGoalsAgainst = parseFloat(hStats?.goals?.against?.average?.home)  || 0;
  const aGoalsFor     = parseFloat(aStats?.goals?.for?.average?.away)      || 0;
  const aGoalsAgainst = parseFloat(aStats?.goals?.against?.average?.away)  || 0;

  // H2H
  const h2hTotal = Math.min(h2h?.length || 0, 5);
  const h2hHomeWins = (h2h || []).slice(0,5).filter(m => (m.goals?.home||0) > (m.goals?.away||0)).length;
  const h2hAwayWins = (h2h || []).slice(0,5).filter(m => (m.goals?.away||0) > (m.goals?.home||0)).length;

  // ── SCORE BRUT CHAQUE ÉQUIPE ──────────────────────────
  let hScore = 0;
  let aScore = 0;
  const factors = [];

  // Classement (max 30pts)
  const rankDiff = aRank - hRank;
  if (rankDiff >= 15)      { hScore += 30; factors.push('F1'); }
  else if (rankDiff >= 10) { hScore += 22; factors.push('F1'); }
  else if (rankDiff >= 5)  { hScore += 14; factors.push('F1'); }
  else if (rankDiff >= 2)  { hScore += 7; }
  else if (rankDiff <= -10){ aScore += 22; factors.push('F1'); }
  else if (rankDiff <= -5) { aScore += 14; factors.push('F1'); }
  else if (rankDiff <= -2) { aScore += 7; }

  // Points (max 15pts)
  const ptsDiff = hPts - aPts;
  if (ptsDiff >= 20)       { hScore += 15; factors.push('F14'); }
  else if (ptsDiff >= 12)  { hScore += 10; factors.push('F14'); }
  else if (ptsDiff >= 6)   { hScore += 5; }
  else if (ptsDiff <= -12) { aScore += 10; factors.push('F14'); }
  else if (ptsDiff <= -6)  { aScore += 5; }

  // Avantage domicile (max 10pts)
  hScore += 10;

  // Forme (max 15pts)
  if (hWins >= 4)      { hScore += 15; factors.push('F12'); }
  else if (hWins >= 3) { hScore += 9; factors.push('F12'); }
  else if (hLoss >= 3) { hScore -= 8; }
  if (aWins >= 4)      { aScore += 12; }
  else if (aWins >= 3) { aScore += 7; }
  else if (aLoss >= 3) { aScore -= 8; }

  // Défense adverse (max 12pts)
  if (aGoalsAgainst >= 2.0)  { hScore += 12; factors.push('F5'); }
  else if (aGoalsAgainst >= 1.5) { hScore += 7; factors.push('F5'); }
  if (hGoalsAgainst >= 2.0)  { aScore += 12; factors.push('F5'); }
  else if (hGoalsAgainst >= 1.5) { aScore += 7; }

  // Attaque (max 8pts)
  if (hGoalsFor >= 2.0)  { hScore += 8; factors.push('F6'); }
  else if (hGoalsFor >= 1.5) { hScore += 5; factors.push('F6'); }
  if (aGoalsFor >= 2.0)  { aScore += 8; }
  else if (aGoalsFor >= 1.5) { aScore += 5; }

  // H2H (max 10pts)
  if (h2hHomeWins >= 4) { hScore += 10; factors.push('F9'); }
  else if (h2hHomeWins >= 3) { hScore += 6; factors.push('F9'); }
  if (h2hAwayWins >= 4) { aScore += 10; factors.push('F9'); }
  else if (h2hAwayWins >= 3) { aScore += 6; }

  // Top équipe domicile
  if (hRank <= 3) { hScore += 10; factors.push('F2'); }
  else if (hRank <= 6) { hScore += 5; factors.push('F2'); }

  // Adversaire très faible
  if (aRank >= 17) { hScore += 12; factors.push('F11'); }
  else if (aRank >= 15) { hScore += 7; factors.push('F11'); }

  // Enjeu européen
  if (isEuropean) { factors.push('F7'); }

  // ── IMPACT BLESSÉS ────────────────────────────────────
  // Identifier les joueurs clés blessés de chaque équipe
  const injuredIds = new Set((injuries || []).map(i => i.player?.id).filter(Boolean));
  const injuredNames = new Set((injuries || []).map(i => (i.player?.name||'').toLowerCase()));

  const getKeyPlayersMissing = (players, starters, teamInjuries) => {
    // Joueurs offensifs clés manquants
    const offPlayers = players.filter(p => {
      const pos = (p.statistics?.[0]?.games?.position || p.player?.position || '');
      return pos === 'F' || pos === 'Forward' || pos === 'Attacker' || pos === 'M' || pos === 'Midfielder';
    });
    const topScorers = offPlayers
      .map(p => ({ name: p.player?.name, goals: p.statistics?.[0]?.goals?.total || 0, id: p.player?.id }))
      .sort((a, b) => b.goals - a.goals)
      .slice(0, 3); // top 3 buteurs

    let missing = 0;
    let missingNames = [];
    for (const scorer of topScorers) {
      const isInjured = injuredIds.has(scorer.id) || injuredNames.has((scorer.name||'').toLowerCase());
      const notInCompo = starters.length > 0 && !isInStarters(scorer.name||'', starters);
      if (isInjured || notInCompo) {
        missing++;
        missingNames.push(scorer.name);
      }
    }
    return { missing, missingNames };
  };

  const hMissing = getKeyPlayersMissing(hPlayers, composH, injuries);
  const aMissing = getKeyPlayersMissing(aPlayers, composA, injuries);

  // Malus pour joueurs clés manquants
  if (hMissing.missing >= 2) { hScore -= 20; }
  else if (hMissing.missing === 1) { hScore -= 10; }
  if (aMissing.missing >= 2) { aScore -= 15; }
  else if (aMissing.missing === 1) { aScore -= 8; }

  // ── DÉTERMINER LE FAVORI ──────────────────────────────
  const totalScore = hScore + aScore;
  const diff = hScore - aScore;
  const uniqueFactors = [...new Set(factors)];

  let favoriIsHome = null;
  let scoreMatriciel = 0;
  let alerte = null;
  let pronosType = null; // 'victoire_domicile' | 'victoire_exterieur' | 'nul'

  const absDiff = Math.abs(diff);

  if (absDiff < 15) {
    // Match trop équilibré → rejeté ou nul
    pronosType = 'equilibre';
    scoreMatriciel = 0;
  } else if (diff >= 15) {
    favoriIsHome = true;
    pronosType = 'victoire_domicile';
    scoreMatriciel = Math.min(100, Math.round(absDiff * 1.2));
  } else {
    favoriIsHome = false;
    pronosType = 'victoire_exterieur';
    scoreMatriciel = Math.min(100, Math.round(absDiff * 1.0)); // légèrement pénalisé car extérieur
  }

  if (scoreMatriciel >= 75) alerte = 'VERT';
  else if (scoreMatriciel >= 55) alerte = 'ORANGE';
  else if (scoreMatriciel >= 40) alerte = 'ROUGE';

  // Estimation cote victoire selon score et type de prono
  // Plus le score est élevé, plus l'équipe est favorite → cote basse
  // Un pick extérieur a naturellement une cote plus haute
  let coteEstimee = null;
  if (scoreMatriciel >= 75) {
    coteEstimee = favoriIsHome ? 1.55 : 1.80;
  } else if (scoreMatriciel >= 55) {
    coteEstimee = favoriIsHome ? 1.75 : 2.00;
  } else if (scoreMatriciel >= 40) {
    coteEstimee = favoriIsHome ? 2.00 : 2.30;
  }

  // Filtre value bet — rejeter si cote estimée trop basse (pas de value)
  // VERT domicile à 1.55 c'est bien, mais si le score est très haut = favori évident = cote réelle < 1.40
  if (scoreMatriciel >= 85) alerte = null; // Score trop haut = favori trop évident = cote réelle ~1.20-1.35

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
    return `  - ${p.player?.name} | ${pos} | ${goals}B ${assists}PD en ${apps}M`;
  }).join('\n') || '  (données non disponibles)';

  const missingStr = matchInfo.hMissing?.missingNames?.length > 0
    ? `Absents ${favori}: ${matchInfo.hMissing.missingNames.join(', ')}`
    : '';

  const prompt = `Expert football. Analyse ce match et justifie le pronostic.

MATCH: ${matchInfo.match} | ${matchInfo.competition} | ${matchInfo.heure}
PRONOSTIC: Victoire ${favori}
${favori}: rang ${matchInfo.favoriRang}e (${matchInfo.favoriPts}pts, forme:${matchInfo.favoriForm})
${adversaire}: rang ${matchInfo.adversaireRang}e (${matchInfo.adversairePts}pts, forme:${matchInfo.adversaireForm})
${missingStr}
CONTEXTE: ${context}

JOUEURS OFFENSIFS DE ${favori}:
${playerList}

RÈGLES:
1. 2 phrases MAX sur pourquoi ${favori} gagne — chiffres concrets
2. Joueur décisif: ATTAQUANT ou AILIER en priorité, ❌ jamais blessé/suspendu
3. ❌ jamais milieu défensif
4. Utilise tes connaissances réelles sur les joueurs et leur statut actuel

JSON UNIQUEMENT:
{"raison":"2 phrases pourquoi victoire","joueur_decisif":{"joueur":"Prénom Nom","type":"Joueur décisif","prob":72,"cote_estimee":1.75,"raison":"1 phrase courte"}}`;

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

  const [hStats, aStats, hPlayers, aPlayers, injuries, h2h, lineups] = await Promise.all([
    getTeamStatsCached(hTeam.id, leagueId),
    getTeamStatsCached(aTeam.id, leagueId),
    getPlayersCached(hTeam.id, leagueId),
    getPlayersCached(aTeam.id, leagueId),
    footballAPI('/injuries', { fixture: fixtureId }),
    footballAPI('/fixtures/headtohead', { h2h: `${hTeam.id}-${aTeam.id}`, last: 5 }),
    footballAPI('/fixtures/lineups', { fixture: fixtureId }),
  ]);

  const hStand = standings.find(s => s.team?.id === hTeam.id);
  const aStand = standings.find(s => s.team?.id === aTeam.id);

  const hLineup = lineups.find(l => l.team?.id === hTeam.id);
  const aLineup = lineups.find(l => l.team?.id === aTeam.id);
  const hStarters = (hLineup?.startXI || []).map(p => p.player?.name?.toLowerCase()).filter(Boolean);
  const aStarters = (aLineup?.startXI || []).map(p => p.player?.name?.toLowerCase()).filter(Boolean);
  const composAvailable = hStarters.length > 0 || aStarters.length > 0;

  const analyse = analyseMatchComplet(
    hStats, aStats, hStand, aStand, h2h, injuries, isEuropean,
    hPlayers, aPlayers, hStarters, aStarters
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
  const context = `${hTeam.name} ${analyse.hRank}e (${analyse.hPts}pts, forme:${analyse.hForm}) vs ${aTeam.name} ${analyse.aRank}e (${analyse.aPts}pts, forme:${analyse.aForm}). H2H: ${h2hStr}. Blessés: ${blessesStr}`;

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
      // Scan complet = TOUS les matchs du jour, passés et futurs
      // L'utilisateur décide lui-même quand scanner
      if (data.length > 0) allFixtures.push(...data.map(f => ({ ...f, leagueName: league.name, leagueId: league.id })));
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
  ['standings','teamStats','players','natLeagues'].forEach(k => { cache[k] = {}; });
  res.json({ status: 'Cache réinitialisé' });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', name: 'PicksAI', version: '3.0' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend/index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PicksAI v3.0 port ${PORT}`));
