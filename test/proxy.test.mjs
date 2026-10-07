import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  sanitizeSchema,
  newTurnPrompt,
  applyTier,
  claudeModels,
  conversationKey,
  sessionOf,
  startProxy,
  requestTokensOf,
} from "../src/proxy.mjs";

test("only the sentinel model is routed", () => {
  assert.equal(isAuto("jev-router"), true);
  assert.equal(isAuto("claude-opus-4-6"), false, "a model the user picked is theirs");
  assert.equal(isAuto("claude-haiku-4-5-20251001"), false, "internal Haiku calls pass through");
  assert.equal(isAuto(undefined), false);
});

test("the sentinel is not mistaken for a real tier", () => {
  assert.equal(tierOf("jev-router"), null);
});
import { tierOf, isAuto } from "../src/config.mjs";
import { writeDecision, writeStatus, readStatus, pruneStale, writePrivate, STATUS_DIR } from "../src/status.mjs";
import { mkdirSync, statSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

test("reads the session id out of Claude Code's metadata", () => {
  const sid = "11111111-2222-4333-8444-555555555555";
  assert.equal(sessionOf({ metadata: { user_id: JSON.stringify({ session_id: sid }) } }), sid);
  assert.equal(sessionOf({ metadata: { user_id: "not-json" } }), "");
  assert.equal(sessionOf({}), "");
});

test("status round-trips per session and misses cleanly", () => {
  const sid = `test-${process.pid}`;
  writeStatus(sid, { tier: "opus", confidence: 0.87, reason: "jev" });
  assert.deepEqual(readStatus(sid), { tier: "opus", confidence: 0.87, reason: "jev" });
  assert.equal(readStatus("no-such-session"), null);
  assert.doesNotThrow(() => writeStatus("", { tier: "opus" }));
});

test("status files are private to their owner", { skip: process.platform === "win32" }, () => {
  const sid = `perm-${process.pid}`;
  writeStatus(sid, { tier: "opus" });
  assert.equal(statSync(STATUS_DIR).mode & 0o777, 0o700);
  assert.equal(statSync(join(STATUS_DIR, `${sid}.json`)).mode & 0o777, 0o600);
});

test("files handed to Claude Code are private to their owner", { skip: process.platform === "win32" }, () => {
  const file = join(STATUS_DIR, `private-${process.pid}.json`);
  writePrivate(file, "{}");
  assert.equal(statSync(STATUS_DIR).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("a file an earlier version left readable is tightened", { skip: process.platform === "win32" }, () => {
  const file = join(STATUS_DIR, `loose-${process.pid}.json`);
  mkdirSync(STATUS_DIR, { recursive: true });
  writeFileSync(file, "{}", { mode: 0o644 });
  writePrivate(file, "{}");
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("stale status files are pruned and fresh ones kept", () => {
  mkdirSync(STATUS_DIR, { recursive: true });
  const stale = join(STATUS_DIR, `stale-${process.pid}.json`);
  const fresh = join(STATUS_DIR, `fresh-${process.pid}.json`);
  writeFileSync(stale, "{}");
  writeFileSync(fresh, "{}");
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(stale, old, old);
  assert.ok(pruneStale() >= 1);
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(fresh), true);
});

test("routing status retains the exact recent Jev exchanges", () => {
  const sid = `history-${process.pid}`;
  writeDecision(sid, { prompt: "first", jev: { request: { id: 1 }, response: { confidence: 0.6 } } });
  writeDecision(sid, { prompt: "second", jev: { request: { id: 2 }, response: { confidence: 0.8 } } });
  const status = readStatus(sid);
  assert.equal(status.prompt, "second");
  assert.deepEqual(status.history.map(({ prompt }) => prompt), ["first", "second"]);
  assert.equal(status.history[0].jev.response.confidence, 0.6);
});

test("recognises older model versions within a tier", () => {
  assert.equal(tierOf("claude-sonnet-4-6"), "sonnet");
  assert.equal(tierOf("claude-sonnet-5"), "sonnet");
  assert.equal(tierOf("claude-haiku-4-5-20251001"), "haiku");
  assert.equal(tierOf("claude-opus-4-1"), "opus");
  assert.equal(tierOf("claude-fable-5-1[1m]"), "fable");
  assert.equal(tierOf("gpt-9"), null);
  assert.equal(tierOf(undefined), null);
});

test("keeps available Claude model versions as separate Jev choices", () => {
  assert.deepEqual(
    claudeModels([
      { id: "claude-opus-5", display_name: "Claude Opus 5" },
      { id: "claude-opus-4-8", display_name: "Claude Opus 4.8" },
    ]).map(({ id, tier }) => ({ id, tier })),
    [
      { id: "claude-opus-5", tier: "opus" },
      { id: "claude-opus-4-8", tier: "opus" },
    ],
  );
});

test("Claude proxy sends exact account models to Jev and routes the chosen version", async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.url.startsWith("/v1/models")) {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({
          data: [
            { id: "claude-opus-5", display_name: "Claude Opus 5" },
            { id: "claude-opus-4-8", display_name: "Claude Opus 4.8" },
            { id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
          ],
        }));
      }
      seen.push(JSON.parse(Buffer.concat(chunks)));
      res.setHeader("content-type", "application/json");
      res.end('{"id":"msg_1","type":"message","model":"claude-opus-4-8"}');
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());

  const { port, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async ({ models }) => {
      assert.deepEqual(models.map((model) => model.id), [
        "claude-opus-5",
        "claude-opus-4-8",
        "claude-sonnet-5",
      ]);
      return { choice: "claude-opus-4-8", confidence: 0.91, ms: 1 };
    },
  });
  t.after(close);

  await fetch(`http://127.0.0.1:${port}/v1/models`).then((response) => response.json());
  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "jev-router",
      tools: [{ name: "Bash" }],
      messages: [{ role: "user", content: "debug this race" }],
    }),
  });

  assert.equal(seen[0].model, "claude-opus-4-8");
});

