import {
  type Db, getItem, ingest, listItems, listPrs, STATES, summary, timeline, validatePayload,
} from "@agent-tracker/core";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Every /api route, against whichever Db backs this deployment. Auth is checked before this runs. */
export async function api(db: Db, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const q = Object.fromEntries(url.searchParams);
  const path = url.pathname.replace(/\/+$/, "");
  try {
    if (req.method === "POST" && path === "/api/ingest") {
      const body: unknown = await req.json();
      const payloads = Array.isArray(body) ? body : [body];
      payloads.forEach(validatePayload);
      const results = [];
      for (const p of payloads) results.push({ source: p.source, home: p.home, ...(await ingest(db, p)) });
      return json({ ok: true, results });
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
    return json({ error: msg }, /payload|bad item|bad event|JSON/.test(msg) ? 400 : 500);
  }
}
