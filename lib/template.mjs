// {{key}} substitution for templates and step env, with a small
// {{#if key}}…{{else}}…{{/if}}. Keys are looked up in a flat map; a missing
// key renders empty, which is what a template wants from an unset variable.

export function render(text, vars) {
  const get = (k) => { const v = vars[k.trim()]; return v == null ? '' : String(v); };
  let out = String(text);
  // Innermost ifs first, so they may nest.
  const IF = /\{\{#if ([^}]+)\}\}((?:(?!\{\{#if )[\s\S])*?)(?:\{\{else\}\}((?:(?!\{\{#if )[\s\S])*?))?\{\{\/if\}\}/;
  for (let i = 0; i < 50 && IF.test(out); i++) out = out.replace(IF, (_, k, a, b = '') => (get(k) ? a : b));
  return out.replace(/\{\{([^#/}][^}]*)\}\}/g, (_, k) => get(k));
}

/** Every variable as an env name: domains.root → DOMAINS_ROOT. */
export function envName(key) { return key.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase(); }
