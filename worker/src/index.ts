import { DurableObject } from "cloudflare:workers";
import { type Db, migrate } from "@agent-tracker/core";
import { api } from "./api.ts";

export interface Env {
  TRACKER: DurableObjectNamespace<Tracker>;
  ASSETS: Fetcher;
  TRACKER_TOKEN: string;
  /** Local dev only: "1" skips the bearer check. */
  AUTH_DISABLED?: string;
}

/** One instance ("main") holds all data in its SQLite storage: a strongly consistent single writer. */
export class Tracker extends DurableObject<Env> {
  db: Db;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    this.db = {
      async all(q, params = []) {
        return sql.exec(q, ...params).toArray() as any[];
      },
      async batch(stmts) {
        ctx.storage.transactionSync(() => {
          for (const s of stmts) sql.exec(s.sql, ...(s.params ?? []));
        });
      },
    };
    ctx.blockConcurrencyWhile(() => migrate(this.db));
  }
  fetch(req: Request) {
    return api(this.db, req);
  }
}

async function authorized(req: Request, token: string | undefined) {
  const got = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!token || !got) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([got, token].map((s) => crypto.subtle.digest("SHA-256", enc.encode(s))));
  return crypto.subtle.timingSafeEqual(a, b);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (!path.startsWith("/api/") && path !== "/mcp") return env.ASSETS.fetch(req);
    if (env.AUTH_DISABLED !== "1" && !(await authorized(req, env.TRACKER_TOKEN)))
      return Response.json({ error: "unauthorized" }, { status: 401 });
    return env.TRACKER.get(env.TRACKER.idFromName("main")).fetch(req);
  },
} satisfies ExportedHandler<Env>;
