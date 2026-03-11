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

// Positions défensives à exclure des picks
const DEFENSIVE_POSITIONS = ['G', 'GK', 'D', 'CB', 'LB', 'RB', 'WB', 'SW', 'Goalkeeper', 'Defender'];

// ── CACHE ─────────────────────────────────────────────────
const cache = {
  standings: {}, teamStats: {}, players: {}, natLeagues: {}, lastDate: null,
};
const CACHE_TTL = 6 * 60 * 60 * 1000;

function isCacheValid(e) { return e && Date.now() - e.timestamp < CACHE_TTL; }
function getTodayStr() { return new Date().toISOString().split('T')[0]; }

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

// ── CACHE FUNCTIONS ───────────────────────────────────────
async function getStandingsCached(leagueId) {
  const k = `${leagueId}`;
  if (isCacheValid(cache.standings[k])) return cache.standings[k].data;
  const data = await footballAPI('/standings', { league: leagueId, season: 2025 });
  const s = data?.[0]?.league?.standings?.[0] || [];
  cache.standings[k] = { data: s, timestamp: Date.now() };
  return s;
}

async function getTeamStatsCached(teamId, leagueId) {
  const k = `${teamId}_${leagueId}`;
  if (isCacheValid(cache.teamStats[k])) return cache.teamStats[k].data;
  const data = await footballAPI('/teams/statistics', { team: teamId, league: leagueId, season: 2025 });
  cache.teamStats[k] = { data, timestamp: Date.now() };
  return data;
}

async function getPlayersCached(teamId, leagueId) {
  const k = `${teamId}_${leagueId}`;
  if (isCacheValid(cache.players[k])) return cache.players[k].data;
  const data = await footballAPI('/players', { team: teamId, league: leagueId, season: 2025 });
  cache.players[k] = { data, timestamp: Date.now() };
  return data;
}

async function getNatLeagueCached(teamId) {
  const k = `${teamId}`;
  if (isCacheValid(cache.natLeagues[k])) return cache.natLeagues[k].leagueId;
  const data = await footballAPI('/leagues', { team: teamId, season: 2025, type: 'League' });
  const priority = [39, 140, 135, 78, 61, 88, 94];
  const ids = data.map(d => d.league?.id);
  let lid = null;
  for (const p of priority) { if (ids.includes(p)) { lid = p; break; } }
  if (!lid) lid = data?.[0]?.league?.id || null;
  cache.natLeagues[k] = { leagueId: lid, timestamp: Date.now() };
  return lid;
}

// ── PRELOAD CACHE ─────────────────────────────────────────
async function preloadCache() {
  const today = getTodayStr();
  if (cache.lastDate === today) return;
  console.log('Préchargement cache...');
  await Promise.all(LEAGUES.map(l => getStandingsCached(l.id)));

  const fixtures = [];
  for (const league of LEAGUES) {
    const data = await footballAPI('/fixtures', { date: today, league: league.id, season: 2025 });
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
    const batch = pairs.slice(i, i + 5);
    await Promise.all(batch.map(p => Promise.all([
      getTeamStatsCached(p.teamId, p.leagueId),
      getPlayersCached(p.teamId, p.leagueId),
    ])));
  }

  // Stats nationales pour matchs européens
  const euroF = fixtures.filter(f => EURO_LEAGUES.includes(f.leagueId));
  for (const f of euroF) {
    const [hId, aId] = await Promise.all([getNatLeagueCached(f.teams?.home?.id), getNatLeagueCached(f.teams?.away?.id)]);
    if (hId) await Promise.all([getTeamStatsCached(f.teams.home.id, hId), getPlayersCached(f.teams.home.id, hId)]);
    if (aId) await Promise.all([getTeamStatsCached(f.teams.away.id, aId), getPlayersCached(f.teams.away.id, aId)]);
  }

  cache.lastDate = today;
  console.log(`Cache OK — ${pairs.length} équipes, ${euroF.length} matchs européens`);
}

