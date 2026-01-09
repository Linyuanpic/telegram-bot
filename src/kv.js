import { DEFAULT_KV_BINDING } from "./config.js";
import { resolveBindingName } from "./utils.js";

export function getKv(env) {
  const name = resolveBindingName(env, "KV_BINDING", DEFAULT_KV_BINDING);
  const kv = env?.[name];
  if (kv) return kv;
  if (name !== DEFAULT_KV_BINDING && env?.[DEFAULT_KV_BINDING]) {
    console.warn(`KV binding ${name} not found. Falling back to ${DEFAULT_KV_BINDING}.`);
    return env?.[DEFAULT_KV_BINDING];
  }
  return kv;
}
