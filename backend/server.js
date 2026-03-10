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

const LEAGUES = [
  { id: 61,  name: 'Ligue 1' },
  { id: 140, name: 'La Liga' },
  { id: 39,  name: 'Premier League' },
  { id: 135, name: 'Serie A' },
  { id: 78,  name: 'Bundesliga' },
  { id: 2,   name: 'Champions League' },
  { id: 3,   name: 'Europa League' },
];

const EURO_LEAGUES = [2, 3, 848];

// ── CACHE SYSTÈME ─────────────────────────────────────────
// Stocke les données lourdes 1x par jour, scan rapide après
const cache = {
  standings: {},      // { leagueId: { data, timestamp } }
  teamStats: {},      // { teamId_leagueId: { data, timestamp } }
  players: {},        // { teamId_leagueId: { data, timestamp } }
  natLeagues: {},     // { teamId: { leagueId, timestamp } }
  lastDate: null,     // date du dernier cache
};

const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 heures

function isCacheValid(entry) {
  if (!entry) return false;
  return Date.now() - entry.timestamp < CACHE_TTL;
}

function getTodayStr() {
  return new Date().toISOString().split('T')[0];
}

// ── API FOOTBALL ──────────────────────────────────────────
async function footballAPI(endpoint, params = {}) {
  await sleep(200);
  try {
    const res = await axios.get(`${FOOTBALL_API_BASE}${endpoint}`, {
      headers: { 'x-apisports-key': FOOTBALL_API_KEY, 'x-rapidapi-host': 'v3.football.api-sports.io' },
      params,
    });
    return res.data.response || [];
  } catch (e) {
    console.error(`API error ${endpoint}:`, e.message);
    return [];
  }
}

// ── FONCTIONS AVEC CACHE ──────────────────────────────────
async function getStandingsCached(leagueId) {
  const key = `${leagueId}`;
  if (isCacheValid(cache.standings[key])) return cache.standings[key].data;
  const data = await footballAPI('/standings', { league: leagueId, season: 2025 });
  const standings = data?.[0]?.league?.standings?.[0] || [];
  cache.standings[key] = { data: standings, timestamp: Date.now() };
  return standings;
}

async function getTeamStatsCached(teamId, leagueId) {
  const key = `${teamId}_${leagueId}`;
  if (isCacheValid(cache.teamStats[key])) return cache.teamStats[key].data;
  const data = await footballAPI('/teams/statistics', { team: teamId, league: leagueId, season: 2025 });
  cache.teamStats[key] = { data, timestamp: Date.now() };
  return data;
}

async function getPlayersCached(teamId, leagueId) {
  const key = `${teamId}_${leagueId}`;
  if (isCacheValid(cache.players[key])) return cache.players[key].data;
  const data = await footballAPI('/players', { team: teamId, league: leagueId, season: 2025 });
  cache.players[key] = { data, timestamp: Date.now() };
  return data;
}

async function getNationalLeagueCached(teamId) {
  const key = `${teamId}`;
  if (isCacheValid(cache.natLeagues[key])) return cache.natLeagues[key].leagueId;
  const data = await footballAPI('/leagues', { team: teamId, season: 2025, type: 'League' });
  const priority = [39, 140, 135, 78, 61, 88, 94];
  const leagueIds = data.map(d => d.league?.id);
  let leagueId = null;
  for (const p of priority) { if (leagueIds.includes(p)) { leagueId = p; break; } }
  if (!leagueId) leagueId = data?.[0]?.league?.id || null;
  cache.natLeagues[key] = { leagueId, timestamp: Date.now() };
  return leagueId;
}

