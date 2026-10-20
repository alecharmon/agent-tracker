import { DatabaseSync } from "node:sqlite";
import type { Db } from "./store.ts";

/** node:sqlite adapter: used by the tests. */
export function nodeDb(path = ":memory:"): Db {
  const db = new DatabaseSync(path);
  return {
    async all(sql, params = []) {
      return db.prepare(sql).all(...(params as any[])) as any[];
    },
    async batch(stmts) {
      db.exec("BEGIN");
      try {
        for (const s of stmts) db.prepare(s.sql).run(...((s.params ?? []) as any[]));
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}
