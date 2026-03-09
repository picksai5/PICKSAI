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
  try {
    const res = await axios.get(`${FOOTBALL_API_BASE}${endpoint}`, {
      headers: { 
  'x-apisports-key': FOOTBALL_API_KEY,
  'x-rapidapi-host': 'v3.football.api-sports.io'
},
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
    const data = await footballAPI('/fixtures', {
      date: today, league: league.id, season: 2025,
    });
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

JSON exact à retourner:
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

app.get('/api/scan', async (req, res) => {
  try {
    const fixtures = await getFixturesToday();
    if (fixtures.length === 0) {
      return res.json({ picks: [], total_analyses: 0 });
    }
    const picks = [];
    const toAnalyze = fixtures.slice(0, 8);
    for (const fixture of toAnalyze) {
      try {
        const homeTeam = fixture.teams?.home;
        const awayTeam = fixture.teams?.away;
        const leagueId = fixture.league?.id;
        const fixtureId = fixture.fixture?.id;
        if (!homeTeam || !awayTeam) continue;
        const [homeStats, awayStats, injuries, h2h, standings] = await Promise.all([
          getTeamStats(homeTeam.id, leagueId),
          getTeamStats(awayTeam.id, leagueId),
          getInjuries(fixtureId),
          getH2H(homeTeam.id, awayTeam.id),
          getStandings(leagueId),
        ]);
        const homeRank = standings.findIndex(s => s.team?.id === homeTeam.id) + 1 || '?';
        const awayRank = standings.findIndex(s => s.team?.id === awayTeam.id) + 1 || '?';
        const homePoints = standings.find(s => s.team?.id === homeTeam.id)?.points || '?';
        const awayPoints = standings.find(s => s.team?.id === awayTeam.id)?.points || '?';
        const [homePlayers, awayPlayers] = await Promise.all([
          getTopPlayers(homeTeam.id, leagueId),
          getTopPlayers(awayTeam.id, leagueId),
        ]);
        const analysis = await analyzeWithClaude({
          home: homeTeam.name, away: awayTeam.name,
          league: fixture.leagueName,
          time: fixture.fixture?.date ? new Date(fixture.fixture.date).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '?',
          homeRank, awayRank, homePoints, awayPoints,
          homeGoalsAvg: homeStats?.goals?.for?.average?.home || '?',
          awayGoalsAvg: awayStats?.goals?.for?.average?.away || '?',
          homeConcededAvg: homeStats?.goals?.against?.average?.home || '?',
          awayConcededAvg: awayStats?.goals?.against?.average?.away || '?',
          injuries: injuries.slice(0, 4).map(i => `${i.player?.name}(${i.team?.name})`).join(', ') || 'Aucune',
          homePlayers: homePlayers.slice(0, 3).map(p => `${p.player?.name}(${p.statistics?.[0]?.goals?.total || 0}buts)`).join(', ') || '?',
          awayPlayers: awayPlayers.slice(0, 3).map(p => `${p.player?.name}(${p.statistics?.[0]?.goals?.total || 0}buts)`).join(', ') || '?',
          h2h: h2h.slice(0, 3).map(m => `${m.teams?.home?.name} ${m.goals?.home}-${m.goals?.away} ${m.teams?.away?.name}`).join(' | ') || 'Pas de données',
        });
        if (analysis.valide) {
          picks.push({
            ...analysis,
            match: `${homeTeam.name} vs ${awayTeam.name}`,
            competition: fixture.leagueName,
            heure: fixture.fixture?.date ? new Date(fixture.fixture.date).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '?',
            domicile: homeTeam.name,
            exterieur: awayTeam.name,
          });
        }
      } catch (e) {
        console.error('Erreur match:', e.message);
      }
    }
    picks.sort((a, b) => b.score_matriciel - a.score_matriciel);
    res.json({ date: new Date().toLocaleDateString('fr-FR'), total_analyses: toAnalyze.length, picks, top_pick: picks[0] || null });
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
