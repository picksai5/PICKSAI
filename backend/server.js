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

// Compétitions européennes
const EURO_LEAGUES = [2, 3, 848];

function formatPlayers(players) {
  return players.slice(0, 5).map(p => {
    const s = p.statistics?.[0];
    return `${p.player?.name}(${s?.goals?.total||0}buts,${s?.goals?.assists||0}passes,${s?.games?.appearences||0}matchs)`;
  }).join(' | ') || '?';
}

async function getNationalLeague(teamId) {
  const data = await footballAPI('/leagues', { team: teamId, season: 2025, type: 'League' });
  const priority = [39, 140, 135, 78, 61, 88, 94];
  const leagueIds = data.map(d => d.league?.id);
  for (const p of priority) { if (leagueIds.includes(p)) return p; }
  return data?.[0]?.league?.id || null;
}

async function collectMatchData(fixture, leagueId, leagueName, standings) {
  const hTeam = fixture.teams?.home;
  const aTeam = fixture.teams?.away;
  const fixtureId = fixture.fixture?.id;
  if (!hTeam || !aTeam) return null;

  const hTime = fixture.fixture?.date ? new Date(fixture.fixture.date).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '?';
  const isEuropean = EURO_LEAGUES.includes(leagueId);

  // Données de base
  const [hStats, aStats, injuries, h2h, hPlayers, aPlayers] = await Promise.all([
    footballAPI('/teams/statistics', { team: hTeam.id, league: leagueId, season: 2025 }),
    footballAPI('/teams/statistics', { team: aTeam.id, league: leagueId, season: 2025 }),
    footballAPI('/injuries', { fixture: fixtureId }),
    footballAPI('/fixtures/headtohead', { h2h: `${hTeam.id}-${aTeam.id}`, last: 5 }),
    footballAPI('/players', { team: hTeam.id, league: leagueId, season: 2025 }),
    footballAPI('/players', { team: aTeam.id, league: leagueId, season: 2025 }),
  ]);

  const hStand = standings.find(s => s.team?.id === hTeam.id);
  const aStand = standings.find(s => s.team?.id === aTeam.id);

  // Pour matchs européens : récupérer aussi les stats en championnat national
  let statsSection = '';
  if (isEuropean) {
    const [hNatId, aNatId] = await Promise.all([getNationalLeague(hTeam.id), getNationalLeague(aTeam.id)]);
    const [hNatStats, aNatStats, hNatPlayers, aNatPlayers] = await Promise.all([
      hNatId ? footballAPI('/teams/statistics', { team: hTeam.id, league: hNatId, season: 2025 }) : Promise.resolve(null),
      aNatId ? footballAPI('/teams/statistics', { team: aTeam.id, league: aNatId, season: 2025 }) : Promise.resolve(null),
      hNatId ? footballAPI('/players', { team: hTeam.id, league: hNatId, season: 2025 }) : Promise.resolve([]),
      aNatId ? footballAPI('/players', { team: aTeam.id, league: aNatId, season: 2025 }) : Promise.resolve([]),
    ]);

    statsSection = `
STATS EN ${leagueName.toUpperCase()} (forme européenne):
${hTeam.name}: marque ${hStats?.goals?.for?.average?.home||'?'}/match, concède ${hStats?.goals?.against?.average?.home||'?'}/match
${aTeam.name}: marque ${aStats?.goals?.for?.average?.away||'?'}/match, concède ${aStats?.goals?.against?.average?.away||'?'}/match

STATS EN CHAMPIONNAT NATIONAL (forme générale):
${hTeam.name}: marque ${hNatStats?.goals?.for?.average?.home||'?'}/match, concède ${hNatStats?.goals?.against?.average?.home||'?'}/match
${aTeam.name}: marque ${aNatStats?.goals?.for?.average?.away||'?'}/match, concède ${aNatStats?.goals?.against?.average?.away||'?'}/match

JOUEURS EN ${leagueName.toUpperCase()} (stats européennes):
${hTeam.name}: ${formatPlayers(hPlayers)}
${aTeam.name}: ${formatPlayers(aPlayers)}

JOUEURS EN CHAMPIONNAT NATIONAL (forme individuelle):
${hTeam.name}: ${hNatPlayers.length > 0 ? formatPlayers(hNatPlayers) : 'N/A'}
${aTeam.name}: ${aNatPlayers.length > 0 ? formatPlayers(aNatPlayers) : 'N/A'}`;
  } else {
    statsSection = `
STATS OFFENSIVES/DÉFENSIVES:
${hTeam.name}: marque ${hStats?.goals?.for?.average?.home||'?'}/match, concède ${hStats?.goals?.against?.average?.home||'?'}/match
${aTeam.name}: marque ${aStats?.goals?.for?.average?.away||'?'}/match, concède ${aStats?.goals?.against?.average?.away||'?'}/match

JOUEURS CLÉS:
${hTeam.name}: ${formatPlayers(hPlayers)}
${aTeam.name}: ${formatPlayers(aPlayers)}`;
  }

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
      blesses: injuries.slice(0,6).map(i=>`${i.player?.name}(${i.team?.name})`).join(', ')||'Aucune info',
      h2h: h2h.slice(0,5).map(m=>`${m.teams?.home?.name} ${m.goals?.home}-${m.goals?.away} ${m.teams?.away?.name}`).join(' | ')||'Pas de données',
      penaltys: `${hTeam.name} ${hStats?.penalty?.scored?.total||0} pen tirés | ${aTeam.name} ${aStats?.penalty?.scored?.total||0} pen concédés`,
    }
  };
}

