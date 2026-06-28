/**
 * Unit tests for Owners tools (getOwnersTools).
 *
 * Covers:
 * - hubspot_owners_list: list/search owners (id → name/email map)
 * - hubspot_owners_get: resolve a single owner id
 *
 * Strategy: mock global `fetch` to intercept HubSpotClient HTTP calls.
 * Tests validate happy paths, request shape (URL + query), error handling,
 * and Zod validation for required fields.
 */

import { describe, it, expect } from 'vitest';
import { HubSpotClient } from '../hubspot-client.js';
import { getOwnersTools } from '../tools/owners/index.js';
import { type Tool } from '../types/common.js';
import { mockFetchSuccess, mockFetchError } from './mock-client.js';

const ACCESS_TOKEN = 'test-token-owners';

function makeTools(): Tool[] {
  const client = new HubSpotClient({ accessToken: ACCESS_TOKEN });
  return getOwnersTools(client);
}

function getTool(tools: Tool[], name: string): Tool {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found in getOwnersTools() output`);
  return tool;
}

/** Minimal owner fixture as returned by the Owners API. */
const OWNER_FIXTURE = {
  id: '31012607',
  email: 'eva.guasch@example.com',
  firstName: 'Eva',
  lastName: 'Guasch',
  userId: 12345,
  archived: false,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-06-01T00:00:00.000Z',
};

const OWNERS_LIST_FIXTURE = {
  results: [OWNER_FIXTURE],
  paging: { next: { after: '500', link: 'https://api.hubapi.com/crm/v3/owners?after=500' } },
};

// ---------------------------------------------------------------------------
// Suite: getOwnersTools — exported set
// ---------------------------------------------------------------------------

describe('getOwnersTools', () => {
  it('returns exactly 2 tools', () => {
    expect(makeTools()).toHaveLength(2);
  });

  it('contains hubspot_owners_list and hubspot_owners_get', () => {
    const names = makeTools().map((t) => t.name);
    expect(names).toContain('hubspot_owners_list');
    expect(names).toContain('hubspot_owners_get');
  });
});

// ---------------------------------------------------------------------------
// Suite: hubspot_owners_list
// ---------------------------------------------------------------------------

describe('hubspot_owners_list', () => {
  it('GETs /crm/v3/owners and returns the paged result', async () => {
    const fetchMock = mockFetchSuccess(OWNERS_LIST_FIXTURE);
    const tool = getTool(makeTools(), 'hubspot_owners_list');

    const result = await tool.handler({});

    const url = fetchMock.mock.calls[0][0] as string;
    const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect(url).toContain('/crm/v3/owners');
    expect(requestInit.method).toBe('GET');
    expect(result).toEqual(OWNERS_LIST_FIXTURE);
  });

  it('applies the email filter and default limit/archived in the query', async () => {
    const fetchMock = mockFetchSuccess(OWNERS_LIST_FIXTURE);
    const tool = getTool(makeTools(), 'hubspot_owners_list');

    await tool.handler({ email: 'eva.guasch@example.com' });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('email=eva.guasch%40example.com');
    expect(url).toContain('limit=100');
    expect(url).toContain('archived=false');
  });

  it('rejects a limit above the HubSpot maximum of 500', async () => {
    const tool = getTool(makeTools(), 'hubspot_owners_list');
    await expect(tool.handler({ limit: 999 })).rejects.toThrow();
  });

  it('returns a structured error when the API responds 403 (missing scope)', async () => {
    mockFetchError({ message: 'Missing crm.objects.owners.read scope' }, 403);
    const tool = getTool(makeTools(), 'hubspot_owners_list');

    const result = (await tool.handler({})) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite: hubspot_owners_get
// ---------------------------------------------------------------------------

describe('hubspot_owners_get', () => {
  it('GETs /crm/v3/owners/{ownerId} with the default idProperty', async () => {
    const fetchMock = mockFetchSuccess(OWNER_FIXTURE);
    const tool = getTool(makeTools(), 'hubspot_owners_get');

    const result = await tool.handler({ ownerId: '31012607' });

    const url = fetchMock.mock.calls[0][0] as string;
    const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect(url).toContain('/crm/v3/owners/31012607');
    expect(url).toContain('idProperty=id');
    expect(requestInit.method).toBe('GET');
    expect(result).toEqual(OWNER_FIXTURE);
  });

  it('supports looking up by userId', async () => {
    const fetchMock = mockFetchSuccess(OWNER_FIXTURE);
    const tool = getTool(makeTools(), 'hubspot_owners_get');

    await tool.handler({ ownerId: '12345', idProperty: 'userId' });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('idProperty=userId');
  });

  it('throws when ownerId is missing (Zod validation)', async () => {
    const tool = getTool(makeTools(), 'hubspot_owners_get');
    await expect(tool.handler({})).rejects.toThrow();
  });
});
