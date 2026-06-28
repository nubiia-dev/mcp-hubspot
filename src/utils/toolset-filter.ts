/**
 * Toolset filtering for the HubSpot MCP server.
 *
 * Tools are grouped into domain "toolsets". The HUBSPOT_TOOLSETS environment
 * variable (comma-separated) controls which domains are exposed to the LLM.
 * When the variable is absent, all toolsets are enabled by default.
 *
 * Tool names follow the convention: `hubspot_<domain>_<action>`
 * (e.g., `hubspot_sales_list_deals`, `hubspot_workflows_get`).
 * The `findToolset` function maps a tool name back to its domain using
 * longest-prefix matching on the underscore separator.
 */
import { logger } from './logger.js';

/**
 * The canonical list of HubSpot MCP toolset domains.
 * Each domain corresponds to a directory under `src/tools/<domain>/`.
 */
export const HUBSPOT_TOOLSETS = [
  'sales',
  'engagements',
  'associations',
  'properties',
  'workflows',
  'automation',
  'actions',
  'owners',
] as const;

/** Union type of all valid HubSpot toolset names. */
export type HubSpotToolset = (typeof HUBSPOT_TOOLSETS)[number];

/**
 * Returns the list of enabled toolsets based on the HUBSPOT_TOOLSETS env var.
 *
 * When HUBSPOT_TOOLSETS is set, its value is split on commas and each item is
 * trimmed and validated against the canonical list. Invalid entries are logged
 * as warnings and silently dropped. When the env var is absent or empty, all
 * toolsets are returned.
 *
 * @returns An array of valid HubSpot toolset names to expose.
 *
 * @example
 * // HUBSPOT_TOOLSETS=sales,workflows
 * getEnabledToolsets(); // → ['sales', 'workflows']
 *
 * // HUBSPOT_TOOLSETS not set
 * getEnabledToolsets(); // → ['sales', 'engagements', 'associations', 'properties', 'workflows', 'automation']
 */
export function getEnabledToolsets(): HubSpotToolset[] {
  const envValue = process.env['HUBSPOT_TOOLSETS'];

  if (!envValue || envValue.trim() === '') {
    return [...HUBSPOT_TOOLSETS];
  }

  const requested = envValue.split(',').map((s) => s.trim().toLowerCase());
  const valid: HubSpotToolset[] = [];

  for (const name of requested) {
    if ((HUBSPOT_TOOLSETS as readonly string[]).includes(name)) {
      valid.push(name as HubSpotToolset);
    } else {
      logger.warn('Unknown toolset in HUBSPOT_TOOLSETS, ignoring', { toolset: name });
    }
  }

  return valid;
}

/**
 * Resolves the toolset domain that owns a given tool name using longest-prefix matching.
 *
 * Supports both bare toolset-prefixed names (e.g., `workflows_list`) and the
 * full HubSpot naming convention with the `hubspot_` product prefix
 * (e.g., `hubspot_workflows_list`). The `hubspot_` prefix is stripped before
 * matching so both styles resolve to the same toolset.
 *
 * A name matches toolset `t` when the (normalised) name equals `t`, starts with
 * `${t}_`, or starts with `${t}/`. Among multiple matches, the longest toolset
 * name wins to avoid false positives from shorter prefixes.
 *
 * @param name - The full tool name (e.g., `hubspot_workflows_list`).
 * @param toolsets - The list of toolset names to match against (typically from `getEnabledToolsets()`).
 * @returns The matching toolset name, or `undefined` if no toolset matches.
 *
 * @example
 * findToolset('hubspot_workflows_list', ['sales', 'workflows']); // → 'workflows'
 * findToolset('hubspot_sales_list_deals', ['sales']);             // → 'sales'
 * findToolset('hubspot_crm_list', ['workflows']);                  // → undefined
 * findToolset('workflows_list', ['workflows']);                    // → 'workflows'
 */
export function findToolset(name: string, toolsets: readonly string[]): string | undefined {
  // Normalise: strip the 'hubspot_' product prefix if present so tools named
  // 'hubspot_<toolset>_<action>' resolve to '<toolset>' correctly.
  const normalized = name.startsWith('hubspot_') ? name.slice('hubspot_'.length) : name;

  return toolsets
    .filter(
      (t) => normalized === t || normalized.startsWith(`${t}_`) || normalized.startsWith(`${t}/`)
    )
    .sort((a, b) => b.length - a.length)[0];
}
