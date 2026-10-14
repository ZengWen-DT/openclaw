import path from "node:path";
import { resolveAgentDir } from "openclaw/plugin-sdk/agent-scope-runtime";
import { registerRuntimeAuthProfileStoreMutationListener } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import type {
  OpenClawConfig,
  ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { resolveEmbeddingProviderAdapterTransport } from "./embeddings.js";

/** Observe only credential publications that can affect this manager's provider. */
export function observeMemoryProviderAuthChanges(params: {
  cfg: OpenClawConfig;
  agentId: string;
  settings: ResolvedMemorySearchConfig;
  invalidate: () => void;
}): (() => void) | undefined {
  if (params.settings.provider === "none") {
    return undefined;
  }
  const providers = [params.settings.provider, params.settings.fallback].filter(
    (provider) => provider && provider !== "none",
  );
  if (
    providers.every(
      (provider) => resolveEmbeddingProviderAdapterTransport(provider, params.cfg) === "local",
    )
  ) {
    return undefined;
  }
  const agentDir = path.resolve(resolveAgentDir(params.cfg, params.agentId));
  return registerRuntimeAuthProfileStoreMutationListener((event) => {
    if (
      event.affectsInheritedStores ||
      (event.agentDir && path.resolve(event.agentDir) === agentDir)
    ) {
      params.invalidate();
    }
  });
}
