// Macros are canned replies with {{variable}} placeholders.
import { bad } from "./validate.js";

const VAR = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g;

export function variablesOf(body) {
  return [...new Set([...body.matchAll(VAR)].map((m) => m[1]))];
}

// Fills every placeholder from vars; a placeholder with no value is an error naming it.
export function render(body, vars) {
  const missing = variablesOf(body).filter((v) => vars[v] === undefined || vars[v] === null);
  if (missing.length) throw bad(`macro needs values for: ${missing.join(", ")}`);
  return body.replace(VAR, (_, v) => String(vars[v]));
}