// ── PRECHARGEMENT CACHE (appelé 1x par jour) ─────────────
async function preloadCache() {
  const today = getTodayStr();
  if (cache.lastDate === today) {
    console.log('Cache déjà chargé pour aujourd\'hui');
    return;
  }
  console.log('Préchargement cache...');

  // Récupérer classements toutes ligues en parallèle
  await Promise.all(LEAGUES.map(l => getStandingsCached(l.id)));
  console.log('Cache classements OK');

  // Récupérer matchs du jour pour précharger stats équipes
  const today_fixtures = [];
  for (const league of LEAGUES) {
    const fixtures = await footballAPI('/fixtures', { date: today, league: league.id, season: 2025 });
    today_fixtures.push(...fixtures.map(f => ({ ...f, leagueId: league.id })));
  }

  // Précharger stats équipes en parallèle (max 5 à la fois)
  const teamPairs = [];
  for (const f of today_fixtures) {
    if (f.teams?.home) teamPairs.push({ teamId: f.teams.home.id, leagueId: f.leagueId });
    if (f.teams?.away) teamPairs.push({ teamId: f.teams.away.id, leagueId: f.leagueId });
  }

  // Dédupliquer
  const seen = new Set();
  const uniquePairs = teamPairs.filter(p => {
    const k = `${p.teamId}_${p.leagueId}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });

  // Charger par batch de 5
  for (let i = 0; i < uniquePairs.length; i += 5) {
    const batch = uniquePairs.slice(i, i + 5);
    await Promise.all(batch.map(p => Promise.all([
      getTeamStatsCached(p.teamId, p.leagueId),
      getPlayersCached(p.teamId, p.leagueId),
    ])));
  }

  // Pour matchs européens : précharger aussi stats nationales
  const euroFixtures = today_fixtures.filter(f => EURO_LEAGUES.includes(f.leagueId));
  for (const f of euroFixtures) {
    const [hNatId, aNatId] = await Promise.all([
      getNationalLeagueCached(f.teams?.home?.id),
      getNationalLeagueCached(f.teams?.away?.id),
    ]);
    if (hNatId) await Promise.all([
      getTeamStatsCached(f.teams.home.id, hNatId),
      getPlayersCached(f.teams.home.id, hNatId),
    ]);
    if (aNatId) await Promise.all([
      getTeamStatsCached(f.teams.away.id, aNatId),
      getPlayersCached(f.teams.away.id, aNatId),
    ]);
  }

  cache.lastDate = today;
  console.log(`Cache chargé ! ${uniquePairs.length} équipes, ${euroFixtures.length} matchs européens`);
}

// ── FORMAT JOUEURS ────────────────────────────────────────
function formatPlayers(players) {
  return players.slice(0, 5).map(p => {
    const s = p.statistics?.[0];
    return `${p.player?.name}(${s?.goals?.total||0}buts,${s?.goals?.assists||0}passes,${s?.games?.appearences||0}matchs)`;
  }).join(' | ') || '?';
}

// ── COLLECTE DONNÉES MATCH (ultra rapide grâce au cache) ─
async function collectMatchData(fixture, leagueId, leagueName, standings) {
  const hTeam = fixture.teams?.home;
  const aTeam = fixture.teams?.away;
  const fixtureId = fixture.fixture?.id;
  if (!hTeam || !aTeam) return null;

  const hTime = fixture.fixture?.date
    ? new Date(fixture.fixture.date).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    : '?';
  const isEuropean = EURO_LEAGUES.includes(leagueId);

  // Tout depuis le cache (instantané) + lineups/injuries en temps réel
  const [hStats, aStats, hPlayers, aPlayers, injuries, h2h, lineups] = await Promise.all([
    getTeamStatsCached(hTeam.id, leagueId),
    getTeamStatsCached(aTeam.id, leagueId),
    getPlayersCached(hTeam.id, leagueId),
    getPlayersCached(aTeam.id, leagueId),
    footballAPI('/injuries', { fixture: fixtureId }),           // temps réel
    footballAPI('/fixtures/headtohead', { h2h: `${hTeam.id}-${aTeam.id}`, last: 5 }),
    footballAPI('/fixtures/lineups', { fixture: fixtureId }),   // temps réel
  ]);

  // Stats nationales depuis cache (pour matchs européens)
  let hNatSection = '', aNatSection = '';
  if (isEuropean) {
    const [hNatId, aNatId] = await Promise.all([
      getNationalLeagueCached(hTeam.id),
      getNationalLeagueCached(aTeam.id),
    ]);
    if (hNatId) {
      const [hNatStats, hNatPlayers] = await Promise.all([
        getTeamStatsCached(hTeam.id, hNatId),
        getPlayersCached(hTeam.id, hNatId),
      ]);
      hNatSection = `${hTeam.name} en championnat: ${hNatStats?.goals?.for?.average?.home||'?'}buts/match, joueurs: ${formatPlayers(hNatPlayers)}`;
    }
    if (aNatId) {
      const [aNatStats, aNatPlayers] = await Promise.all([
        getTeamStatsCached(aTeam.id, aNatId),
        getPlayersCached(aTeam.id, aNatId),
      ]);
      aNatSection = `${aTeam.name} en championnat: ${aNatStats?.goals?.for?.average?.away||'?'}buts/match, joueurs: ${formatPlayers(aNatPlayers)}`;
    }
  }

  // Compositions officielles
  const hLineup = lineups.find(l => l.team?.id === hTeam.id);
  const aLineup = lineups.find(l => l.team?.id === aTeam.id);
  const hStarters = (hLineup?.startXI || []).map(p => p.player?.name).filter(Boolean);
  const aStarters = (aLineup?.startXI || []).map(p => p.player?.name).filter(Boolean);
  const hSubs = (hLineup?.substitutes || []).map(p => p.player?.name).filter(Boolean);
  const aSubs = (aLineup?.substitutes || []).map(p => p.player?.name).filter(Boolean);

  const lineupsSection = hStarters.length > 0 && aStarters.length > 0
    ? `COMPOSITIONS OFFICIELLES (priorité absolue):
${hTeam.name} TITULAIRES: ${hStarters.join(', ')}
${hTeam.name} REMPLAÇANTS: ${hSubs.join(', ')}
${aTeam.name} TITULAIRES: ${aStarters.join(', ')}
${aTeam.name} REMPLAÇANTS: ${aSubs.join(', ')}
⚠️ Propose UNIQUEMENT des joueurs dans les TITULAIRES`
    : 'COMPOSITIONS: Pas encore disponibles';

  const hStand = standings.find(s => s.team?.id === hTeam.id);
  const aStand = standings.find(s => s.team?.id === aTeam.id);

  const statsSection = `STATS:
${hTeam.name}: ${hStats?.goals?.for?.average?.home||'?'}buts/match, concède ${hStats?.goals?.against?.average?.home||'?'}/match
${aTeam.name}: ${aStats?.goals?.for?.average?.away||'?'}buts/match, concède ${aStats?.goals?.against?.average?.away||'?'}/match
${isEuropean && hNatSection ? `\nSTATS NATIONALES:\n${hNatSection}\n${aNatSection}` : ''}
JOUEURS ${hTeam.name}: ${formatPlayers(hPlayers)}
JOUEURS ${aTeam.name}: ${formatPlayers(aPlayers)}`;

  return {
    match: `${hTeam.name} vs ${aTeam.name}`,
    competition: leagueName,
    heure: hTime,
    domicile: hTeam.name,
    exterieur: aTeam.name,
    isEuropean,
    data: {
      classement: `${hTeam.name} ${hStand?.rank||'?'}e (${hStand?.points||'?'}pts, forme:${(hStand?.form||'').slice(-5)}) vs ${aTeam.name} ${aStand?.rank||'?'}e (${aStand?.points||'?'}pts, forme:${(aStand?.form||'').slice(-5)})`,
      statsSection,
      lineupsSection,
      blesses: injuries.slice(0,6).map(i=>`${i.player?.name}(${i.team?.name})`).join(', ')||'Aucune info',
      h2h: h2h.slice(0,5).map(m=>`${m.teams?.home?.name} ${m.goals?.home}-${m.goals?.away} ${m.teams?.away?.name}`).join(' | ')||'Pas de données',
      penaltys: `${hTeam.name} ${hStats?.penalty?.scored?.total||0}pen | ${aTeam.name} ${aStats?.penalty?.scored?.total||0}pen concédés`,
    }
  };
}

// ── CLAUDE ANALYSE ────────────────────────────────────────
async function analyzeWithClaude(matchData) {
  const prompt = `Tu es PicksAI, expert pronostics football. Analyse ce match et applique la Matrice F1→F14.

MATCH: ${matchData.match} | ${matchData.competition} | ${matchData.heure}
CLASSEMENT: ${matchData.data.classement}
${matchData.data.lineupsSection}
${matchData.data.statsSection}
BLESSÉS/SUSPENDUS: ${matchData.data.blesses}
H2H: ${matchData.data.h2h}
PENALTYS: ${matchData.data.penaltys}

MATRICE F1→F14:
F1[10pts,71%] Attaquant 3+buts/5matchs ET défense concède 1.8+/match
F2[9pts,68%] Top6 domicile vs 4 pires défenses, écart >8pts
F3[9pts,65%] Tireur penaltys vs équipe concédant 0.6+pen/match
F4[8pts,62%] Joueur à 1-2 buts d'un milestone (10,15,20 buts)
F5[8pts,61%] Attaquant rapide vs défenseur lent/âgé
F6[7pts,59%] xG >2.2 sur 5 matchs vs bloc bas fragile
F7[7pts,58%] Match fort enjeu (CL,EL,derby,relégation) + joueur en confiance
F8[6pts,74%] F1+F2 activés ensemble
F9[8pts,64%] H2H très favorable pour le joueur ciblé
F10[6pts,61%] Adversaire fatigué 3+matchs/10jours
F11[7pts,63%] Adversaire en zone relégation ou très bas classé
F12[7pts,60%] Joueur retour blessure sous-estimé
F13[6pts,58%] Possession >60% vs bloc bas
F14[9pts,67%] Value bet: joueur sous-coté vs vraie probabilité

RÈGLES ABSOLUES:
❌ JAMAIS un défenseur ou gardien comme pick principal
❌ JAMAIS un joueur dans BLESSÉS/SUSPENDUS — vérifie EN PREMIER
❌ JAMAIS un joueur remplaçant ou absent des titulaires
❌ JAMAIS un joueur décédé, retraité ou transféré
❌ JAMAIS inventer un joueur — utilise uniquement les joueurs dans les données
✅ Uniquement attaquants, ailiers, milieux offensifs
✅ Priorité aux joueurs avec le plus de buts cette saison
✅ Si compositions dispo → utilise UNIQUEMENT les titulaires
✅ Joueur décisif = but OU passe décisive
✅ Score = somme poids × 10 | ROUGE ≥85 | ORANGE 70-84 | VERT 60-69

JSON UNIQUEMENT (pas de texte):
{"score_matriciel":85,"facteurs":["F1","F2","F7"],"alerte":"ROUGE","pick":{"joueur":"Prénom Nom","equipe":"Equipe","type":"Joueur décisif","prob":68,"cote_estimee":1.75,"raison":"Raison précise 2 phrases max avec stats"},"buteur_alternatif":{"joueur":"Prénom Nom","equipe":"Equipe","prob":45,"cote_estimee":2.20,"raison":"Raison courte"},"contexte":"1 phrase","score_prono":"2-1","valide":true}
Si score<60: {"valide":false,"score_matriciel":X,"raison_rejet":"explication"}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return { valide: false };
  } catch (e) {
    console.error('Claude error:', e.message);
    return { valide: false };
  }
}

// ── SCAN DU JOUR ──────────────────────────────────────────
app.get('/api/scan', async (req, res) => {
  try {
    const today = getTodayStr();

    // Précharger le cache si pas fait aujourd'hui
    await preloadCache();

    // Récupérer tous les matchs du jour (depuis cache fixtures)
    const allFixtures = [];
    for (const league of LEAGUES) {
      const data = await footballAPI('/fixtures', { date: today, league: league.id, season: 2025 });
      if (data.length > 0) allFixtures.push(...data.map(f => ({ ...f, leagueName: league.name, leagueId: league.id })));
    }

    if (allFixtures.length === 0) {
      return res.json({ picks: [], rejected: [], total_analyses: 0, date: new Date().toLocaleDateString('fr-FR') });
    }

    const picks = [];
    const rejected = [];

    // Analyser TOUS les matchs grâce au cache
    for (const fixture of allFixtures) {
      try {
        const leagueId = fixture.leagueId || fixture.league?.id;
        const standings = await getStandingsCached(leagueId);
        const matchData = await collectMatchData(fixture, leagueId, fixture.leagueName, standings);
        if (!matchData) continue;

        const analysis = await analyzeWithClaude(matchData);

        if (analysis.valide) {
          picks.push({
            ...analysis,
            match: matchData.match,
            competition: matchData.competition,
            heure: matchData.heure,
            domicile: matchData.domicile,
            exterieur: matchData.exterieur,
          });
        } else {
          rejected.push({
            match: matchData.match,
            competition: matchData.competition,
            heure: matchData.heure,
            score_matriciel: analysis.score_matriciel || 0,
            raison: analysis.raison_rejet || 'Score insuffisant',
          });
        }
      } catch (e) {
        console.error('Erreur match:', e.message);
      }
    }

    picks.sort((a, b) => b.score_matriciel - a.score_matriciel);
    rejected.sort((a, b) => b.score_matriciel - a.score_matriciel);

    res.json({
      date: new Date().toLocaleDateString('fr-FR'),
      total_analyses: allFixtures.length,
      picks,
      rejected,
      top_pick: picks[0] || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── RESET CACHE (forcer rechargement) ────────────────────
app.get('/api/reset-cache', (req, res) => {
  cache.lastDate = null;
  Object.keys(cache.standings).forEach(k => delete cache.standings[k]);
  Object.keys(cache.teamStats).forEach(k => delete cache.teamStats[k]);
  Object.keys(cache.players).forEach(k => delete cache.players[k]);
  Object.keys(cache.natLeagues).forEach(k => delete cache.natLeagues[k]);
  res.json({ status: 'Cache réinitialisé' });
});

// ── BACKTEST ──────────────────────────────────────────────
app.get('/api/backtest', async (req, res) => {
  const MISE = 100;
  const SEASON = 2024;
  const LEAGUES_BT = [
    { id: 61, name: 'Ligue 1' }, { id: 140, name: 'La Liga' },
    { id: 39, name: 'Premier League' }, { id: 135, name: 'Serie A' },
    { id: 78, name: 'Bundesliga' }, { id: 2, name: 'Champions League' },
  ];
  function calcScore(hStats, aStats, hStand, aStand) {
    const factors = []; let score = 0;
    const hGoals = parseFloat(hStats?.goals?.for?.average?.home) || 0;
    const aConceded = parseFloat(aStats?.goals?.against?.average?.away) || 0;
    const hRank = hStand?.rank || 99; const aRank = aStand?.rank || 99;
    const gap = (hStand?.points||0) - (aStand?.points||0);
    const recentW = ((hStand?.form||'').slice(-5).match(/W/g)||[]).length;
    const hWinRate = (hStats?.fixtures?.wins?.home||0) / (hStats?.fixtures?.played?.home||1);
    if (hGoals >= 1.8 && aConceded >= 1.5) { factors.push('F1'); score += 10; }
    if (hRank <= 6 && aRank >= 14 && gap >= 8) { factors.push('F2'); score += 9; }
    if (hGoals >= 2.0 && aConceded >= 1.3) { factors.push('F6'); score += 7; }
    if (recentW >= 3 && hRank <= 5) { factors.push('F7'); score += 7; }
    if (factors.includes('F1') && factors.includes('F2')) { factors.push('F8'); score += 6; }
    if (aRank >= 16) { factors.push('F11'); score += 7; }
    if (hWinRate >= 0.6 && aRank >= 12) { factors.push('F13'); score += 6; }
    const sm = score * 10;
    return { sm, factors, alerte: sm >= 85 ? 'ROUGE' : sm >= 70 ? 'ORANGE' : null };
  }
  const picksRouge = [], picksOrange = [];
  let totalAnalyses = 0, reqCount = 0;
  try {
    for (const league of LEAGUES_BT) {
      if (reqCount >= 180) break;
      const standings = await footballAPI('/standings', { league: league.id, season: SEASON }); reqCount++;
      const standList = standings?.[0]?.league?.standings?.[0] || [];
      const fixtures = await footballAPI('/fixtures', { league: league.id, season: SEASON, status: 'FT', last: 25 }); reqCount++;
      for (const fixture of fixtures.slice(0, 10)) {
        if (reqCount >= 180) break;
        const hTeam = fixture.teams?.home; const aTeam = fixture.teams?.away;
        if (!hTeam || !aTeam) continue;
        const [hStats, aStats] = await Promise.all([
          footballAPI('/teams/statistics', { team: hTeam.id, league: league.id, season: SEASON }),
          footballAPI('/teams/statistics', { team: aTeam.id, league: league.id, season: SEASON }),
        ]); reqCount += 2;
        const { sm, factors, alerte } = calcScore(hStats, aStats, standList.find(s=>s.team?.id===hTeam.id), standList.find(s=>s.team?.id===aTeam.id));
        totalAnalyses++;
        if (!alerte) continue;
        const hGoals = fixture.goals?.home || 0; const aGoals = fixture.goals?.away || 0;
        const validated = hGoals >= 2;
        const cote = alerte === 'ROUGE' ? 1.75 : 1.65;
        const gain = validated ? Math.round(MISE * (cote - 1)) : -MISE;
        const pick = { date: fixture.fixture?.date?.split('T')[0]||'?', match: `${hTeam.name} vs ${aTeam.name}`, competition: league.name, sm, alerte, factors, score: `${hGoals}-${aGoals}`, validated, cote, mise: MISE, gain };
        if (alerte === 'ROUGE') picksRouge.push(pick); else picksOrange.push(pick);
      }
    }
    function stats(picks) {
      if (!picks.length) return { total:0,wins:0,losses:0,winRate:0,profit:0,roi:0,bestStreak:0,worstStreak:0 };
      const wins = picks.filter(p=>p.validated).length;
      const profit = picks.reduce((a,p)=>a+p.gain,0);
      let best=0,cur=0,worst=0,curL=0;
      for (const p of picks) { if(p.validated){cur++;curL=0;best=Math.max(best,cur);}else{curL++;cur=0;worst=Math.max(worst,curL);} }
      return { total:picks.length,wins,losses:picks.length-wins,winRate:Math.round(wins/picks.length*100),profit,roi:Math.round(profit/(picks.length*MISE)*100),bestStreak:best,worstStreak:worst };
    }
    const sR=stats(picksRouge), sO=stats(picksOrange);
    const totalProfit=sR.profit+sO.profit, totalPicks=sR.total+sO.total;
    res.json({ meta:{totalAnalyses,reqCount,saison:SEASON,mise:MISE}, rouge:{stats:sR,picks:picksRouge}, orange:{stats:sO,picks:picksOrange}, global:{totalPicks,totalProfit,globalWR:totalPicks>0?Math.round(((sR.wins+sO.wins)/totalPicks)*100):0,globalROI:totalPicks>0?Math.round((totalProfit/(totalPicks*MISE))*100):0} });
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', name: 'PicksAI', cacheDate: cache.lastDate }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend/index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PicksAI running on port ${PORT}`));