// ── FILTRE DÉFENSEURS ─────────────────────────────────────
// Retourne uniquement les joueurs offensifs (attaquants + milieux)
function filterOffensivePlayers(players) {
  return players.filter(p => {
    const pos = (p.statistics?.[0]?.games?.position || p.player?.position || '').trim();

    // ❌ Exclure UNIQUEMENT les défenseurs et gardiens certains
    // On laisse passer tout le reste — Claude vérifie ensuite
    if (pos === 'G' || pos === 'Goalkeeper') return false;
    if (pos === 'D' || pos === 'Defender') return false;

    // ✅ Tout le reste passe (F, M, positions vides, positions inconnues)
    // Claude recevra la position dans le prompt et validera lui-même
    return true;
  });
}

// ── CALCUL SCORE MATRICIEL EN JS PUR ─────────────────────
// Résultat identique à chaque scan sur les mêmes données
function calcMatrixScore(hStats, aStats, hStand, aStand, h2h, injuries, isEuropean, leagueId) {
  const factors = [];
  let score = 0;

  const hGoalsFor   = parseFloat(hStats?.goals?.for?.average?.home)    || 0;
  const aGoalsAgainst = parseFloat(aStats?.goals?.against?.average?.away) || 0;
  const hRank  = hStand?.rank  || 99;
  const aRank  = aStand?.rank  || 99;
  const hPts   = hStand?.points || 0;
  const aPts   = aStand?.points || 0;
  const gap    = hPts - aPts;
  const hForm  = (hStand?.form || '').slice(-5);
  const hWins  = (hForm.match(/W/g) || []).length;
  const hWinRate = (hStats?.fixtures?.wins?.home || 0) / Math.max(hStats?.fixtures?.played?.home || 1, 1);
  const hPenScored   = hStats?.penalty?.scored?.total   || 0;
  const aPenConceded = aStats?.penalty?.missed?.total   || 0;

  // Compter victoires H2H pour l'équipe domicile
  const h2hWins = (h2h || []).filter(m => {
    const hg = m.goals?.home || 0;
    const ag = m.goals?.away || 0;
    return hg > ag;
  }).length;

  // Vérifier blessés clés adverses
  const injuredCount = (injuries || []).filter(i => i.team?.id === aStand?.team?.id).length;

  // F1 — Attaque prolifique vs défense poreuse
  if (hGoalsFor >= 1.8 && aGoalsAgainst >= 1.5) { factors.push('F1'); score += 10; }

  // F2 — Top6 domicile vs bas du tableau
  if (hRank <= 6 && aRank >= 14 && gap >= 8) { factors.push('F2'); score += 9; }

  // F3 — Tireur penaltys
  if (hPenScored >= 3 && aPenConceded >= 2) { factors.push('F3'); score += 9; }

  // F5 — Attaque rapide (approx: top 6 attaque vs mauvaise défense)
  if (hGoalsFor >= 2.0 && aGoalsAgainst >= 1.8) { factors.push('F5'); score += 8; }

  // F6 — xG fort (approx via moyenne buts)
  if (hGoalsFor >= 2.2 && aGoalsAgainst >= 1.3) { factors.push('F6'); score += 7; }

  // F7 — Match fort enjeu + équipe en forme
  if (isEuropean && hWins >= 3) { factors.push('F7'); score += 7; }
  else if (!isEuropean && hWins >= 4 && hRank <= 5) { factors.push('F7'); score += 7; }

  // F8 — Combo F1+F2
  if (factors.includes('F1') && factors.includes('F2')) { factors.push('F8'); score += 6; }

  // F9 — H2H favorable
  if (h2hWins >= 3) { factors.push('F9'); score += 8; }
  else if (h2hWins >= 2) { factors.push('F9'); score += 4; }

  // F10 — Adversaire fatigué (approx: pas de données précises, on skip)

  // F11 — Adversaire en zone relégation
  if (aRank >= 16) { factors.push('F11'); score += 7; }
  else if (aRank >= 13) { factors.push('F11'); score += 3; }

  // F12 — Blessés adverses clés
  if (injuredCount >= 3) { factors.push('F12'); score += 7; }

  // F13 — Possession dominante
  if (hWinRate >= 0.65 && aRank >= 12) { factors.push('F13'); score += 6; }

  // F14 — Value bet (écart classement + forme)
  if (gap >= 15 && hWins >= 3) { factors.push('F14'); score += 9; }
  else if (gap >= 10 && hWins >= 2) { factors.push('F14'); score += 5; }

  const scoreMatriciel = Math.round(score * 2.5); // normalisé sur ~100
  let alerte = null;
  if (scoreMatriciel >= 85) alerte = 'ROUGE';
  else if (scoreMatriciel >= 70) alerte = 'ORANGE';
  else if (scoreMatriciel >= 60) alerte = 'VERT';

  return { scoreMatriciel, factors, alerte };
}

