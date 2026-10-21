import {
  captainMessage, captainStage, type Db, getItem, ingest, listItems, listPrs, respond, sessionSignal, sessionTask, STATES,
  summary, taskAnswer, taskAsk, taskFinish, taskPending, taskPr, taskStart, taskUpdate, timeline, validatePayload,
} from "@agent-tracker/core";
import { mcp } from "./mcp.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Every /api route, against whichever Db backs this deployment. Auth is checked before this runs. */
export async function api(db: Db, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const q = Object.fromEntries(url.searchParams);
  const path = url.pathname.replace(/\/+$/, "");
  if (path === "/mcp") return mcp(db, req);
  try {
    // Agent task API (the CLI's `agents task …`; MCP tools call the same core functions).
    if (req.method === "POST" && path === "/api/tasks") return json(await taskStart(db, await req.json()), 201);
    const task = path.match(/^\/api\/tasks\/(.+)\/(update|ask|answers|done|pending|pr)$/);
    if (task) {
      const id = decodeURIComponent(task[1]);
      if (task[2] === "pending" && req.method === "GET") {
        // Hook watchers long-poll here: returns once an answer or captain message is waiting, or at the deadline.
        const until = Date.now() + Math.min(Math.max(Number(q.wait ?? 0), 0), 50) * 1000;
        for (;;) {
          const r = await taskPending(db, id);
          if (r.answer === "ready" || r.messages > 0 || Date.now() >= until) return json(r);
          await new Promise((res) => setTimeout(res, Math.min(2000, Math.max(until - Date.now(), 0))));
        }
      }
      if (task[2] === "answers" && req.method === "GET") {
        const until = Date.now() + Math.min(Math.max(Number(q.wait ?? 0), 0), 50) * 1000;
        const peek = q.peek === "1";
        for (;;) {
          const r = await taskAnswer(db, id, undefined, { peek });
          if (r.status !== "pending" || Date.now() >= until) return json(r);
          await new Promise((res) => setTimeout(res, Math.min(2000, Math.max(until - Date.now(), 0))));
        }
      }
      if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
      const body: any = await req.json();
      if (task[2] === "update") return json(await taskUpdate(db, id, body));
      if (task[2] === "ask") return json(await taskAsk(db, id, body));
      if (task[2] === "done") return json(await taskFinish(db, id, body));
      if (task[2] === "pr") return json(await taskPr(db, id, body));
    }
    // Harness hooks address sessions by the harness's own session id.
    const hook = path.match(/^\/api\/agent-sessions\/([^/]+)\/([^/]+?)(?:\/(idle|active|end))?$/);
    if (hook) {
      const [, harness, ext, kind] = hook.map((x) => x && decodeURIComponent(x));
      if (kind && req.method === "POST") return json(await sessionSignal(db, harness, ext, kind as "idle" | "active" | "end"));
      if (!kind && req.method === "GET") return json((await sessionTask(db, harness, ext)) ?? { task_id: null });
      return json({ error: "method not allowed" }, 405);
    }
    if (req.method === "POST" && path === "/api/ingest") {
      const body: unknown = await req.json();
      const payloads = Array.isArray(body) ? body : [body];
      payloads.forEach(validatePayload);
      const results = [];
      for (const p of payloads) results.push({ source: p.source, home: p.home, ...(await ingest(db, p)) });
      return json({ ok: true, results });
    }
    const captain = path.match(/^\/api\/items\/(.+)\/(respond|message|stage)$/);
    if (req.method === "POST" && captain) {
      const id = decodeURIComponent(captain[1]);
      const body: any = await req.json();
      const by = req.headers.get("x-tracker-user"); // set by the Worker from the signed-in user
      if (captain[2] === "message") return json(await captainMessage(db, id, body?.text, undefined, by));
      if (captain[2] === "stage") return json(await captainStage(db, id, body?.stage, undefined, by));
      const r = await respond(db, id, body, undefined, by);
      return r ? json(r) : json({ error: "not found" }, 404);
    }
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
    if (path === "/api/items") {
      if (q.state && !(STATES as readonly string[]).includes(q.state)) return json({ error: `state must be one of ${STATES}` }, 400);
      return json(await listItems(db, { ...q, all: q.all === "1" || q.all === "true", limit: q.limit ? Number(q.limit) : undefined }));
    }
    if (path.startsWith("/api/items/")) {
      const r = await getItem(db, decodeURIComponent(path.slice("/api/items/".length)));
      if (!r) return json({ error: "not found" }, 404);
      return "ambiguous" in r ? json({ error: "ambiguous id", matches: r.ambiguous }, 409) : json(r);
    }
    if (path === "/api/decisions") return json(await listItems(db, { state: "needs_me" }));
    if (path === "/api/prs") return json(await listPrs(db));
    if (path === "/api/summary") return json(await summary(db));
    if (path === "/api/timeline") {
      const minutes = Math.min(Math.max(Number(q.minutes) || 30, 5), 7 * 1440);
      return json(await timeline(db, new Date(Date.now() - minutes * 60_000).toISOString()));
    }
    return json({ error: "not found" }, 404);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: msg }, /^not found/.test(msg) ? 404 : /payload|bad item|bad event|bad response|bad task|JSON|message text|stage must/.test(msg) ? 400 : 500);
  }
}
