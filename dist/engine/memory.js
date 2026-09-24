// Lessons from dead and paper ideas, tagged with the market regime they died in.
// A setup killed in one regime is skipped while that regime lasts, and retried when it changes.

export const MEMORY_WINDOW = 24 * 14; // hours a lesson blocks a retry in the same regime

export class Memory {
  constructor() { this.lessons = []; }

  add(lesson) { this.lessons.push(lesson); return lesson; }

  // KILL lessons for this setup in this volatility regime that are still fresh at `now`
  blocking(setup, vol, now) {
    return this.lessons.filter((l) => l.setup === setup && l.vol === vol && l.verdict === 'KILL' && now - l.i <= MEMORY_WINDOW);
  }

  // all lessons about a setup, newest first
  about(setup) { return this.lessons.filter((l) => l.setup === setup).reverse(); }

  recent(k = 6) { return this.lessons.slice(-k).reverse(); }

  toPrompt(now, k = 8) {
    const rows = this.recent(k);
    if (!rows.length) return 'none yet';
    return rows.map((l) => `- ${now - l.i}h ago · ${l.setup} on ${l.asset} · ${l.vol} ${l.trend} · ${l.verdict}: ${l.text}`).join('\n');
  }
}