// ── CALCUL SCORE FINAL (matriciel + joueur individuel) ───
function calcConfianceScore(hStats, aStats, hStand, aStand, h2h, isEuropean, pickTeamIsHome, playerStats) {
  let c = 0;

  // ── CONTEXTE MATCH ────────────────────────────────────
  const aGoalsAgainst = parseFloat(aStats?.goals?.against?.average?.away) || 0;
  const hWins = ((hStand?.form || '').slice(-5).match(/W/g) || []).length;
  const h2hWins = (h2h || []).filter(m => (m.goals?.home || 0) > (m.goals?.away || 0)).length;
  const hRank = hStand?.rank || 99;
  const aRank = aStand?.rank || 99;

  if (pickTeamIsHome)            c += 15;  // domicile
  if (aGoalsAgainst >= 2.0)      c += 15;  // défense très poreuse
  else if (aGoalsAgainst >= 1.5) c += 8;   // défense fragile
  if (h2hWins >= 3)              c += 10;  // H2H très favorable
  else if (h2hWins >= 2)         c += 5;
  if (isEuropean)                c += 5;   // enjeu CL/EL
  if (hWins >= 4)                c += 10;  // équipe en feu
  else if (hWins >= 3)           c += 5;
  if (aRank >= 20)               c += 12;  // adversaire très faible
  else if (aRank >= 15)          c += 8;   // adversaire faible
  if (hRank <= 4)                c += 5;   // top 4
  if (!pickTeamIsHome && isEuropean) c -= 10; // déplacement hostile CL/EL

  // ── QUALITÉ INDIVIDUELLE DU JOUEUR ───────────────────
  if (playerStats) {
    const goals = playerStats.goals || 0;
    const assists = playerStats.assists || 0;
    const apps = playerStats.apps || 1;
    const goalsPerMatch = goals / apps;

    // Ratio buts/match — le critère le plus important
    if (goalsPerMatch >= 0.6)      c += 20;  // 0.6+ buts/match = élite
    else if (goalsPerMatch >= 0.45) c += 15; // 0.45+ = très bon
    else if (goalsPerMatch >= 0.3)  c += 10; // 0.3+ = bon
    else if (goalsPerMatch >= 0.15) c += 5;  // 0.15+ = correct

    // Volume de buts absolus
    if (goals >= 20)      c += 10;
    else if (goals >= 15) c += 7;
    else if (goals >= 10) c += 4;
    else if (goals >= 5)  c += 2;

    // Passes décisives (contribution offensive)
    if (assists >= 8)     c += 5;
    else if (assists >= 5) c += 3;
    else if (assists >= 3) c += 1;
  }

  return Math.min(100, Math.max(0, c));
}

