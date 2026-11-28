import type { ListModelsOptions } from "../core/presets-contract.js";
import type { ModelInfo, ProviderId, Secrets } from "../core/types.js";

// Placeholder implementations; replaced with real model listing in the next commit.
export async function listModels(_opts: ListModelsOptions): Promise<ModelInfo[]> {
  return [];
}

export async function testConnection(
  _provider: ProviderId,
  _secrets: Secrets,
  _opts?: { fetchImpl?: typeof fetch; baseUrls?: ListModelsOptions["baseUrls"] },
): Promise<{ ok: boolean; message: string; models?: number }> {
  return { ok: false, message: "Connection test not implemented yet" };
}
