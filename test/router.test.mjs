import test from "node:test";
import assert from "node:assert/strict";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { jevConnection } from "../src/router.mjs";

test("no key means no routing", () => {
  assert.equal(jevConnection({}), null);
});

test("a TypeSafe key calls TypeSafe directly, even when a gateway key is also set", () => {
  assert.deepEqual(jevConnection({ JEV_API_KEY: "ts", AI_GATEWAY_API_KEY: "vg" }), { apiKey: "ts" });
  assert.deepEqual(jevConnection({ TYPESAFE_API_KEY: "ts" }), { apiKey: "ts" });
});

test("a Vercel AI Gateway key reaches Jev through the gateway", async () => {
  const seen = [];
  const client = new TypeSafeClient({
    ...jevConnection({ AI_GATEWAY_API_KEY: "vg" }),
    retry: { maxRetries: 0 },
    fetch: async (url, init) => {
      seen.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
      return new Response(
        JSON.stringify({
          model: "typesafe-ai/jev",
          answers: { ok: { type: "noul", noul: 0.9 } },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  await client.systemOne({ state: "x", questions: { ok: { type: "noul", instructions: "ok?" } } });
  assert.equal(seen[0].url, "https://ai-gateway.vercel.sh/typesafe/v1/systemone");
  assert.equal(seen[0].headers.get("authorization"), "Bearer vg");
  assert.equal(seen[0].body.model, "typesafe-ai/jev");
});
