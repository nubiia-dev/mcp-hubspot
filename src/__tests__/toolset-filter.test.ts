/**
 * Tests for toolset filtering utilities.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getEnabledToolsets, findToolset, HUBSPOT_TOOLSETS } from '../utils/toolset-filter.js';

describe('getEnabledToolsets', () => {
  const originalEnv = process.env['HUBSPOT_TOOLSETS'];

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['HUBSPOT_TOOLSETS'];
    } else {
      process.env['HUBSPOT_TOOLSETS'] = originalEnv;
    }
  });

  it('returns all toolsets when HUBSPOT_TOOLSETS is not set', () => {
    delete process.env['HUBSPOT_TOOLSETS'];
    const result = getEnabledToolsets();
    expect(result).toEqual([...HUBSPOT_TOOLSETS]);
    expect(result).toHaveLength(8);
  });

  it('includes the owners toolset and resolves owners_* tool names to it', () => {
    expect([...HUBSPOT_TOOLSETS]).toContain('owners');
    expect(findToolset('hubspot_owners_list', HUBSPOT_TOOLSETS)).toBe('owners');
    expect(findToolset('hubspot_owners_get', HUBSPOT_TOOLSETS)).toBe('owners');
  });

  it('returns only the specified toolsets when HUBSPOT_TOOLSETS is set', () => {
    process.env['HUBSPOT_TOOLSETS'] = 'sales,workflows';
    const result = getEnabledToolsets();
    expect(result).toEqual(['sales', 'workflows']);
  });

  it('trims whitespace from toolset names', () => {
    process.env['HUBSPOT_TOOLSETS'] = ' sales , workflows ';
    const result = getEnabledToolsets();
    expect(result).toEqual(['sales', 'workflows']);
  });

  it('silently drops invalid toolset names', () => {
    process.env['HUBSPOT_TOOLSETS'] = 'sales,invalid_toolset,workflows';
    const result = getEnabledToolsets();
    expect(result).toEqual(['sales', 'workflows']);
    expect(result).not.toContain('invalid_toolset');
  });

  it('returns empty array when HUBSPOT_TOOLSETS contains only invalid names', () => {
    process.env['HUBSPOT_TOOLSETS'] = 'nonexistent';
    const result = getEnabledToolsets();
    expect(result).toEqual([]);
  });

  it('returns all toolsets when HUBSPOT_TOOLSETS is empty string', () => {
    process.env['HUBSPOT_TOOLSETS'] = '';
    const result = getEnabledToolsets();
    expect(result).toEqual([...HUBSPOT_TOOLSETS]);
  });
});

describe('findToolset', () => {
  it('finds the correct toolset by prefix match', () => {
    const toolsets = ['sales', 'engagements', 'workflows'];
    expect(findToolset('hubspot_workflows_list', toolsets)).toBe('workflows');
    expect(findToolset('hubspot_sales_list_deals', toolsets)).toBe('sales');
    expect(findToolset('hubspot_engagements_get', toolsets)).toBe('engagements');
  });

  it('returns undefined when no toolset matches the tool name', () => {
    const toolsets = ['sales', 'workflows'];
    expect(findToolset('hubspot_crm_list', toolsets)).toBeUndefined();
    expect(findToolset('hubspot_properties_get', toolsets)).toBeUndefined();
  });

  it('returns undefined for an empty toolsets list', () => {
    expect(findToolset('hubspot_sales_list', [])).toBeUndefined();
  });

  it('matches the longest toolset name when multiple prefixes match', () => {
    // Hypothetical scenario: both 'work' and 'workflows' in list
    const toolsets = ['workflows', 'work'];
    const result = findToolset('hubspot_workflows_list', toolsets);
    expect(result).toBe('workflows'); // longest prefix wins
  });

  it('matches exact toolset name without underscore suffix', () => {
    const toolsets = ['sales'];
    expect(findToolset('sales', toolsets)).toBe('sales');
  });

  it('matches toolset with slash separator for backwards compatibility', () => {
    const toolsets = ['sales'];
    expect(findToolset('sales/list', toolsets)).toBe('sales');
  });

  it('returns the longest matching toolset when multiple prefixes match', () => {
    // 'sales_long_list' normalises to 'sales_long_list'.
    // Both 'sales' (via startsWith('sales_')) and 'sales_long' (via startsWith('sales_long_'))
    // match — the sort comparator (a, b) => b.length - a.length is invoked here.
    const toolsets = ['sales', 'sales_long'];
    const result = findToolset('hubspot_sales_long_list', toolsets);
    expect(result).toBe('sales_long'); // longest match wins
  });
});
