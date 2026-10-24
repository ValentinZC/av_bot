import { DatabaseSync } from 'node:sqlite';
import type { Car, Filters } from '../av-source.ts';

export interface Subscription { id: number; chat: number; title: string; filters: Filters; active: boolean; initialized: boolean }
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS subscriptions(id INTEGER PRIMARY KEY, chat INTEGER NOT NULL, title TEXT NOT NULL, filters TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, initialized INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS seen(subscription INTEGER REFERENCES subscriptions(id) ON DELETE CASCADE, advert INTEGER, PRIMARY KEY(subscription,advert));
      CREATE TABLE IF NOT EXISTS outbox(subscription INTEGER REFERENCES subscriptions(id) ON DELETE CASCADE, advert INTEGER, car TEXT NOT NULL, PRIMARY KEY(subscription,advert));
      CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  }
  state(key: string) { return (this.db.prepare('SELECT value FROM state WHERE key=?').get(key) as { value: string } | undefined)?.value; }
  save(key: string, value: string) { this.db.prepare('INSERT OR REPLACE INTO state VALUES(?,?)').run(key, value); }
  add(chat: number, title: string, filters: Filters) {
    return Number(this.db.prepare('INSERT INTO subscriptions(chat,title,filters) VALUES(?,?,?)').run(chat, title, JSON.stringify(filters)).lastInsertRowid);
  }
  list(chat?: number): Subscription[] {
    const rows = chat === undefined ? this.db.prepare('SELECT * FROM subscriptions').all() : this.db.prepare('SELECT * FROM subscriptions WHERE chat=?').all(chat);
    return rows.map((row) => ({ id: Number(row.id), chat: Number(row.chat), title: String(row.title), filters: JSON.parse(String(row.filters)), active: Boolean(row.active), initialized: Boolean(row.initialized) }));
  }
  toggle(chat: number, id: number) { this.db.prepare('UPDATE subscriptions SET active=1-active WHERE id=? AND chat=?').run(id, chat); }
  remove(chat: number, id: number) { this.db.prepare('DELETE FROM subscriptions WHERE id=? AND chat=?').run(id, chat); }
  record(id: number, cars: Car[]) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const sub = this.db.prepare('SELECT active,initialized FROM subscriptions WHERE id=?').get(id);
      if (sub?.active) {
        for (const car of cars) {
          const result = this.db.prepare('INSERT OR IGNORE INTO seen VALUES(?,?)').run(id, car.id);
          if (sub.initialized && result.changes) this.db.prepare('INSERT OR IGNORE INTO outbox VALUES(?,?,?)').run(id, car.id, JSON.stringify(car));
        }
        this.db.prepare('UPDATE subscriptions SET initialized=1 WHERE id=?').run(id);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  pending() {
    return this.db.prepare('SELECT o.*,s.chat FROM outbox o JOIN subscriptions s ON s.id=o.subscription WHERE s.active=1 ORDER BY o.subscription,o.advert').all()
      .map((r) => ({ subscription: Number(r.subscription), advert: Number(r.advert), chat: Number(r.chat), car: JSON.parse(String(r.car)) as Car }));
  }
  delivered(subscription: number, advert: number) { this.db.prepare('DELETE FROM outbox WHERE subscription=? AND advert=?').run(subscription, advert); }
  close() { this.db.close(); }
}