async function analyzeWithClaude(matchData) {
  const prompt = `Tu es PicksAI, expert pronostics football. Analyse ce match et applique la Matrice F1→F14 en détail.

MATCH: ${matchData.match} | ${matchData.competition} | ${matchData.heure}
CLASSEMENT: ${matchData.data.classement}
${matchData.data.statsSection}
BLESSÉS/SUSPENDUS: ${matchData.data.blesses}
H2H (5 derniers): ${matchData.data.h2h}
PENALTYS: ${matchData.data.penaltys}

MATRICE F1→F14:
F1[poids:10,taux:71%] Attaquant 3+buts/5derniers matchs ET défense concède 1.8+/match
F2[poids:9,taux:68%] Top6 domicile vs 4 pires défenses, écart points >8
F3[poids:9,taux:65%] Tireur penaltys vs équipe qui concède 0.6+ pen/match
F4[poids:8,taux:62%] Joueur à 1-2 buts d'un milestone (10,15,20 buts)
F5[poids:8,taux:61%] Attaquant rapide vs défenseur lent/âgé
F6[poids:7,taux:59%] xG >2.2 sur 5 derniers matchs vs bloc bas fragile
F7[poids:7,taux:58%] Match fort enjeu (CL,derby,relégation) + joueur en confiance
F8[poids:6,taux:74%] F1+F2 activés ensemble (combo bonus)
F9[poids:8,taux:64%] H2H très favorable pour le joueur ciblé
F10[poids:6,taux:61%] Adversaire fatigué 3+matchs/10jours ou long déplacement
F11[poids:7,taux:63%] Adversaire en zone relégation ou très bas classé
F12[poids:7,taux:60%] Joueur retour blessure sous-estimé par bookmakers
F13[poids:6,taux:58%] Possession >60% vs bloc bas qui concède sur contres
F14[poids:9,taux:67%] Value bet: joueur sous-coté vs vraie probabilité

RÈGLES ABSOLUES — RESPECTE-LES TOUJOURS SANS EXCEPTION:

SÉLECTION DU JOUEUR:
- ❌ INTERDIT absolu de proposer un DÉFENSEUR (défenseur central, latéral gauche/droit) comme pick principal
- ❌ INTERDIT absolu de proposer un GARDIEN comme pick
- ❌ INTERDIT absolu de proposer un joueur listé dans BLESSÉS/SUSPENDUS — lis cette liste EN PREMIER avant tout
- ❌ INTERDIT de proposer un joueur dont tu n'es pas certain qu'il joue ce soir — en cas de doute, choisis un autre
- ❌ INTERDIT de proposer un joueur décédé, retraité ou transféré — utilise UNIQUEMENT les joueurs présents dans les données fournies avec stats réelles cette saison (buts > 0 ou matchs > 5)
- ❌ INTERDIT d'inventer un nom — si un joueur n'apparaît pas dans les données fournies, ne le propose pas
- ✅ Cible UNIQUEMENT: attaquants de pointe, ailiers, milieux offensifs, milieux box-to-box avec buts
- ✅ Priorité aux joueurs avec le plus de buts + passes cette saison dans les données fournies
- ✅ Joueur décisif = but OU passe décisive (probabilité plus haute qu'un simple buteur)
- ✅ Si les données joueurs sont insuffisantes ou vides → retourne {"valide":false}

QUALITÉ DE L'ANALYSE:
- ✅ Pour CL/Europa League: utilise les stats européennes ET nationales pour évaluer la forme
- ✅ Active F7 systématiquement pour les matchs CL/EL si une star est en forme
- ✅ Les absences défensives adverses = bonus pour l'attaquant ciblé (active F5 ou F11)
- ✅ Score = somme poids facteurs activés × 10
- ✅ ROUGE ≥85, ORANGE 70-84, VERT 60-69
- ✅ Sois précis dans la raison : cite des stats réelles (ex: "8 buts en 10 matchs CL")

Retourne UNIQUEMENT ce JSON (pas de texte autour):
{"score_matriciel":85,"facteurs":["F1","F2","F7"],"alerte":"ROUGE","pick":{"joueur":"Prénom Nom","equipe":"Equipe","type":"Joueur décisif","prob":68,"cote_estimee":1.75,"raison":"Raison précise avec stats concrètes en 2 phrases max"},"buteur_alternatif":{"joueur":"Prénom Nom","equipe":"Equipe","prob":45,"cote_estimee":2.20,"raison":"Raison courte"},"contexte":"Contexte du match en 1 phrase","score_prono":"2-1","valide":true}

Si score < 60: {"valide":false,"score_matriciel":X,"raison_rejet":"explication courte"}`;

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
    const today = new Date().toISOString().split('T')[0];
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
    const toAnalyze = allFixtures.slice(0, 12);

    for (const fixture of toAnalyze) {
      try {
        const leagueId = fixture.leagueId || fixture.league?.id;
        const standData = await footballAPI('/standings', { league: leagueId, season: 2025 });
        const standings = standData?.[0]?.league?.standings?.[0] || [];
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
      total_analyses: toAnalyze.length,
      picks,
      rejected,
      top_pick: picks[0] || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

app.get('/api/health', (req, res) => res.json({ status: 'ok', name: 'PicksAI' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend/index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PicksAI running on port ${PORT}`));