test("a routed request without metadata is recorded under the conversation key", async (t) => {
  const upstream = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end('{"id":"msg_1","type":"message","model":"claude-sonnet-5-5"}');
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());

  const { port, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async () => ({ choice: "claude-sonnet-5-5", confidence: 0.77, ms: 1 }),
  });
  t.after(close);

  // Exactly what `claude -p` sends first: no metadata, so no session id.
  const body = {
    model: "jev-router",
    tools: [{ name: "Bash" }],
    messages: [{ role: "user", content: `rename this variable ${process.pid}` }],
  };
  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  assert.equal(sessionOf(body), "", "the request carries no session id");
  const status = readStatus(conversationKey(body));
  assert.ok(status, "the decision is filed under the conversation key instead of being dropped");
  assert.equal(status.tier, "sonnet");
  assert.equal(status.confidence, 0.77);
});

const withTools = (messages) => ({ tools: [{ name: "Bash" }], messages });

test("converts a draft-04 boolean exclusiveMinimum into a draft 2020-12 number", () => {
  const schema = { type: "object", properties: { topN: { minimum: 0, exclusiveMinimum: true } } };
  sanitizeSchema(schema);
  assert.deepEqual(schema.properties.topN, { exclusiveMinimum: 0 });
});

test("drops a false exclusiveMaximum and keeps the bound", () => {
  const schema = { properties: { n: { maximum: 10, exclusiveMaximum: false } } };
  sanitizeSchema(schema);
  assert.deepEqual(schema.properties.n, { maximum: 10 });
});

test("leaves an already-valid numeric bound alone", () => {
  const schema = { properties: { n: { exclusiveMinimum: 5 } } };
  sanitizeSchema(schema);
  assert.equal(schema.properties.n.exclusiveMinimum, 5);
});

test("reaches schemas nested in arrays and sub-objects", () => {
  const schema = { anyOf: [{ items: { minimum: 1, exclusiveMinimum: true } }] };
  sanitizeSchema(schema);
  assert.deepEqual(schema.anyOf[0].items, { exclusiveMinimum: 1 });
});

test("survives null and primitive nodes", () => {
  assert.doesNotThrow(() => sanitizeSchema(null));
  assert.doesNotThrow(() => sanitizeSchema({ a: null, b: 3, c: "x" }));
});

test("reads a plain string prompt as a new turn", () => {
  assert.equal(newTurnPrompt(withTools([{ role: "user", content: "fix the bug" }])), "fix the bug");
});

