import { DurableObject } from "cloudflare:workers";
import { type Db, migrate } from "@agent-tracker/core";
import { api } from "./api.ts";
import { apiUser, type AuthEnv, authRoutes, mcpGuard, type User } from "./auth.ts";

export interface Env extends AuthEnv {
  TRACKER: DurableObjectNamespace<Tracker>;
  ASSETS: Fetcher;
  /** Local dev only: "1" skips auth entirely. */
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

const AUTH_PATHS = /^\/(authorize|register|login|logout|oauth\/|\.well-known\/)/;

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(req.url).pathname;
    const tracker = (user: User | null) => {
      const r = new Request(req);
      // Who is acting reaches the DO only from here; strip any client-supplied value.
      r.headers.delete("x-tracker-user");
      if (user) r.headers.set("x-tracker-user", user.email);
      return env.TRACKER.get(env.TRACKER.idFromName("main")).fetch(r);
    };
    if (env.AUTH_DISABLED === "1") {
      if (path === "/api/me") return Response.json({ email: "local", auth: "disabled" });
      return path.startsWith("/api/") || path === "/mcp" ? tracker(null) : env.ASSETS.fetch(req);
    }
    if (AUTH_PATHS.test(path)) return (await authRoutes(req, env, ctx)) ?? new Response("not found", { status: 404 });
    if (path === "/mcp") return mcpGuard(env, req, ctx, (user) => tracker(user));
    if (path.startsWith("/api/")) {
      const user = await apiUser(env, req);
      if (!user) return Response.json({ error: "unauthorized", login: "/login" }, { status: 401, headers: { "www-authenticate": 'Bearer realm="agent-tracker"' } });
      if (path === "/api/me") return Response.json(user);
      return tracker(user);
    }
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
