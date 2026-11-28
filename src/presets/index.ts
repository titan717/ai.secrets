/**
 * Presets module (implements PresetsModule from src/core/presets-contract.ts).
 * The supervisor and bridge import ONLY these names.
 */
import type { PresetsModule } from "../core/presets-contract.js";
import { buildOpenCodeConfig } from "./config.js";
import { resolveEffort } from "./effort.js";
import { buildProviderEnv } from "./env.js";
import { listModels, testConnection } from "./models.js";
import { PROVIDER_PRESETS, modelRef } from "./providers.js";

export { PROVIDER_PRESETS, buildOpenCodeConfig, buildProviderEnv, resolveEffort, listModels, testConnection, modelRef };

const presets: PresetsModule = { PROVIDER_PRESETS, buildOpenCodeConfig, buildProviderEnv, resolveEffort, listModels, testConnection, modelRef };
export default presets;