test("reads a text block prompt as a new turn", () => {
  const body = withTools([{ role: "user", content: [{ type: "text", text: "fix the bug" }] }]);
  assert.equal(newTurnPrompt(body), "fix the bug");
});

test("ignores a tool_result continuation mid-turn", () => {
  const body = withTools([
    { role: "user", content: "fix the bug" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] },
  ]);
  assert.equal(newTurnPrompt(body), null);
});

test("ignores auxiliary calls that carry no tools", () => {
  const body = { messages: [{ role: "user", content: "summarise this" }] };
  assert.equal(newTurnPrompt(body), null);
});

test("ignores a request whose last message is from the assistant", () => {
  const body = withTools([{ role: "assistant", content: "thinking" }]);
  assert.equal(newTurnPrompt(body), null);
});

test("ignores an empty prompt", () => {
  assert.equal(newTurnPrompt(withTools([{ role: "user", content: "   " }])), null);
});

test("survives a malformed body", () => {
  assert.equal(newTurnPrompt(undefined), null);
  assert.equal(newTurnPrompt({}), null);
  assert.equal(newTurnPrompt({ tools: [], messages: [] }), null);
});

test("strips system reminders Claude Code injects into the prompt", () => {
  const body = withTools([
    {
      role: "user",
      content: "fix the bug\n<system-reminder>be careful\nabout things</system-reminder>",
    },
  ]);
  assert.equal(newTurnPrompt(body), "fix the bug");
});

test("a prompt that is only a system reminder is not a turn", () => {
  const body = withTools([{ role: "user", content: "<system-reminder>noise</system-reminder>" }]);
  assert.equal(newTurnPrompt(body), null);
});

test("routing to haiku strips fields haiku cannot accept", () => {
  const body = {
    model: "claude-sonnet-4-6",
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
  };
  applyTier(body, "haiku");
  assert.equal(body.model, "claude-haiku-4-5-20251001");
  assert.equal(body.thinking, undefined);
  assert.equal(body.output_config, undefined);
  assert.equal(body.context_management, undefined);
});

test("routing to haiku keeps context-management strategies unrelated to thinking", () => {
  const body = {
    model: "claude-sonnet-4-6",
    context_management: { edits: [{ type: "clear_tool_uses_20250919" }, { type: "clear_thinking_20251015" }] },
  };
  applyTier(body, "haiku");
  assert.deepEqual(body.context_management, { edits: [{ type: "clear_tool_uses_20250919" }] });
});

test("routing to opus leaves thinking and effort intact", () => {
  const body = {
    model: "claude-sonnet-4-6",
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
  };
  applyTier(body, "opus");
  assert.equal(body.model, "claude-opus-5-5");
  assert.deepEqual(body.thinking, { type: "adaptive" });
  assert.deepEqual(body.output_config, { effort: "medium" });
});

test("routing to opus 5.5 drops disabled thinking and forced tool choice it rejects", () => {
  const body = {
    model: "jev-router",
    thinking: { type: "disabled" },
    tool_choice: { type: "tool", name: "Read", disable_parallel_tool_use: true },
  };
  applyTier(body, "opus", "claude-opus-5-5");
  assert.equal(body.thinking, undefined);
  assert.deepEqual(body.tool_choice, { type: "auto", disable_parallel_tool_use: true });
});

test("sonnet 5.5 gets the same treatment, provider prefix or not", () => {
  const body = { model: "jev-router", thinking: { type: "disabled" }, tool_choice: { type: "any" } };
  applyTier(body, "sonnet", "anthropic/claude-sonnet-5-5");
  assert.equal(body.thinking, undefined);
  assert.deepEqual(body.tool_choice, { type: "auto" });
});

test("older models keep disabled thinking and forced tool choice", () => {
  const body = { model: "jev-router", thinking: { type: "disabled" }, tool_choice: { type: "any" } };
  applyTier(body, "opus", "claude-opus-5");
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.deepEqual(body.tool_choice, { type: "any" });
});

