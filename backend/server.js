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
  { id: 61, name: 'Ligue 1' },
  { id: 140, name: 'La Liga' },
  { id: 39, name: 'Premier League' },
  { id: 135, name: 'Serie A' },
  { id: 78, name: 'Bundesliga' },
  { id: 2, name: 'Champions League' },
  { id: 3, name: 'Europa League' },
];

async function footballAPI(endpoint, params = {}) {
  await sleep(300);
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

async function getFixturesToday() {
  const today = new Date().toISOString().split('T')[0];
  const fixtures = [];
  for (const league of LEAGUES) {
    const data = await footballAPI('/fixtures', { date: today, league: league.id, season: 2025 });
    if (data.length > 0) fixtures.push(...data.map(f => ({ ...f, leagueName: league.name })));
  }
  return fixtures;
}

async function getTeamStats(teamId, leagueId) {
  return await footballAPI('/teams/statistics', { team: teamId, league: leagueId, season: 2025 });
}

async function getTopPlayers(teamId, leagueId) {
  const data = await footballAPI('/players', { team: teamId, league: leagueId, season: 2025 });
  return data.slice(0, 5);
}

async function getInjuries(fixtureId) {
  return await footballAPI('/injuries', { fixture: fixtureId });
}

async function getH2H(team1, team2) {
  return await footballAPI('/fixtures/headtohead', { h2h: `${team1}-${team2}`, last: 5 });
}

async function getStandings(leagueId) {
  const data = await footballAPI('/standings', { league: leagueId, season: 2025 });
  if (data.length > 0 && data[0].league) return data[0].league.standings[0] || [];
  return [];
}

async function analyzeWithClaude(matchData) {
  const prompt = `Tu es PicksAI expert football. Analyse ce match et retourne UNIQUEMENT un JSON valide sans texte avant ou après.

MATCH: ${matchData.home} vs ${matchData.away} | ${matchData.league} | ${matchData.time}
Classement: ${matchData.home} ${matchData.homeRank}e (${matchData.homePoints}pts) vs ${matchData.away} ${matchData.awayRank}e (${matchData.awayPoints}pts)
Buts marqués/match: ${matchData.home} ${matchData.homeGoalsAvg} | ${matchData.away} ${matchData.awayGoalsAvg}
Buts concédés/match: ${matchData.home} ${matchData.homeConcededAvg} | ${matchData.away} ${matchData.awayConcededAvg}
Joueurs clés domicile: ${matchData.homePlayers}
Joueurs clés extérieur: ${matchData.awayPlayers}
Blessés/suspendus: ${matchData.injuries}
H2H: ${matchData.h2h}

MATRICE F1-F14:
F1[10pts,71%]: Attaquant 3+buts/5matchs + défense concède 1.8+/match
F2[9pts,68%]: Top6 domicile vs 4 pires défenses écart >8pts
F3[9pts,65%]: Tireur penaltys vs équipe concédant 0.6+pen/match
F4[8pts,62%]: Joueur à 1-2 buts d'un milestone
F5[8pts,61%]: Attaquant rapide vs défenseur lent
F6[7pts,59%]: xG >2.2 vs bloc bas fragile
F7[7pts,58%]: Match fort enjeu + joueur en confiance
F8[6pts,74%]: F1+F2 réunis
F9[8pts,64%]: H2H favorable joueur ciblé
F10[6pts,61%]: Adversaire fatigué 3+matchs/10jours
F11[7pts,63%]: Adversaire en zone relégation
F12[7pts,60%]: Retour blessure sous-coté
F13[6pts,58%]: Possession >60% vs bloc bas
F14[9pts,67%]: Value bet cote sous-évaluée

Score = somme poids x 10. Retourne valide:true seulement si score >= 60.

JSON exact:
{"score_matriciel":85,"facteurs":["F1","F2"],"alerte":"ROUGE","pick":{"joueur":"Nom","equipe":"Equipe","type":"Joueur décisif","prob":65,"cote_estimee":1.75,"raison":"Raison courte"},"buteur_alternatif":{"joueur":"Nom","equipe":"Equipe","prob":45,"cote_estimee":2.20,"raison":"Raison"},"contexte":"Contexte 1 phrase","score_prono":"2-0","valide":true}

Si score < 60: {"valide":false}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600,
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
    const fixtures = await getFixturesToday();
    if (fixtures.length === 0) return res.json({ picks: [], total_analyses: 0 });
    const picks = [];
    const toAnalyze = fixtures.slice(0, 8);
    for (const fixture of toAnalyze) {
      try {
        const hTeam = fixture.teams?.home;
        const aTeam = fixture.teams?.away;
        const leagueId = fixture.league?.id;
        const fixtureId = fixture.fixture?.id;
        if (!hTeam || !aTeam) continue;
        const [hStats, aStats, injuries, h2h, standings] = await Promise.all([
          getTeamStats(hTeam.id, leagueId),
          getTeamStats(aTeam.id, leagueId),
          getInjuries(fixtureId),
          getH2H(hTeam.id, aTeam.id),
          getStandings(leagueId),
        ]);
        const hRank = standings.findIndex(s => s.team?.id === hTeam.id) + 1 || '?';
        const aRank = standings.findIndex(s => s.team?.id === aTeam.id) + 1 || '?';
        const hPts = standings.find(s => s.team?.id === hTeam.id)?.points || '?';
        const aPts = standings.find(s => s.team?.id === aTeam.id)?.points || '?';
        const [hPlayers, aPlayers] = await Promise.all([getTopPlayers(hTeam.id, leagueId), getTopPlayers(aTeam.id, leagueId)]);
        const analysis = await analyzeWithClaude({
          home: hTeam.name, away: aTeam.name, league: fixture.leagueName,
          time: fixture.fixture?.date ? new Date(fixture.fixture.date).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '?',
          homeRank: hRank, awayRank: aRank, homePoints: hPts, awayPoints: aPts,
          homeGoalsAvg: hStats?.goals?.for?.average?.home || '?',
          awayGoalsAvg: aStats?.goals?.for?.average?.away || '?',
          homeConcededAvg: hStats?.goals?.against?.average?.home || '?',
          awayConcededAvg: aStats?.goals?.against?.average?.away || '?',
          injuries: injuries.slice(0, 4).map(i => `${i.player?.name}(${i.team?.name})`).join(', ') || 'Aucune',
          homePlayers: hPlayers.slice(0, 3).map(p => `${p.player?.name}(${p.statistics?.[0]?.goals?.total || 0}buts)`).join(', ') || '?',
          awayPlayers: aPlayers.slice(0, 3).map(p => `${p.player?.name}(${p.statistics?.[0]?.goals?.total || 0}buts)`).join(', ') || '?',
          h2h: h2h.slice(0, 3).map(m => `${m.teams?.home?.name} ${m.goals?.home}-${m.goals?.away} ${m.teams?.away?.name}`).join(' | ') || 'Pas de données',
        });
        if (analysis.valide) {
          picks.push({ ...analysis, match: `${hTeam.name} vs ${aTeam.name}`, competition: fixture.leagueName,
            heure: fixture.fixture?.date ? new Date(fixture.fixture.date).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '?',
            domicile: hTeam.name, exterieur: aTeam.name });
        }
      } catch (e) { console.error('Erreur match:', e.message); }
    }
    picks.sort((a, b) => b.score_matriciel - a.score_matriciel);
    res.json({ date: new Date().toLocaleDateString('fr-FR'), total_analyses: toAnalyze.length, picks, top_pick: picks[0] || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── BACKTEST ──────────────────────────────────────────────
app.get('/api/backtest', async (req, res) => {
  const MISE = 100;
  const SEASON = 2024;
  const LEAGUES_BT = [
    { id: 61, name: 'Ligue 1' },
    { id: 140, name: 'La Liga' },
    { id: 39, name: 'Premier League' },
    { id: 135, name: 'Serie A' },
    { id: 78, name: 'Bundesliga' },
    { id: 2, name: 'Champions League' },
  ];

  function calcScore(hStats, aStats, hStand, aStand) {
    const factors = []; let score = 0;
    const hGoals = parseFloat(hStats?.goals?.for?.average?.home) || 0;
    const aConceded = parseFloat(aStats?.goals?.against?.average?.away) || 0;
    const hRank = hStand?.rank || 99;
    const aRank = aStand?.rank || 99;
    const hPts = hStand?.points || 0;
    const aPts = aStand?.points || 0;
    const gap = hPts - aPts;
    const hForm = hStand?.form || '';
    const recentW = (hForm.slice(-5).match(/W/g) || []).length;
    const hWins = hStats?.fixtures?.wins?.home || 0;
    const hPlayed = hStats?.fixtures?.played?.home || 1;
    const hWinRate = hWins / hPlayed;
    if (hGoals >= 1.8 && aConceded >= 1.5) { factors.push('F1'); score += 10; }
    if (hRank <= 6 && aRank >= 14 && gap >= 8) { factors.push('F2'); score += 9; }
    if (hGoals >= 2.0 && aConceded >= 1.3) { factors.push('F6'); score += 7; }
    if (recentW >= 3 && hRank <= 5) { factors.push('F7'); score += 7; }
    if (factors.includes('F1') && factors.includes('F2')) { factors.push('F8'); score += 6; }
    if (aRank >= 16) { factors.push('F11'); score += 7; }
    if (hWinRate >= 0.6 && aRank >= 12) { factors.push('F13'); score += 6; }
    const sm = score * 10;
    let alerte = null;
    if (sm >= 85) alerte = 'ROUGE';
    else if (sm >= 70) alerte = 'ORANGE';
    return { sm, factors, alerte };
  }

  const picksRouge = [], picksOrange = [];
  let totalAnalyses = 0, reqCount = 0;

  try {
    for (const league of LEAGUES_BT) {
      if (reqCount >= 180) break;
      const standings = await footballAPI('/standings', { league: league.id, season: SEASON });
      reqCount++;
      const standList = standings?.[0]?.league?.standings?.[0] || [];
      const fixtures = await footballAPI('/fixtures', { league: league.id, season: SEASON, status: 'FT', last: 25 });
      reqCount++;
      for (const fixture of fixtures.slice(0, 10)) {
        if (reqCount >= 180) break;
        const hTeam = fixture.teams?.home;
        const aTeam = fixture.teams?.away;
        if (!hTeam || !aTeam) continue;
        const [hStats, aStats] = await Promise.all([
          footballAPI('/teams/statistics', { team: hTeam.id, league: league.id, season: SEASON }),
          footballAPI('/teams/statistics', { team: aTeam.id, league: league.id, season: SEASON }),
        ]);
        reqCount += 2;
        const hStand = standList.find(s => s.team?.id === hTeam.id);
        const aStand = standList.find(s => s.team?.id === aTeam.id);
        const { sm, factors, alerte } = calcScore(hStats, aStats, hStand, aStand);
        totalAnalyses++;
        if (!alerte) continue;
        const hGoals = fixture.goals?.home || 0;
        const aGoals = fixture.goals?.away || 0;
        const validated = hGoals >= 2;
        const cote = alerte === 'ROUGE' ? 1.75 : 1.65;
        const gain = validated ? Math.round(MISE * (cote - 1)) : -MISE;
        const pick = {
          date: fixture.fixture?.date?.split('T')[0] || '?',
          match: `${hTeam.name} vs ${aTeam.name}`,
          competition: league.name,
          sm, alerte, factors,
          score: `${hGoals}-${aGoals}`,
          validated, cote, mise: MISE, gain,
        };
        if (alerte === 'ROUGE') picksRouge.push(pick);
        else picksOrange.push(pick);
      }
    }

    function stats(picks) {
      if (!picks.length) return { total: 0, wins: 0, losses: 0, winRate: 0, profit: 0, roi: 0, bestStreak: 0, worstStreak: 0 };
      const wins = picks.filter(p => p.validated).length;
      const profit = picks.reduce((a, p) => a + p.gain, 0);
      const roi = Math.round((profit / (picks.length * MISE)) * 100);
      let best = 0, cur = 0, worst = 0, curL = 0;
      for (const p of picks) {
        if (p.validated) { cur++; curL = 0; best = Math.max(best, cur); }
        else { curL++; cur = 0; worst = Math.max(worst, curL); }
      }
      return { total: picks.length, wins, losses: picks.length - wins, winRate: Math.round(wins / picks.length * 100), profit, roi, bestStreak: best, worstStreak: worst };
    }

    const sR = stats(picksRouge);
    const sO = stats(picksOrange);
    const totalProfit = sR.profit + sO.profit;
    const totalPicks = sR.total + sO.total;
    const globalWR = totalPicks > 0 ? Math.round(((sR.wins + sO.wins) / totalPicks) * 100) : 0;
    const globalROI = totalPicks > 0 ? Math.round((totalProfit / (totalPicks * MISE)) * 100) : 0;

    res.json({
      meta: { totalAnalyses, reqCount, saison: SEASON, mise: MISE },
      rouge: { stats: sR, picks: picksRouge },
      orange: { stats: sO, picks: picksOrange },
      global: { totalPicks, totalProfit, globalWR, globalROI },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', name: 'PicksAI' }));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PicksAI running on port ${PORT}`));
