'use strict';

class Matchmaker {
  constructor() {
    this.queue = [];
  }

  addToQueue(player) {
    this.queue.push(player);
    if (this.queue.length >= 2) {
      const p1 = this.queue.shift();
      const p2 = this.queue.shift();
      return this._createMatch(p1, p2);
    }
    return null;
  }

  removeFromQueue(playerId) {
    this.queue = this.queue.filter(p => p.id !== playerId);
  }

  _createMatch(p1, p2) {
    const roles = Math.random() < 0.5
      ? { hero: p1, dungeon: p2 }
      : { hero: p2, dungeon: p1 };

    return {
      heroPlayer: roles.hero,
      dungeonPlayer: roles.dungeon,
      matchId: `match_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    };
  }

  getQueueLength() {
    return this.queue.length;
  }
}

module.exports = Matchmaker;