// ── CLAUDE : UNIQUEMENT CHOISIR LE MEILLEUR JOUEUR ───────
async function pickBestPlayer(matchInfo, offensivePlayers, context) {
  if (offensivePlayers.length === 0) return null;

  const playerList = offensivePlayers.map(p => {
    const s = p.statistics?.[0];
    const pos = s?.games?.position || p.player?.position || '?';
    return `- ${p.player?.name} | POS:${pos} | ${s?.goals?.total||0} buts | ${s?.goals?.assists||0} passes | ${s?.games?.appearences||0} matchs`;
  }).join('\n');

  const prompt = `Tu es un expert football avec une connaissance parfaite des joueurs. Parmi ces joueurs TITULAIRES, choisis le MEILLEUR PICK offensif pour ce match.

MATCH: ${matchInfo.match} | ${matchInfo.competition} | ${matchInfo.heure}
CONTEXTE: ${context}

JOUEURS TITULAIRES DISPONIBLES (position API + stats saison):
${playerList}

RÈGLES STRICTES — RESPECTE-LES ABSOLUMENT:
1. ❌ JAMAIS un défenseur/gardien (POS: D, G, CB, LB, RB, GK)
2. ❌ JAMAIS un joueur avec 0 but ET 0 passe ET moins de 5 matchs — données insuffisantes
3. ❌ JAMAIS un milieu défensif (tu connais les joueurs : N'Golo Kanté, Casemiro, Simões, Rodri = milieux défensifs → EXCLUS)
4. ✅ Tu connais TOUS les joueurs de football — utilise tes connaissances réelles pour identifier leur vrai poste
5. ✅ Si les stats semblent incomplètes (ex: Suárez avec 0 but alors qu'il en a 20+ en championnat) → choisis-le quand même si tu sais qu'il est attaquant prolifique
6. ✅ Priorité absolue: attaquant de pointe connu > ailier connu > milieu offensif connu
7. ✅ Critères de sélection: ratio buts/match réel (championnat inclus) > buts totaux > passes
8. ✅ Si tu n'as AUCUN joueur offensif fiable dans la liste → réponds avec valide:false

Réponds UNIQUEMENT en JSON:
{"joueur":"Prénom Nom","equipe":"${matchInfo.domicile} ou ${matchInfo.exterieur}","type":"Joueur décisif","prob":72,"cote_estimee":1.65,"raison":"2 phrases max avec stats concrètes","buteur_alt":{"joueur":"Prénom Nom","equipe":"equipe","prob":45,"cote_estimee":2.20,"raison":"1 phrase"}}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = response.content[0].text;
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    return null;
  } catch (e) {
    console.error('Claude error:', e.message);
    return null;
  }
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

  // Stats nationales pour matchs européens
  let hNatPlayers = [], aNatPlayers = [];
  if (isEuropean) {
    const [hNatId, aNatId] = await Promise.all([getNatLeagueCached(hTeam.id), getNatLeagueCached(aTeam.id)]);
    if (hNatId) hNatPlayers = await getPlayersCached(hTeam.id, hNatId);
    if (aNatId) aNatPlayers = await getPlayersCached(aTeam.id, aNatId);
  }

  const hStand = standings.find(s => s.team?.id === hTeam.id);
  const aStand = standings.find(s => s.team?.id === aTeam.id);

  // Compositions officielles
  const hLineup = lineups.find(l => l.team?.id === hTeam.id);
  const aLineup = lineups.find(l => l.team?.id === aTeam.id);
  const hStarters = (hLineup?.startXI || []).map(p => p.player?.name?.toLowerCase()).filter(Boolean);
  const aStarters = (aLineup?.startXI || []).map(p => p.player?.name?.toLowerCase()).filter(Boolean);
  const composAvailable = hStarters.length > 0 && aStarters.length > 0;

  // Fusionner stats saison + stats nationales pour matchs euro
  const mergedHPlayers = isEuropean ? mergePlayerStats(hPlayers, hNatPlayers) : hPlayers;
  const mergedAPlayers = isEuropean ? mergePlayerStats(aPlayers, aNatPlayers) : aPlayers;

  // Filtrer uniquement les joueurs offensifs
  let hOffensive = filterOffensivePlayers(mergedHPlayers);
  let aOffensive = filterOffensivePlayers(mergedAPlayers);

  // Si compositions dispo → filtrer uniquement les titulaires
  if (composAvailable) {
    hOffensive = hOffensive.filter(p => hStarters.includes(p.player?.name?.toLowerCase()));
    aOffensive = aOffensive.filter(p => aStarters.includes(p.player?.name?.toLowerCase()));
  }

  // Calculer score matriciel en JS pur (stable, identique à chaque scan)
  const { scoreMatriciel, factors, alerte } = calcMatrixScore(
    hStats, aStats, hStand, aStand, h2h, injuries, isEuropean, leagueId
  );

  const blessesStr = injuries.slice(0,6).map(i => `${i.player?.name}(${i.team?.name})`).join(', ') || 'Aucune info';
  const h2hStr = h2h.slice(0,5).map(m => `${m.teams?.home?.name} ${m.goals?.home}-${m.goals?.away} ${m.teams?.away?.name}`).join(' | ') || 'Pas de données';
  const context = `${hTeam.name} ${hStand?.rank||'?'}e (${hStand?.points||'?'}pts, forme:${(hStand?.form||'').slice(-5)}) vs ${aTeam.name} ${aStand?.rank||'?'}e (${aStand?.points||'?'}pts). H2H: ${h2hStr}. Blessés: ${blessesStr}`;

  return {
    match: `${hTeam.name} vs ${aTeam.name}`,
    competition: leagueName,
    heure: hTime,
    domicile: hTeam.name,
    exterieur: aTeam.name,
    isEuropean,
    scoreMatriciel,
    factors,
    alerte,
    hOffensive,
    aOffensive,
    context,
    raw: { hStats, aStats, hStand, aStand, h2h },
  };
}

// ── FUSION STATS JOUEURS (saison nationale + européenne) ──
function mergePlayerStats(euroPlayers, natPlayers) {
  if (!natPlayers || natPlayers.length === 0) return euroPlayers;
  const map = new Map();
  for (const p of natPlayers) map.set(p.player?.id, p);
  return euroPlayers.map(p => {
    const nat = map.get(p.player?.id);
    if (!nat) return p;
    const es = p.statistics?.[0];
    const ns = nat.statistics?.[0];
    // Prendre le max des buts/passes entre euro et national
    return {
      ...p,
      statistics: [{
        ...es,
        goals: {
          total: Math.max(es?.goals?.total || 0, ns?.goals?.total || 0),
          assists: Math.max(es?.goals?.assists || 0, ns?.goals?.assists || 0),
        },
        games: {
          ...es?.games,
          appearences: Math.max(es?.games?.appearences || 0, ns?.games?.appearences || 0),
          position: es?.games?.position || ns?.games?.position,
        }
      }]
    };
  });
}

// ── SCAN DU JOUR ──────────────────────────────────────────
app.get('/api/scan', async (req, res) => {
  try {
    const today = getTodayStr();
    await preloadCache();

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

    for (const fixture of allFixtures) {
      try {
        const leagueId = fixture.leagueId || fixture.league?.id;
        const standings = await getStandingsCached(leagueId);
        const matchData = await collectMatchData(fixture, leagueId, fixture.leagueName, standings);
        if (!matchData) continue;

        // Score matriciel calculé en JS — si pas assez élevé, on rejette sans appeler Claude
        if (!matchData.alerte) {
          rejected.push({
            match: matchData.match,
            competition: matchData.competition,
            heure: matchData.heure,
            score_matriciel: matchData.scoreMatriciel,
            raison: `Score ${matchData.scoreMatriciel} insuffisant (min 60)`,
          });
          continue;
        }

        // Rassembler les joueurs offensifs des deux équipes
        const allOffensive = [...matchData.hOffensive, ...matchData.aOffensive];
        if (allOffensive.length === 0) {
          rejected.push({ match: matchData.match, competition: matchData.competition, heure: matchData.heure, score_matriciel: matchData.scoreMatriciel, raison: 'Aucun joueur offensif trouvé' });
          continue;
        }

        // Claude choisit uniquement parmi les joueurs offensifs filtrés
        const pickData = await pickBestPlayer(matchData, allOffensive, matchData.context);
        if (!pickData || pickData.valide === false) {
          rejected.push({ match: matchData.match, competition: matchData.competition, heure: matchData.heure, score_matriciel: matchData.scoreMatriciel, raison: pickData?.raison || 'Aucun joueur offensif fiable trouvé' });
          continue;
        }

        // Calcul confiance score côté serveur + qualité joueur
        const pickTeamIsHome = pickData.equipe === matchData.domicile;
        const { hStats, aStats, hStand, aStand, h2h } = matchData.raw;

        // Trouver les stats du joueur sélectionné
        const allPlayers = [...matchData.hOffensive, ...matchData.aOffensive];
        const selectedPlayer = allPlayers.find(p =>
          p.player?.name?.toLowerCase().includes(pickData.joueur?.toLowerCase().split(' ').pop() || '') ||
          pickData.joueur?.toLowerCase().includes(p.player?.name?.toLowerCase().split(' ').pop() || '')
        );
        const playerStats = selectedPlayer ? {
          goals: selectedPlayer.statistics?.[0]?.goals?.total || 0,
          assists: selectedPlayer.statistics?.[0]?.goals?.assists || 0,
          apps: selectedPlayer.statistics?.[0]?.games?.appearences || 1,
        } : null;

        const confianceScore = calcConfianceScore(hStats, aStats, hStand, aStand, h2h, matchData.isEuropean, pickTeamIsHome, playerStats);

        const buteurAlt = pickData.buteur_alt ? {
          joueur: pickData.buteur_alt.joueur,
          equipe: pickData.buteur_alt.equipe,
          prob: pickData.buteur_alt.prob,
          cote_estimee: pickData.buteur_alt.cote_estimee,
          raison: pickData.buteur_alt.raison,
        } : null;

        const scoreTotal = matchData.scoreMatriciel + confianceScore;

        picks.push({
          score_matriciel: matchData.scoreMatriciel,
          confiance_score: confianceScore,
          score_total: scoreTotal,
          facteurs: matchData.factors,
          alerte: matchData.alerte,
          pick: {
            joueur: pickData.joueur,
            equipe: pickData.equipe,
            type: pickData.type || 'Joueur décisif',
            prob: pickData.prob,
            cote_estimee: pickData.cote_estimee,
            raison: pickData.raison,
          },
          buteur_alternatif: buteurAlt,
          contexte: matchData.context.split('.')[0],
          match: matchData.match,
          competition: matchData.competition,
          heure: matchData.heure,
          domicile: matchData.domicile,
          exterieur: matchData.exterieur,
        });

      } catch (e) {
        console.error('Erreur match:', e.message);
      }
    }

    // Tri par score_total (matriciel + qualité joueur) — STABLE et DETERMINISTE
    picks.sort((a, b) => (b.score_total || 0) - (a.score_total || 0));
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

// ── RESET CACHE ───────────────────────────────────────────
app.get('/api/reset-cache', (req, res) => {
  cache.lastDate = null;
  ['standings','teamStats','players','natLeagues'].forEach(k => { cache[k] = {}; });
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
        const hStand = standList.find(s => s.team?.id === hTeam.id);
        const aStand = standList.find(s => s.team?.id === aTeam.id);
        const { scoreMatriciel: sm, factors, alerte } = calcMatrixScore(hStats, aStats, hStand, aStand, [], [], false, league.id);
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
