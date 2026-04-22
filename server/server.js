'use strict';

const WebSocket  = require('ws');
const { v4: uuidv4 } = require('uuid');
const Matchmaker = require('./matchmaking');
const express    = require('express');
const cors       = require('cors');
const { Pool }   = require('pg');
const http       = require('http');

const PORT = process.env.PORT || 8080;

// ── Database (Supabase / PostgreSQL) ──────────────────────────
const dbUrl = process.env.DATABASE_URL || '';
console.log('DATABASE_URL present:', !!dbUrl);
console.log('DATABASE_URL preview:', dbUrl ? dbUrl.replace(/:([^:@]+)@/, ':***@').substring(0, 80) : 'NOT SET');

const pool = new Pool({
  connectionString: dbUrl || undefined,
  ssl: { rejectUnauthorized: false }
});

const initDb = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS players (
        id              SERIAL PRIMARY KEY,
        nickname        TEXT NOT NULL UNIQUE,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        total_matches   INTEGER NOT NULL DEFAULT 0,
        hero_wins       INTEGER NOT NULL DEFAULT 0,
        dungeon_wins    INTEGER NOT NULL DEFAULT 0,
        tiles_walked    INTEGER NOT NULL DEFAULT 0,
        monsters_killed INTEGER NOT NULL DEFAULT 0,
        goblin_killed   INTEGER NOT NULL DEFAULT 0,
        troll_killed    INTEGER NOT NULL DEFAULT 0,
        keys_collected  INTEGER NOT NULL DEFAULT 0,
        items_used      INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS achievements (
        id         SERIAL PRIMARY KEY,
        player_id  INTEGER NOT NULL REFERENCES players(id),
        achiev_id  TEXT NOT NULL,
        tier       INTEGER NOT NULL DEFAULT 0,
        claimed_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(player_id, achiev_id)
      );
      CREATE TABLE IF NOT EXISTS speed_leaderboard (
        id         SERIAL PRIMARY KEY,
        player_id  INTEGER NOT NULL REFERENCES players(id),
        nickname   TEXT NOT NULL,
        time_ms    INTEGER NOT NULL,
        seed       BIGINT,
        played_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_speed_time ON speed_leaderboard(time_ms ASC);
    `);
    console.log('✅ База данных Supabase готова к работе');
  } catch (err) {
    console.error('❌ Ошибка инициализации базы:', err);
  }
};
initDb();

// ── Achievement constants ─────────────────────────────────────
const ACH_TIERS = {
  tiles_walked:    [100,500,2000,10000,50000],
  monsters_killed: [5,20,60,200,500],
  goblin_killed:   [3,10,30,100],
  troll_killed:    [1,5,15],
  matches_played:  [1,5,20,50,100],
  hero_wins:       [1,5,20,50],
  keys_collected:  [3,15,50,150],
  items_used:      [3,15,50,200]
};
const ACH_COINS = {
  tiles_walked:    [2,4,8,15,25],
  monsters_killed: [3,6,12,20,35],
  goblin_killed:   [2,5,10,18],
  troll_killed:    [5,12,25],
  matches_played:  [2,5,10,20,40],
  hero_wins:       [3,7,15,30],
  keys_collected:  [2,5,12,22],
  items_used:      [2,5,10,20]
};
const STAT_ACH = {
  tiles_walked:'tiles_walked', monsters_killed:'monsters_killed',
  goblin_killed:'goblin_killed', troll_killed:'troll_killed',
  total_matches:'matches_played', hero_wins:'hero_wins',
  keys_collected:'keys_collected', items_used:'items_used'
};

function computeNewAchievs(player, prev) {
  const out = [];
  for (const [col, aid] of Object.entries(STAT_ACH)) {
    const val   = parseInt(player[col]) || 0;
    const tiers = ACH_TIERS[aid];
    const coins = ACH_COINS[aid];
    const p     = prev[aid] ?? -1;
    let newT    = p;
    for (let i = 0; i < tiers.length; i++) if (val >= tiers[i] && i > p) newT = i;
    if (newT > p) {
      let c = 0; for (let i = p+1; i <= newT; i++) c += coins[i];
      out.push({ achievId: aid, tier: newT, coins: c });
    }
  }
  return out;
}

async function applyStats(nick, payload, won, role) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pRes = await client.query('SELECT * FROM players WHERE nickname ILIKE $1', [nick]);
    const p = pRes.rows[0];
    if (!p) throw new Error('Player not found');

    const prevRows = await client.query('SELECT achiev_id, tier FROM achievements WHERE player_id = $1', [p.id]);
    const prev = {};
    prevRows.rows.forEach(r => { prev[r.achiev_id] = r.tier; });

    await client.query(`UPDATE players SET
      total_matches   = total_matches   + 1,
      hero_wins       = hero_wins       + $1,
      dungeon_wins    = dungeon_wins    + $2,
      tiles_walked    = tiles_walked    + $3,
      monsters_killed = monsters_killed + $4,
      goblin_killed   = goblin_killed   + $5,
      troll_killed    = troll_killed    + $6,
      keys_collected  = keys_collected  + $7,
      items_used      = items_used      + $8
      WHERE id = $9`, [
      role==='hero'    && won ? 1 : 0,
      role==='dungeon' && won ? 1 : 0,
      payload.tilesWalked    || 0,
      payload.monstersKilled || 0,
      payload.goblinKilled   || 0,
      payload.trollKilled    || 0,
      payload.keysCollected  || 0,
      payload.itemsUsed      || 0,
      p.id
    ]);

    const updatedRes = await client.query('SELECT * FROM players WHERE id = $1', [p.id]);
    const newA = computeNewAchievs(updatedRes.rows[0], prev);
    let coins = 0;
    for (const a of newA) {
      await client.query(`
        INSERT INTO achievements(player_id, achiev_id, tier) VALUES($1,$2,$3)
        ON CONFLICT(player_id,achiev_id) DO UPDATE SET tier=$3, claimed_at=NOW()
      `, [p.id, a.achievId, a.tier]);
      coins += a.coins;
    }
    await client.query('COMMIT');
    return { newAchievements: newA, coinsEarned: coins };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('applyStats error:', e.message);
    return null;
  } finally {
    client.release();
  }
}

// ── REST API ──────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: (o, cb) => cb(null, true), credentials: true }));
app.use(express.json());

// ── NEW: Login or Register in one call ────────────────────────
// If nickname exists → login (return isNew:false)
// If nickname is new → create account (return isNew:true)
app.post('/api/nickname/login', async (req, res) => {
  const n = (req.body.nickname||'').trim();
  if (!n || n.length < 2 || n.length > 20 || !/^[A-Za-z0-9_-]+$/.test(n))
    return res.json({ ok: false, error: 'Invalid (2-20 chars, A-Z 0-9 _ -)' });
  try {
    const existing = await pool.query('SELECT id, nickname FROM players WHERE nickname ILIKE $1', [n]);
    if (existing.rows.length > 0) {
      // Already exists — log them in
      return res.json({ ok: true, nickname: existing.rows[0].nickname, isNew: false });
    }
    // New player — register
    try {
      await pool.query('INSERT INTO players (nickname) VALUES ($1)', [n]);
      return res.json({ ok: true, nickname: n, isNew: true });
    } catch {
      // Race: inserted by someone else between SELECT and INSERT
      const row = await pool.query('SELECT nickname FROM players WHERE nickname ILIKE $1', [n]);
      if (row.rows.length > 0)
        return res.json({ ok: true, nickname: row.rows[0].nickname, isNew: false });
      return res.json({ ok: false, error: 'Try again' });
    }
  } catch (e) {
    console.error('login error:', e.message);
    // DB unavailable — tell client to save locally
    return res.json({ ok: false, error: 'DB unavailable', localFallback: true });
  }
});

// Keep old /check and /register for backwards compat
app.get('/api/nickname/check/:nick', async (req, res) => {
  const n = (req.params.nick||'').trim();
  if (!n || n.length < 2 || n.length > 20 || !/^[A-Za-z0-9_-]+$/.test(n))
    return res.json({ ok: false, error: 'Invalid' });
  const check = await pool.query('SELECT id FROM players WHERE nickname ILIKE $1', [n]);
  res.json(check.rows.length > 0 ? { ok: false, error: 'Already taken' } : { ok: true });
});

app.post('/api/nickname/register', async (req, res) => {
  const n = (req.body.nickname||'').trim();
  if (!n || n.length < 2 || n.length > 20 || !/^[A-Za-z0-9_-]+$/.test(n))
    return res.json({ ok: false, error: 'Invalid nickname' });
  try {
    await pool.query('INSERT INTO players (nickname) VALUES ($1)', [n]);
    res.json({ ok: true, nickname: n });
  } catch { res.json({ ok: false, error: 'Already taken' }); }
});

app.get('/api/player/:nick', async (req, res) => {
  try {
    const pRes = await pool.query('SELECT * FROM players WHERE nickname ILIKE $1', [req.params.nick]);
    const p = pRes.rows[0];
    if (!p) return res.json({ ok: false, error: 'Not found' });
    const achRes = await pool.query('SELECT achiev_id, tier FROM achievements WHERE player_id=$1', [p.id]);
    const achievs = {};
    achRes.rows.forEach(r => { achievs[r.achiev_id] = r.tier; });
    res.json({ ok: true, player: p, achievements: achievs });
  } catch (e) {
    res.json({ ok: false, error: 'Server error' });
  }
});

// ── Speed leaderboard ─────────────────────────────────────────
app.post('/api/speed/submit', async (req, res) => {
  const { nickname, timeMs, seed } = req.body;
  if (!nickname || !timeMs) return res.json({ ok: false, error: 'Missing fields' });
  try {
    const pRes = await pool.query('SELECT * FROM players WHERE nickname ILIKE $1', [nickname]);
    const player = pRes.rows[0];
    if (!player) return res.json({ ok: false, error: 'Player not found — set a nickname first' });

    // Personal best before insert
    const pbBefore = await pool.query(
      'SELECT MIN(time_ms) as pb FROM speed_leaderboard WHERE player_id=$1', [player.id]);
    const prevPb = pbBefore.rows[0].pb;

    await pool.query(
      'INSERT INTO speed_leaderboard(player_id,nickname,time_ms,seed) VALUES($1,$2,$3,$4)',
      [player.id, player.nickname, timeMs, seed||0]);

    const pbAfter = await pool.query(
      'SELECT MIN(time_ms) as pb FROM speed_leaderboard WHERE player_id=$1', [player.id]);
    const newPb = pbAfter.rows[0].pb;

    const rankRes = await pool.query(
      'SELECT COUNT(*)+1 as rank FROM speed_leaderboard WHERE time_ms < $1', [newPb]);

    res.json({
      ok: true,
      rank: parseInt(rankRes.rows[0].rank),
      personalBest: newPb,
      isPersonalBest: !prevPb || newPb < prevPb
    });
  } catch (e) {
    console.error('speed submit error:', e.message);
    res.json({ ok: false, error: 'Server error' });
  }
});

app.get('/api/speed/leaderboard', async (req, res) => {
  try {
    const rows = await pool.query(`
      SELECT DISTINCT ON (player_id) nickname, time_ms as best_time
      FROM speed_leaderboard
      ORDER BY player_id, time_ms ASC
      LIMIT 20
    `);
    // Re-sort by best_time
    const sorted = rows.rows.sort((a,b) => a.best_time - b.best_time);
    res.json({ ok: true, entries: sorted });
  } catch (e) {
    res.json({ ok: false, error: 'Server error' });
  }
});

app.get('/api/speed/personal/:nick', async (req, res) => {
  try {
    const pRes = await pool.query('SELECT id FROM players WHERE nickname ILIKE $1', [req.params.nick]);
    const p = pRes.rows[0];
    if (!p) return res.json({ ok: false, error: 'Not found' });
    const pb = await pool.query(
      'SELECT MIN(time_ms) as best_time FROM speed_leaderboard WHERE player_id=$1', [p.id]);
    res.json({ ok: true, personalBest: pb.rows[0].best_time });
  } catch (e) {
    res.json({ ok: false, error: 'Server error' });
  }
});

// ── Stats submit (REST, for bot/speedrun) ─────────────────────
app.post('/api/stats/submit', async (req, res) => {
  const { nickname, won, role } = req.body;
  if (!nickname) return res.json({ ok: false, error: 'Missing nickname' });
  const result = await applyStats(nickname, req.body, !!won, role||'hero');
  if (!result) return res.json({ ok: false, error: 'Player not found' });
  res.json({ ok: true, newAchievements: result.newAchievements, coinsEarned: result.coinsEarned });
});

// ── WebSocket ─────────────────────────────────────────────────
const server     = http.createServer(app);
const wss        = new WebSocket.Server({ server });
const matchmaker = new Matchmaker();
const matches    = new Map();
const players    = new Map();

function send(ws, type, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, payload }));
}
function broadcast(mid, type, payload, excl) {
  const m = matches.get(mid); if (!m) return;
  if (excl !== 'hero'    && m.hero?.ws)    send(m.hero.ws,    type, payload);
  if (excl !== 'dungeon' && m.dungeon?.ws) send(m.dungeon.ws, type, payload);
}

wss.on('connection', ws => {
  const pid = uuidv4();
  players.set(pid, { ws, matchId: null, role: null });
  send(ws, 'connected', { playerId: pid });

  ws.on('message', async raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const { type, payload } = msg;
    const player = players.get(pid); if (!player) return;

    switch (type) {
      case 'find_match': {
        const match = matchmaker.addToQueue({ id: pid, ws, upgradeData: payload?.upgradeData||{} });
        if (match) {
          const mid = match.matchId, seed = Date.now();
          matches.set(mid, {
            hero:    { id: match.heroPlayer.id,    ws: match.heroPlayer.ws    },
            dungeon: { id: match.dungeonPlayer.id, ws: match.dungeonPlayer.ws },
            state: 'starting'
          });
          players.get(match.heroPlayer.id).matchId    = mid;
          players.get(match.heroPlayer.id).role       = 'hero';
          players.get(match.dungeonPlayer.id).matchId = mid;
          players.get(match.dungeonPlayer.id).role    = 'dungeon';
          send(match.heroPlayer.ws,    'match_found', { matchId:mid, role:'hero',    mapSeed:seed });
          send(match.dungeonPlayer.ws, 'match_found', { matchId:mid, role:'dungeon', mapSeed:seed });
        } else {
          send(ws, 'waiting_for_opponent', {});
        }
        break;
      }
      case 'cancel_search': matchmaker.removeFromQueue(pid); break;
      case 'game_ready': {
        const m = matches.get(player.matchId); if (!m) break;
        if (!m._ready) m._ready = new Set();
        m._ready.add(player.role);
        if (m._ready.size === 2) { m.state='active'; broadcast(player.matchId,'game_start',{timestamp:Date.now()}); }
        break;
      }
      case 'hero_update':    if (player.role==='hero')    broadcast(player.matchId,'hero_update',payload,'hero'); break;
      case 'hero_attack':    if (player.role==='hero')    broadcast(player.matchId,'hero_attack',payload,'hero'); break;
      case 'hero_damage':    broadcast(player.matchId,'hero_damage',payload); break;
      case 'item_pickup':    if (player.role==='hero')    broadcast(player.matchId,'item_pickup',payload); break;
      case 'quest_update':   if (player.role==='hero')    broadcast(player.matchId,'quest_update',payload,'hero'); break;
      case 'hero_levelup':   if (player.role==='hero')    broadcast(player.matchId,'hero_levelup',payload,'hero'); break;
      case 'spawn_monster':  if (player.role==='dungeon') broadcast(player.matchId,'spawn_monster',payload); break;
      case 'monster_update': broadcast(player.matchId,'monster_update',payload); break;
      case 'monster_death':  broadcast(player.matchId,'monster_death',payload); break;
      case 'game_over': {
        const m = matches.get(player.matchId); if (!m) break;
        m.state='finished'; broadcast(player.matchId,'game_over',payload);
        setTimeout(()=>matches.delete(player.matchId),10000); break;
      }
      case 'match_stats': {
        if (player.role !== 'hero') break;
        const nick = payload?.nickname; if (!nick) break;
        // won is passed explicitly in payload now
        const won  = !!payload.won;
        const result = await applyStats(nick, payload, won, 'hero');
        if (result && result.newAchievements.length > 0) {
          send(ws, 'achievements_unlocked', result);
        }
        break;
      }
      case 'ping': send(ws,'pong',{t:payload?.t}); break;
    }
  });

  ws.on('close', () => {
    const p = players.get(pid);
    if (p) {
      matchmaker.removeFromQueue(pid);
      if (p.matchId) {
        const m = matches.get(p.matchId);
        if (m && m.state==='active') { broadcast(p.matchId,'opponent_disconnected',{}); matches.delete(p.matchId); }
      }
    }
    players.delete(pid);
  });
  ws.on('error', () => players.delete(pid));
});

server.listen(PORT, () => console.log('Legend of Dungeon server on port ' + PORT));
