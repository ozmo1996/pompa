// Pamięć podręczna historii z bazy. Pobiera tylko brakujące fragmenty zamiast całego zakresu za każdym razem:
// przy zmianie zakresu 24 h → 7 dni dociąga starsze dni, a przy odświeżeniu — wyłącznie nowe rekordy.
import { CFG, isNum, lowerBound, mergeRows } from "./logic.js";
import { dbRef, fb, now } from "./state.js";

const H = CFG.historia,
  DAY = 86400e3;

export class HistoryCache {
  constructor(path) {
    this.path = path;
    this.reset();
  }
  reset() {
    this.rows = []; // posortowane po `czas`
    this.from = Infinity; // od kiedy zakres jest kompletny
    this.fetchedAt = 0;
    this.pending = null;
    this.gen = (this.gen || 0) + 1; // unieważnia zapytania sprzed wylogowania
  }
  /** Rekordy z czas >= start. */
  since(start) {
    return this.rows.slice(lowerBound(this.rows, start));
  }
  /** Zapewnia dane od `start`; nowe rekordy dociąga, gdy ostatnie pobranie jest starsze niż maxAge. */
  async ensure(start, maxAge = 60000) {
    while (this.pending) await this.pending.catch(() => {});
    if (start >= this.from && now() - this.fetchedAt < maxAge) return this.since(start);
    this.pending = this.#load(start).finally(() => (this.pending = null));
    await this.pending;
    return this.since(start);
  }
  async #load(start) {
    const gen = this.gen,
      t = now(),
      limit = (ms) => Math.min(Math.ceil((ms / DAY) * H.probekNaDzien * 1.2) + 100, 60000);
    const fetch = async (from, to) => {
      const c = [fb.orderByChild("czas"), fb.startAt(from)];
      if (to !== undefined) c.push(fb.endAt(to));
      c.push(fb.limitToLast(limit((to ?? t) - from)));
      const snap = await fb.get(fb.query(dbRef(this.path), ...c)),
        rows = [];
      snap.forEach((ch) => {
        const v = ch.val();
        if (v && isNum(v.czas)) rows.push(v);
      });
      rows.sort((a, b) => a.czas - b.czas);
      return { rows, full: rows.length >= limit((to ?? t) - from) };
    };
    let rows = this.rows,
      from = this.from;
    if (!rows.length && from === Infinity) {
      const r = await fetch(start);
      rows = r.rows;
      from = r.full && rows.length ? rows[0].czas : start;
    } else {
      if (start < from) {
        const r = await fetch(start, from - 1);
        rows = mergeRows(r.rows, rows);
        from = r.full && r.rows.length ? r.rows[0].czas : start;
      }
      const r = await fetch(rows.length ? rows.at(-1).czas + 1 : from);
      rows = mergeRows(rows, r.rows);
    }
    if (gen !== this.gen) return; // w międzyczasie nastąpiło wylogowanie
    const keepFrom = t - H.maxDni * DAY - 3600e3;
    if (from < keepFrom) {
      rows = rows.slice(lowerBound(rows, keepFrom));
      from = keepFrom;
    }
    Object.assign(this, { rows, from, fetchedAt: t });
  }
}

export const workHistory = new HistoryCache("pompa/historia");
export const weatherHistory = new HistoryCache("pompa/historiaPogody");
export const resetHistory = () => (workHistory.reset(), weatherHistory.reset());
