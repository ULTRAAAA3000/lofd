'use strict';

const WebSocket  = require('ws');
const { v4: uuidv4 } = require('uuid');
const Matchmaker = require('./matchmaking');
const express    = require('express');
const cors       = require('cors');
const Database   = require('better-sqlite3');
const path       = require('path');
const http       = require('http');

const PORT = process.env.PORT || 8080;

// ── Database ──────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'lod.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    nickname        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
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
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id  INTEGER NOT NULL REFERENCES players(id),
    achiev_id  TEXT    NOT NULL,
    tier       INTEGER NOT NULL DEFAULT 0,
    claimed_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    UNIQUE(player_id, achiev_id)
  );
`);

const stmts = {
  findNick:    db.prepare('SELECT id FROM players WHERE nickname = ? COLLATE NOCASE'),
  createNick:  db.prepare('INSERT INTO players (nickname) VALUES (?)'),
  getPlayer:   db.prepare('SELECT * FROM players WHERE nickname = ? COLLATE NOCASE'),
  updateStats: db.prepare(`UPDATE players SET
    total_matches=total_matches+@tm, hero_wins=hero_wins+@hw, dungeon_wins=dungeon_wins+@dw,
    tiles_walked=tiles_walked+@tw, monsters_killed=monsters_killed+@mk,
    goblin_killed=goblin_killed+@gk, troll_killed=troll_killed+@trk,
    keys_collected=keys_collected+@kc, items_used=items_used+@iu
    WHERE nickname=@nick COLLATE NOCASE`),
  getAchievs:  db.prepare('SELECT achiev_id, tier FROM achievements WHERE player_id=?'),
  upsertAch:   db.prepare(`INSERT INTO achievements(player_id,achiev_id,tier)VALUES(@pid,@aid,@tier)
    ON CONFLICT(player_id,achiev_id) DO UPDATE SET tier=@tier,claimed_at=strftime('%s','now')`)
};

// Mirrors engine.js
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
    const val   = player[col] || 0;
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

function applyStats(nick, payload, won, role) {
  const p = stmts.getPlayer.get(nick);
  if (!p) return null;
  const prevRows = stmts.getAchievs.all(p.id);
  const prev = {}; prevRows.forEach(r => { prev[r.achiev_id] = r.tier; });
  stmts.updateStats.run({
    nick, tm:1,
    hw: role==='hero'    && won ? 1 : 0,
    dw: role==='dungeon' && won ? 1 : 0,
    tw:  payload.tilesWalked    || 0,
    mk:  payload.monstersKilled || 0,
    gk:  payload.goblinKilled   || 0,
    trk: payload.trollKilled    || 0,
    kc:  payload.keysCollected  || 0,
    iu:  payload.itemsUsed      || 0
  });
  const updated = stmts.getPlayer.get(nick);
  const newA = computeNewAchievs(updated, prev);
  let coins = 0;
  db.transaction(list => {
    for (const a of list) {
      stmts.upsertAch.run({ pid: p.id, aid: a.achievId, tier: a.tier });
      coins += a.coins;
    }
  })(newA);
  return { newAchievements: newA, coinsEarned: coins };
}

// ── REST API ──────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/nickname/check/:nick', (req, res) => {
  const n = (req.params.nick||'').trim();
  if (!n || n.length < 2 || n.length > 20 || !/^[A-Za-z0-9_-]+$/.test(n))
    return res.json({ ok: false, error: 'Invalid (2-20 chars, A-Z 0-9 _ -)' });
  res.json(stmts.findNick.get(n) ? { ok: false, error: 'Already taken' } : { ok: true });
});

app.post('/api/nickname/register', (req, res) => {
  const n = (req.body.nickname||'').trim();
  if (!n || n.length < 2 || n.length > 20 || !/^[A-Za-z0-9_-]+$/.test(n))
    return res.json({ ok: false, error: 'Invalid nickname' });
  try {
    stmts.createNick.run(n);
    res.json({ ok: true, nickname: n });
  } catch { res.json({ ok: false, error: 'Already taken' }); }
});

app.get('/api/player/:nick', (req, res) => {
  const p = stmts.getPlayer.get(req.params.nick);
  if (!p) return res.json({ ok: false, error: 'Not found' });
  const achievRows = stmts.getAchievs.all(p.id);
  const achievs = {}; achievRows.forEach(r => { achievs[r.achiev_id] = r.tier; });
  res.json({ ok: true, player: p, achievements: achievs });
});

// ── WebSocket ─────────────────────────────────────────────────
const server     = http.createServer(app);
const wss        = new WebSocket.Server({ server });
const matchmaker = new Matchmaker();
const matches    = new Map();
const players    = new Map();

function send(ws, type, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, payload }));
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

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const { type, payload } = msg;
    const player = players.get(pid); if (!player) return;

    switch (type) {
      case 'find_match': {
        const match = matchmaker.addToQueue({ id: pid, ws, upgradeData: payload?.upgradeData || {} });
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
        const m    = matches.get(player.matchId);
        const won  = m?.state === 'finished';
        const result = applyStats(nick, payload, won, 'hero');
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
