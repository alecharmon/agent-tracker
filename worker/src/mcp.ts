import { type Db, harnessOf, taskAnswer, taskAsk, taskFinish, taskStart, taskUpdate } from "@agent-tracker/core";

// Minimal MCP server over streamable HTTP: JSON-RPC in, JSON out (no SSE stream needed for
// request/response tools). Stateless: the client name from `initialize` rides along in the
// Mcp-Session-Id header so tools can label tasks with the harness.

const PROTOCOL = "2025-06-18";
const ID = { type: "string", description: "task_id exactly as task_start returned it (it also identifies your session)" };

const TOOLS = [
  {
    name: "task_start",
    description:
      "Register the task you are starting, or join an existing one by key. Call once at the start; pass the returned task_id to every later call.",
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string", description: "Short imperative title, e.g. 'Fix flaky login test'" },
        key: { type: "string", description: "Stable task key when you were given one (e.g. by a dispatching agent); joins that task" },
        parent: { type: "string", description: "Key or task_id of the task that dispatched this one" },
        dispatch: { type: "boolean", description: "Create the task for another agent to join by key, without joining it yourself" },
        detail: { type: "string", description: "One line on the plan" },
        repo: { type: "string", description: "Repository or project name (basename of the working directory)" },
        machine: { type: "string", description: "Hostname (output of `hostname -s`)" },
        model: { type: "string", description: "Your model name, e.g. 'Opus 5.5'" },
        agent: { type: "string", description: "Lane name if you have a role (e.g. 'reviewer'); defaults to the harness" },
        session: { type: "string", description: "Your harness session id, if known; restarting with it resumes the task" },
      },
    },
  },
  {
    name: "task_update",
    description: "Report a meaningful step: what you just finished or started. Include PR/issue URLs when you have them. One line.",
    inputSchema: {
      type: "object",
      required: ["task_id", "text"],
      properties: { task_id: ID, text: { type: "string" }, url: { type: "string", description: "Link for this step (PR, deploy, doc)" } },
    },
  },
  {
    name: "task_ask",
    description:
      "Ask the captain to decide something you must not guess (irreversible, costly, ambiguous, or out of scope). Explain what you need and why, and give concrete options. Then call task_answers to wait for the reply.",
    inputSchema: {
      type: "object",
      required: ["task_id", "summary", "questions"],
      properties: {
        task_id: ID,
        summary: { type: "string", description: "2-4 sentences: the situation, what you need, and what happens next" },
        questions: {
          type: "array",
          maxItems: 5,
          items: {
            type: "object",
            required: ["id", "prompt", "options"],
            properties: {
              id: { type: "string", description: "Short slug, e.g. 'deploy'" },
              prompt: { type: "string", description: "The question, ending in '?'" },
              options: {
                type: "array",
                minItems: 1,
                maxItems: 6,
                items: {
                  type: "object",
                  required: ["id", "label"],
                  properties: {
                    id: { type: "string" },
                    label: { type: "string", description: "The choice, as an action" },
                    description: { type: "string", description: "Consequence or cost of this choice" },
                  },
                },
              },
              allow_other: { type: "boolean", description: "Let the captain answer in their own words (default true)" },
            },
          },
        },
      },
    },
  },
  {
    name: "task_answers",
    description:
      "Get the captain's answer to your latest task_ask. Waits up to wait_seconds (default 25, max 50). status is 'answered' (act on it), 'pending' (keep doing safe work, call again) or 'no_question'.",
    inputSchema: {
      type: "object",
      required: ["task_id"],
      properties: { task_id: ID, wait_seconds: { type: "number", minimum: 0, maximum: 50, description: "Default 25" } },
    },
  },
  {
    name: "task_done",
    description: "Finish the task. outcome 'done' when the work is complete, 'failed' when you could not do it. Say what happened.",
    inputSchema: {
      type: "object",
      required: ["task_id", "outcome", "text"],
      properties: {
        task_id: ID,
        outcome: { type: "string", enum: ["done", "failed"] },
        text: { type: "string", description: "Result or reason, one or two lines" },
        url: { type: "string", description: "PR or artifact link" },
      },
    },
  },
] as const;

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any };

const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
function dec(s: string | null): { client?: string } {
  try {
    return s ? JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/"))) : {};
  } catch {
    return {};
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callTool(db: Db, name: string, a: any, client: string | undefined) {
  switch (name) {
    case "task_start":
      return taskStart(db, { ...a, harness: a.harness ?? client });
    case "task_update":
      return taskUpdate(db, a.task_id, a);
    case "task_ask":
      return taskAsk(db, a.task_id, { summary: a.summary, questions: a.questions });
    case "task_answers": {
      const until = Date.now() + Math.min(Math.max(Number(a.wait_seconds ?? 25), 0), 50) * 1000;
      for (;;) {
        const r = await taskAnswer(db, a.task_id);
        if (r.status !== "pending" || Date.now() >= until) return r;
        await sleep(Math.min(2000, Math.max(until - Date.now(), 0)));
      }
    }
    case "task_done":
      return taskFinish(db, a.task_id, { outcome: a.outcome, text: a.text, url: a.url });
    default:
      throw Object.assign(new Error(`unknown tool ${name}`), { rpc: -32602 });
  }
}

async function handle(db: Db, m: Rpc, session: { client?: string }) {
  switch (m.method) {
    case "initialize":
      return {
        protocolVersion: m.params?.protocolVersion ?? PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: "agent-tracker", version: "0.1.0" },
        instructions:
          "Report your work to the captain's agent tracker: task_start when you begin, task_update on meaningful steps, task_ask (then task_answers) for decisions you must not guess, task_done at the end.",
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      try {
        const out = await callTool(db, m.params?.name, m.params?.arguments ?? {}, session.client);
        return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
      } catch (e: any) {
        if (e.rpc) throw e;
        // Tool errors go back to the model as a result it can read and correct.
        return { isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] };
      }
    }
    default:
      throw Object.assign(new Error(`method not found: ${m.method}`), { rpc: -32601 });
  }
}

export async function mcp(db: Db, req: Request): Promise<Response> {
  if (req.method === "GET") return new Response("SSE stream not supported; POST JSON-RPC", { status: 405, headers: { allow: "POST" } });
  if (req.method === "DELETE") return new Response(null, { status: 204 });
  if (req.method !== "POST") return new Response(null, { status: 405 });
  let body: Rpc | Rpc[];
  try {
    body = await req.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { status: 400 });
  }
  const batch = Array.isArray(body) ? body : [body];
  let session = dec(req.headers.get("mcp-session-id"));
  const headers: Record<string, string> = { "content-type": "application/json" };
  const init = batch.find((m) => m.method === "initialize");
  if (init) {
    // ?harness= in the configured URL beats clientInfo (Devin, for one, reports the generic "rmcp").
    const hint = new URL(req.url).searchParams.get("harness");
    session = { client: harnessOf(hint ?? init.params?.clientInfo?.name) };
    headers["mcp-session-id"] = enc(session);
  }
  const out = [];
  for (const m of batch) {
    if (m.id === undefined || m.id === null) continue; // notification
    try {
      out.push({ jsonrpc: "2.0", id: m.id, result: await handle(db, m, session) });
    } catch (e: any) {
      out.push({ jsonrpc: "2.0", id: m.id, error: { code: e.rpc ?? -32603, message: e.message } });
    }
  }
  if (!out.length) return new Response(null, { status: 202, headers });
  return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), { headers });
}
