import { redactSecrets } from "../security/auth.js";

export interface ModelInfo {
  id: string;
  name: string;
  free?: boolean;
  supportsTools?: boolean;
  contextLength?: number;
}

export interface ProviderTestResult {
  ok: boolean;
  provider: string;
  modelCount?: number;
  message: string;
}

interface OpenRouterModelRaw {
  id: string;
  name?: string;
  context_length?: number;
  supported_parameters?: unknown;
  pricing?: {
    prompt?: string;
    completion?: string;
  };
}

interface GeminiModelRaw {
  name: string;
  displayName?: string;
  inputTokenLimit?: number;
  supportedGenerationMethods?: unknown;
}

function isZeroPrice(value: string | undefined): boolean {
  if (value === undefined) return false;
  return value === "0" || Number(value) === 0;
}

export async function fetchOpenRouterModels(
  apiKey?: string,
  options?: { freeToolsOnly?: boolean; signal?: AbortSignal },
): Promise<ModelInfo[]> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (apiKey?.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
  }

  let res: Response;
  try {
    res = await fetch("https://openrouter.ai/api/v1/models", {
      headers,
      signal: options?.signal,
    });
  } catch (err) {
    throw new Error(redactSecrets(`OpenRouter models request failed: ${(err as Error).message}`, [apiKey]));
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      redactSecrets(`OpenRouter models failed (${res.status}): ${text.slice(0, 200)}`.trim(), [apiKey]),
    );
  }

  const body = (await res.json()) as { data?: OpenRouterModelRaw[] };
  const rawModels = Array.isArray(body?.data) ? body.data : [];

  const models: ModelInfo[] = rawModels.map((m) => {
    const supportsTools = Array.isArray(m.supported_parameters)
      ? m.supported_parameters.includes("tools")
      : false;
    const free =
      m.pricing !== undefined &&
      isZeroPrice(m.pricing.prompt) &&
      isZeroPrice(m.pricing.completion);

    return {
      id: m.id,
      name: m.name || m.id,
      free,
      supportsTools,
      ...(typeof m.context_length === "number" ? { contextLength: m.context_length } : {}),
    };
  });

  if (options?.freeToolsOnly) {
    return models.filter((m) => m.free && m.supportsTools);
  }
  return models;
}

export async function fetchGeminiModels(
  apiKey: string,
  signal?: AbortSignal,
): Promise<ModelInfo[]> {
  const key = apiKey.trim();
  if (!key) {
    throw new Error("Gemini API key is required");
  }

  let res: Response;
  try {
    res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=100", {
      headers: {
        Accept: "application/json",
        "x-goog-api-key": key,
      },
      signal,
    });
  } catch (err) {
    throw new Error(redactSecrets(`Gemini models request failed: ${(err as Error).message}`, [key]));
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      redactSecrets(`Gemini models failed (${res.status}): ${text.slice(0, 200)}`.trim(), [key]),
    );
  }

  const body = (await res.json()) as { models?: GeminiModelRaw[] };
  const rawModels = Array.isArray(body?.models) ? body.models : [];

  return rawModels
    .filter((m) =>
      Array.isArray(m.supportedGenerationMethods)
        ? m.supportedGenerationMethods.includes("generateContent")
        : true,
    )
    .map((m) => {
      const id = m.name.replace(/^models\//, "");
      return {
        id,
        name: m.displayName || id,
        supportsTools: true,
        ...(typeof m.inputTokenLimit === "number" ? { contextLength: m.inputTokenLimit } : {}),
      };
    });
}

export async function testProviderConnection(
  provider: "openrouter" | "gemini" | "mock",
  apiKey: string,
  signal?: AbortSignal,
): Promise<ProviderTestResult> {
  if (provider === "mock") {
    return { ok: true, provider: "mock", modelCount: 1, message: "Mock provider ready" };
  }

  const key = apiKey.trim();
  if (!key) {
    return { ok: false, provider, message: `${provider} API key is required` };
  }

  if (provider === "gemini") {
    try {
      const models = await fetchGeminiModels(key, signal);
      return {
        ok: true,
        provider: "gemini",
        modelCount: models.length,
        message: `Gemini connected (${models.length} models available)`,
      };
    } catch (err) {
      return {
        ok: false,
        provider: "gemini",
        message: redactSecrets((err as Error).message, [key]),
      };
    }
  }

  // OpenRouter: verify via /auth/key first, falling back to /models if needed.
  try {
    const res = await fetch("https://openrouter.ai/api/v1/auth/key", {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
      },
      signal,
    });

    if (res.ok) {
      return {
        ok: true,
        provider: "openrouter",
        message: "OpenRouter API key verified",
      };
    }

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        provider: "openrouter",
        message: `OpenRouter authentication failed (${res.status})`,
      };
    }
  } catch {
    // Fall back to fetchOpenRouterModels below.
  }

  try {
    const models = await fetchOpenRouterModels(key, { signal });
    return {
      ok: true,
      provider: "openrouter",
      modelCount: models.length,
      message: `OpenRouter connected (${models.length} models available)`,
    };
  } catch (err) {
    return {
      ok: false,
      provider: "openrouter",
      message: redactSecrets((err as Error).message, [key]),
    };
  }
}
