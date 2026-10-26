import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWebFetchTool } from "./src/agents/tools/web-fetch.js";
import { markdownToText } from "./src/agents/tools/web-fetch-utils.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-fetch-inline-proof-"));
process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
const fixtures = [
  {
    name: "reported-single-and-double-backticks",
    body: "Use `![alt](image.png)` and ``[label](https://example.com)``; read [guide](https://example.com).",
    expected: "Use ![alt](image.png) and [label](https://example.com); read guide.",
  },
  {
    name: "ordinary-link-image-and-image-alt-code",
    body: "Read [guide](https://example.com), omit ![image](image.png) and ![alt `code`](image.png), keep `literal`.",
    expected: "Read guide, omit and , keep literal.",
  },
  {
    name: "multiline-inline-span",
    body: "Use `[label](https://example.com)\n![alt](image.png)` today.",
    expected: "Use [label](https://example.com) ![alt](image.png) today.",
  },
  {
    name: "embedded-single-backtick",
    body: "Use ``alpha ` beta [label](url)`` today.",
    expected: "Use alpha ` beta [label](url) today.",
  },
  {
    name: "fenced-code-sibling",
    body: "Read [guide](url).\n\n```text\n# literal\n![alt](image.png)\n[label](url)\n    indented\n```",
    expected: "Read guide.\n\n# literal\n![alt](image.png)\n[label](url)\n    indented",
  },
  {
    name: "literal-marker-prefix",
    body: "Prefix \0" + "0\0 then `![alt](image.png)` and [guide](url).",
    expected: "then ![alt](image.png) and guide.",
  },
];
let requests = 0;
const server = createServer((request, response) => {
  const fixture = fixtures.find((row) => request.url?.split("?")[0] === `/${row.name}`);
  requests += 1;
  response.writeHead(fixture ? 200 : 404, { "content-type": "text/markdown; charset=utf-8" });
  response.end(fixture?.body ?? "not found");
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert(address && typeof address === "object");
const tool = createWebFetchTool({ config: {
  plugins: { enabled: false },
  tools: { web: { fetch: { cacheTtlMinutes: 0, ssrfPolicy: { allowedHostnames: ["127.0.0.1"] } } } },
} });
assert(tool, "web_fetch enabled");
const observations: unknown[] = [];
const failures: string[] = [];
const spillPaths = new Set<string>();
try {
  for (const fixture of fixtures) {
    for (const extractMode of ["text", "markdown"] as const) {
      const result = await tool.execute(`proof-${fixture.name}-${extractMode}`, {
        url: `http://127.0.0.1:${address.port}/${fixture.name}?mode=${extractMode}`,
        extractMode,
        maxChars: 10000,
      });
      const block = result.content.find((entry) => entry.type === "text");
      assert(block?.type === "text", "tool text result");
      const envelope = JSON.parse(block.text);
      assert.equal(envelope.status, 200, "real HTTP response accepted");
      assert.equal(envelope.extractor, "cf-markdown", "Markdown response extraction path");
      assert.equal(typeof envelope.text, "string");
      if (typeof envelope.spill?.path === "string") spillPaths.add(envelope.spill.path);
      const expected = extractMode === "markdown" ? fixture.body.replaceAll("\0", "") : fixture.expected;
      const passed = envelope.text.includes(expected);
      const observation = { fixture: fixture.name, extractMode, passed, expected, result: envelope };
      observations.push(observation);
      console.log(JSON.stringify(observation));
      if (!passed) failures.push(`${fixture.name}/${extractMode}`);
    }
  }
  const markerInput = "Prefix \0" + "0\0 then `![alt](image.png)` and [guide](url).";
  const markerExpected = "Prefix \0" + "0\0 then ![alt](image.png) and guide.";
  const markerResult = markdownToText(markerInput);
  const markerPassed = markerResult === markerExpected;
  observations.push({ fixture: "utility-marker-collision", markerInput, markerExpected, markerResult, passed: markerPassed });
  if (!markerPassed) failures.push("utility-marker-collision");
  assert.equal(requests, fixtures.length * 2, "each mode reaches the real HTTP server without cache");
  const report = {
    sourceSha: process.env.TARGET_SHA,
    scope: "Real node:http loopback server and production createWebFetchTool.execute; no mocked network, provider, or extraction. Marker utility control also calls markdownToText directly. No external service, browser, model, or live Gateway.",
    requests,
    observations,
    failures,
  };
  await fs.writeFile("web-fetch-proof.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ requests, failures }));
  if (failures.length) {
    console.error("BEHAVIOR_ASSERTION_FAILURES");
    process.exitCode = 2;
  } else console.log("WEB_FETCH_INLINE_CODE_PROOF_PASS");
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all([...spillPaths].map((spillPath) => fs.rm(spillPath, { force: true })));
  await fs.rm(root, { recursive: true, force: true });
}