test("a trailing system message does not hide the user's new turn", () => {
  const body = withTools([
    { role: "user", content: [{ type: "text", text: "<system-reminder>ctx</system-reminder>\nfix the bug" }] },
    { role: "system", content: [{ type: "text", text: "# Environment" }] },
  ]);
  assert.equal(newTurnPrompt(body), "fix the bug");
});

test("routing to haiku folds mid-conversation system messages into the system prompt", () => {
  const body = {
    model: "jev-router",
    system: [{ type: "text", text: "base" }],
    messages: [
      { role: "user", content: "hi" },
      { role: "system", content: [{ type: "text", text: "env", cache_control: { type: "ephemeral" } }] },
    ],
  };
  applyTier(body, "haiku");
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
  assert.deepEqual(body.system, [{ type: "text", text: "base" }, { type: "text", text: "env" }]);
});

test("models that accept system messages keep them in place", () => {
  const messages = [{ role: "user", content: "hi" }, { role: "system", content: "env" }];
  for (const model of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"]) {
    const body = { model: "jev-router", system: "base", messages: structuredClone(messages) };
    applyTier(body, "opus", model);
    assert.deepEqual(body.messages, messages, model);
    assert.equal(body.system, "base", model);
  }
});

test("a string system prompt survives folding", () => {
  const body = { model: "jev-router", system: "base", messages: [{ role: "user", content: "hi" }, { role: "system", content: "env" }] };
  applyTier(body, "sonnet", "claude-sonnet-5");
  assert.deepEqual(body.system, [{ type: "text", text: "base" }, { type: "text", text: "env" }]);
});

test("request size counts system, tools and messages, images at their cap, not signatures", () => {
  const base = requestTokensOf({ system: "", tools: [], messages: [] });
  const big = requestTokensOf({ system: "x".repeat(4000), tools: [], messages: [] });
  assert.equal(big - base, 1000);
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(400000) } };
  const withImage = requestTokensOf({ messages: [{ role: "user", content: [image] }] });
  assert.ok(withImage >= 4784 && withImage < 4784 + 100, String(withImage));
  const thinking = { type: "thinking", thinking: "", signature: "S".repeat(400000) };
  assert.ok(requestTokensOf({ messages: [{ role: "assistant", content: [thinking] }] }) < 100);
});

const routeOnce = async (t, { tools, choice, prompt = "say hi" }) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.setHeader("content-type", "application/json");
      res.end('{"id":"msg_1","type":"message"}');
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  let offered;
  const { port, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async ({ models }) => ((offered = models.map((m) => m.id)), { choice, confidence: 0.99, ms: 1 }),
  });
  t.after(close);
  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "jev-router", tools, messages: [{ role: "user", content: `${prompt} ${Math.random()}` }] }),
  });
  return { model: seen[0].model, offered };
};

test("a request too large for haiku's window steps up instead of failing there", async (t) => {
  // ~160k estimated tokens of tool definitions: over 75% of Haiku's 200k window.
  const tools = [{ name: "Bash", description: "x".repeat(640000) }];
  const { model, offered } = await routeOnce(t, { tools, choice: "claude-haiku-4-5-20251001", prompt: "use haiku" });
  assert.ok(!offered.includes("claude-haiku-4-5-20251001"), "haiku is not offered to Jev");
  assert.equal(model, "claude-sonnet-5-5", "an explicit haiku request steps up to the next model that fits");
});

test("a small request can still route to haiku", async (t) => {
  const { model } = await routeOnce(t, { tools: [{ name: "Bash" }], choice: "claude-haiku-4-5-20251001" });
  assert.equal(model, "claude-haiku-4-5-20251001");
});

test("an unknown tier leaves the request untouched", () => {
  const body = { model: "claude-sonnet-4-6", thinking: { type: "adaptive" } };
  applyTier(body, "nonsense");
  assert.equal(body.model, "claude-sonnet-4-6");
});

test("a conversation keeps one key as it grows, and differs from a sub-agent", () => {
  const main = { messages: [{ role: "user", content: "main task" }] };
  const grown = {
    messages: [{ role: "user", content: "main task" }, { role: "assistant", content: "ok" }],
  };
  const sub = { messages: [{ role: "user", content: "sub-agent task" }] };
  assert.equal(conversationKey(main), conversationKey(grown));
  assert.notEqual(conversationKey(main), conversationKey(sub));
});

