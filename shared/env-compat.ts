import { applyLegacyEnvAliases } from "./legacy-compat";
export { applyLegacyEnvAliases } from "./legacy-compat";
// Import before entry points load configuration. Current settings always win.
applyLegacyEnvAliases();
