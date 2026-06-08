// File Transfer tests cover the shared node-tool invoke precondition.
import { callGatewayTool, listNodes } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, vi } from "vitest";
import { createDirListTool } from "./dir-list-tool.js";

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  callGatewayTool: vi.fn(),
  listNodes: vi.fn(),
  resolveNodeIdFromList: vi.fn(),
}));

describe("node tool invoke — no paired nodes", () => {
  it("throws a clear no-paired-nodes error before guessing a node or hitting the gateway", async () => {
    vi.mocked(listNodes).mockResolvedValue([]);
    const tool = createDirListTool();

    // A model that guesses "auto" (the reported failure) must get an actionable
    // precondition error, not a bare `unknown node: auto`.
    await expect(tool.execute("tool-call-1", { node: "auto", path: "/skills" })).rejects.toThrow(
      /no paired nodes are available/i,
    );

    expect(callGatewayTool).not.toHaveBeenCalled();
  });
});