test("the key ignores the cache_control breakpoint Claude Code moves between requests", () => {
  const first = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>x</system-reminder>" },
          { type: "text", text: "do the thing", cache_control: { type: "ephemeral", ttl: "1h" } },
        ],
      },
    ],
  };
  const later = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>x</system-reminder>" },
          { type: "text", text: "do the thing" },
        ],
      },
      { role: "assistant", content: "working" },
    ],
  };
  assert.equal(conversationKey(first), conversationKey(later));
});

test("the same opening text in two sessions gets two keys", () => {
  const mk = (id) => ({
    metadata: { user_id: JSON.stringify({ session_id: id }) },
    messages: [{ role: "user", content: "same opening" }],
  });
  assert.notEqual(conversationKey(mk("a")), conversationKey(mk("b")));
});

test("the key survives metadata that is not JSON", () => {
  const body = { metadata: { user_id: "not-json" }, messages: [{ role: "user", content: "hi" }] };
  assert.doesNotThrow(() => conversationKey(body));
});

const fakeUpstream = async (t, onRequest) => {
  const server = http.createServer(onRequest);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
};

const recordingUpstream = (t, seen, models = []) =>
  fakeUpstream(t, (req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url.startsWith("/v1/models")) return res.end(JSON.stringify({ data: models }));
      seen.push(JSON.parse(Buffer.concat(chunks)));
      res.end('{"id":"msg_1","type":"message"}');
    });
  });

const post = (port, body) =>
  fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((response) => response.text());

test("a turn that outgrows its model mid-task steps up to one that fits", async (t) => {
  const seen = [];
  const upstreamURL = await recordingUpstream(t, seen, [
    { id: "claude-haiku-4-5-20251001", max_input_tokens: 1000 },
    { id: "claude-sonnet-5-5" },
  ]);
  const { port, close } = await startProxy({
    upstreamURL,
    route: async () => ({ choice: "claude-haiku-4-5-20251001", confidence: 0.95, ms: 1 }),
  });
  t.after(close);
  await fetch(`http://127.0.0.1:${port}/v1/models`).then((response) => response.text());

  const opening = { role: "user", content: `rename this variable ${process.pid}-grow` };
  await post(port, { model: "jev-router", tools: [{ name: "Bash" }], messages: [opening] });
  await post(port, {
    model: "jev-router",
    tools: [{ name: "Bash" }],
    messages: [
      opening,
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(4000) }] },
    ],
  });

  assert.equal(seen[0].model, "claude-haiku-4-5-20251001");
  assert.equal(seen[1].model, "claude-sonnet-5-5", "the follow-up no longer fits Haiku's window");
});

test("a routing failure still sends a real model, never the sentinel", async (t) => {
  const seen = [];
  const upstreamURL = await recordingUpstream(t, seen);
  const { port, close } = await startProxy({
    upstreamURL,
    route: async () => {
      throw new Error("router exploded");
    },
  });
  t.after(close);

  await post(port, {
    model: "jev-router",
    tools: [{ name: "Bash" }],
    messages: [{ role: "user", content: `fix this ${process.pid}-fail` }],
  });

  assert.notEqual(seen[0].model, "jev-router");
  assert.equal(tierOf(seen[0].model), "opus");
});

test("a client that disconnects mid-stream cancels the upstream request", async (t) => {
  let upstreamClosed;
  const closed = new Promise((resolve) => (upstreamClosed = resolve));
  const upstreamURL = await fakeUpstream(t, (req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const timer = setInterval(() => res.write("data: {}\n\n"), 10);
      res.on("close", () => {
        clearInterval(timer);
        upstreamClosed(true);
      });
    });
  });
  const { port, close } = await startProxy({ upstreamURL });
  t.after(close);

  const client = http.request({ host: "127.0.0.1", port, path: "/v1/messages", method: "POST" }, (res) => {
    res.once("data", () => client.destroy());
  });
  client.on("error", () => {});
  client.end(JSON.stringify({ model: "claude-opus-5-5", messages: [] }));

  const timeout = new Promise((resolve) => setTimeout(() => resolve(false), 2000));
  assert.equal(await Promise.race([closed, timeout]), true, "upstream kept streaming after the client left");
});
