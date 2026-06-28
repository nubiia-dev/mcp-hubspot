/**
 * Unit tests for generic CRM tools (getCrmTools).
 *
 * Strategy: mock the global `fetch` via `mockFetchSuccess` / `mockFetchError`
 * to test the full tool handler → HubSpotClient → fetch pipeline without
 * network calls. Each test validates:
 *
 * 1. Happy path: tool calls the correct endpoint and returns mapped data.
 * 2. Error path: HubSpot API errors are caught and returned as { isError: true }.
 * 3. Validation path: invalid `objectType` is rejected by Zod before any HTTP call.
 *
 * Tools tested:
 * - hubspot_crm_list          (deals + calls)
 * - hubspot_crm_get           (deals)
 * - hubspot_crm_create        (deals + calls)
 * - hubspot_crm_update        (deals)
 * - hubspot_crm_archive       (deals)
 * - hubspot_crm_search        (deals)
 * - hubspot_crm_batch_create  (deals)
 * - hubspot_crm_batch_read    (deals)
 * - hubspot_crm_batch_update  (deals)
 * - hubspot_crm_batch_archive (deals)
 * - hubspot_crm_batch_upsert  (deals)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { HubSpotClient } from '../hubspot-client.js';
import { getCrmTools } from '../tools/crm/index.js';
import { type Tool } from '../types/common.js';
import { mockFetchSuccess, mockFetchError } from './mock-client.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const ACCESS_TOKEN = 'test-token-crm';

/** Creates a fresh client + tool array before each test. */
function makeTools(): { client: HubSpotClient; tools: Tool[] } {
  const client = new HubSpotClient({ accessToken: ACCESS_TOKEN });
  const tools = getCrmTools(client);
  return { client, tools };
}

/** Looks up a tool by name and asserts it exists. */
function getTool(tools: Tool[], name: string): Tool {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found in getCrmTools() output`);
  return tool;
}

/** Minimal SimplePublicObject fixture for a deal. */
const DEAL_FIXTURE = {
  id: '111',
  properties: { dealname: 'Test Deal', amount: '5000' },
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-06-01T00:00:00.000Z',
  archived: false,
};

/** Minimal SimplePublicObject fixture for a call engagement. */
const CALL_FIXTURE = {
  id: '222',
  properties: { hs_call_title: 'Discovery Call', hs_timestamp: '1735689600000' },
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-06-01T00:00:00.000Z',
  archived: false,
};

/** Batch response wrapper. */
function batchResponse<T>(results: T[]) {
  return {
    status: 'COMPLETE',
    results,
    startedAt: '2025-01-01T00:00:00.000Z',
    completedAt: '2025-01-01T00:00:01.000Z',
  };
}

// ---------------------------------------------------------------------------
// Suite: getCrmTools — exported set
// ---------------------------------------------------------------------------

describe('getCrmTools', () => {
  it('returns exactly 13 tools', () => {
    const { tools } = makeTools();
    expect(tools).toHaveLength(13);
  });

  it('contains every expected tool name', () => {
    const { tools } = makeTools();
    const names = tools.map((t) => t.name);
    const expected = [
      'hubspot_crm_list',
      'hubspot_crm_get',
      'hubspot_crm_create',
      'hubspot_crm_update',
      'hubspot_crm_archive',
      'hubspot_crm_search',
      'hubspot_crm_batch_create',
      'hubspot_crm_batch_read',
      'hubspot_crm_batch_update',
      'hubspot_crm_batch_archive',
      'hubspot_crm_batch_upsert',
      'hubspot_search_by_property',
      'hubspot_search_recent',
    ];
    for (const name of expected) {
      expect(names).toContain(name);
    }
  });

  it('every tool has a non-empty description', () => {
    const { tools } = makeTools();
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });

  it('every tool inputSchema has type=object with required array', () => {
    const { tools } = makeTools();
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(Array.isArray(tool.inputSchema.required)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Suite: hubspot_crm_list
// ---------------------------------------------------------------------------

describe('hubspot_crm_list', () => {
  beforeEach(() => {
    mockFetchSuccess({
      results: [DEAL_FIXTURE],
      paging: { next: { after: '10' } },
    });
  });

  it('returns paginated deal results with normalized pagination shape', async () => {
    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_list');

    const result = await tool.handler({ objectType: 'deals' });
    // The handler now returns the canonical { results, total, pagination } shape
    // rather than the raw HubSpot CollectionResponse.
    expect(result).toMatchObject({
      results: [expect.objectContaining({ id: '111' })],
      total: 1,
      pagination: { nextCursor: '10' },
    });
  });

  it('works with calls objectType', async () => {
    mockFetchSuccess({ results: [CALL_FIXTURE], paging: null });

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_list');

    const result = await tool.handler({ objectType: 'calls' });
    expect(result).toMatchObject({ results: [expect.objectContaining({ id: '222' })] });
  });

  it('throws ZodError for invalid objectType', async () => {
    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_list');

    await expect(tool.handler({ objectType: 'not_a_real_type' })).rejects.toThrow();
  });

  it('returns isError on HubSpot API error', async () => {
    mockFetchError({ status: 'error', message: 'Missing scopes', category: 'MISSING_SCOPES' }, 403);

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_list');

    const result = (await tool.handler({ objectType: 'deals' })) as {
      isError: boolean;
      content: { text: string }[];
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Missing scopes/);
  });

  it('applies default limit=10 when omitted', async () => {
    const fetchMock = mockFetchSuccess({ results: [], paging: null });

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_list');

    await tool.handler({ objectType: 'deals' });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('limit=10');
  });

  it('passes properties query param when provided', async () => {
    const fetchMock = mockFetchSuccess({ results: [], paging: null });

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_list');

    await tool.handler({ objectType: 'deals', properties: 'dealname,amount' });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('properties=dealname%2Camount');
  });
});

// ---------------------------------------------------------------------------
// Suite: hubspot_crm_get
// ---------------------------------------------------------------------------

describe('hubspot_crm_get', () => {
  it('retrieves a deal by ID', async () => {
    mockFetchSuccess(DEAL_FIXTURE);

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_get');

    const result = await tool.handler({ objectType: 'deals', id: '111' });
    expect(result).toMatchObject({ id: '111' });
  });

  it('constructs the correct URL path', async () => {
    const fetchMock = mockFetchSuccess(DEAL_FIXTURE);

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_get');

    await tool.handler({ objectType: 'deals', id: '111' });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/crm/v3/objects/deals/111');
  });

  it('returns isError on 404', async () => {
    mockFetchError(
      { status: 'error', message: 'Object not found', category: 'OBJECT_NOT_FOUND' },
      404
    );

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_get');

    const result = (await tool.handler({ objectType: 'deals', id: '999' })) as {
      isError: boolean;
    };
    expect(result.isError).toBe(true);
  });

  it('throws ZodError when id is missing', async () => {
    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_get');

    await expect(tool.handler({ objectType: 'deals' })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Suite: hubspot_crm_create
// ---------------------------------------------------------------------------

describe('hubspot_crm_create', () => {
  it('creates a deal and returns the created record', async () => {
    mockFetchSuccess(DEAL_FIXTURE);

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_create');

    const result = await tool.handler({
      objectType: 'deals',
      properties: { dealname: 'Test Deal', amount: '5000' },
    });
    expect(result).toMatchObject({ id: '111' });
  });

  it('creates a call engagement with hs_timestamp', async () => {
    mockFetchSuccess(CALL_FIXTURE);

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_create');

    const result = await tool.handler({
      objectType: 'calls',
      properties: {
        hs_timestamp: '1735689600000',
        hs_call_title: 'Discovery Call',
        hs_call_direction: 'OUTBOUND',
      },
    });
    expect(result).toMatchObject({ id: '222' });
  });

  it('sends properties in the POST body', async () => {
    const fetchMock = mockFetchSuccess(DEAL_FIXTURE);

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_create');

    await tool.handler({
      objectType: 'deals',
      properties: { dealname: 'Acme', amount: '9000' },
    });

    const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(requestInit.body as string) as {
      properties: Record<string, string>;
    };
    expect(body.properties.dealname).toBe('Acme');
    expect(body.properties.amount).toBe('9000');
  });

  it('includes inline associations when provided', async () => {
    const fetchMock = mockFetchSuccess(DEAL_FIXTURE);

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_create');

    await tool.handler({
      objectType: 'deals',
      properties: { dealname: 'Deal with contact' },
      associations: [
        {
          to: { id: '456' },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }],
        },
      ],
    });

    const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(requestInit.body as string) as {
      associations: unknown[];
    };
    expect(body.associations).toHaveLength(1);
  });

  it('omits associations key when no associations provided', async () => {
    const fetchMock = mockFetchSuccess(DEAL_FIXTURE);

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_create');

    await tool.handler({
      objectType: 'deals',
      properties: { dealname: 'Plain deal' },
    });

    const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(requestInit.body as string) as Record<string, unknown>;
    expect(body['associations']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Suite: hubspot_crm_update
// ---------------------------------------------------------------------------

describe('hubspot_crm_update', () => {
  it('patches a deal with updated properties', async () => {
    const updated = { ...DEAL_FIXTURE, properties: { ...DEAL_FIXTURE.properties, amount: '9999' } };
    mockFetchSuccess(updated);

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_update');

    const result = await tool.handler({
      objectType: 'deals',
      id: '111',
      properties: { amount: '9999' },
    });
    expect(result).toMatchObject({ id: '111' });
  });

  it('uses PATCH method', async () => {
    const fetchMock = mockFetchSuccess(DEAL_FIXTURE);

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_update');

    await tool.handler({ objectType: 'deals', id: '111', properties: { dealstage: 'closedwon' } });

    const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect(requestInit.method).toBe('PATCH');
  });

  it('constructs the correct URL path with ID', async () => {
    const fetchMock = mockFetchSuccess(DEAL_FIXTURE);

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_update');

    await tool.handler({ objectType: 'deals', id: '111', properties: {} });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/crm/v3/objects/deals/111');
  });
});

// ---------------------------------------------------------------------------
// Suite: hubspot_crm_archive
// ---------------------------------------------------------------------------

describe('hubspot_crm_archive', () => {
  it('archives a deal successfully', async () => {
    mockFetchSuccess({}, 204);

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_archive');

    const result = await tool.handler({ objectType: 'deals', id: '111' });
    expect(result).toMatchObject({ success: true, id: '111', archived: true });
  });

  it('uses DELETE method', async () => {
    const fetchMock = mockFetchSuccess({}, 204);

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_archive');

    await tool.handler({ objectType: 'deals', id: '111' });

    const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect(requestInit.method).toBe('DELETE');
  });

  it('returns isError on 404', async () => {
    mockFetchError({ status: 'error', message: 'Not found' }, 404);

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_archive');

    const result = (await tool.handler({ objectType: 'deals', id: '999' })) as {
      isError: boolean;
    };
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite: hubspot_crm_search
// ---------------------------------------------------------------------------

describe('hubspot_crm_search', () => {
  it('searches deals with a filter group', async () => {
    mockFetchSuccess({ results: [DEAL_FIXTURE], paging: null });

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_search');

    const result = await tool.handler({
      objectType: 'deals',
      filterGroups: [
        {
          filters: [{ propertyName: 'amount', operator: 'GTE', value: '1000' }],
        },
      ],
      properties: ['dealname', 'amount'],
    });
    expect(result).toMatchObject({ results: [expect.objectContaining({ id: '111' })] });
  });

  it('uses POST method to the /search endpoint', async () => {
    const fetchMock = mockFetchSuccess({ results: [], paging: null });

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_search');

    await tool.handler({ objectType: 'deals' });

    const url = fetchMock.mock.calls[0][0] as string;
    const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect(url).toContain('/crm/v3/objects/deals/search');
    expect(requestInit.method).toBe('POST');
  });

  it('works with full-text query parameter', async () => {
    const fetchMock = mockFetchSuccess({ results: [DEAL_FIXTURE], paging: null });

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_search');

    await tool.handler({ objectType: 'deals', query: 'acme' });

    const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(requestInit.body as string) as { query: string };
    expect(body.query).toBe('acme');
  });

  it('returns isError on authentication error (401)', async () => {
    mockFetchError(
      { status: 'error', message: 'Invalid authentication', category: 'INVALID_AUTHENTICATION' },
      401
    );

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_search');

    const result = (await tool.handler({ objectType: 'deals' })) as { isError: boolean };
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite: hubspot_crm_batch_create
// ---------------------------------------------------------------------------

describe('hubspot_crm_batch_create', () => {
  it('batch creates deals', async () => {
    mockFetchSuccess(batchResponse([DEAL_FIXTURE]));

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_batch_create');

    const result = await tool.handler({
      objectType: 'deals',
      inputs: [{ properties: { dealname: 'Batch Deal', amount: '1000' } }],
    });
    expect(result).toMatchObject({
      status: 'COMPLETE',
      results: [expect.objectContaining({ id: '111' })],
    });
  });

  it('calls the batch/create endpoint', async () => {
    const fetchMock = mockFetchSuccess(batchResponse([]));

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_batch_create');

    await tool.handler({
      objectType: 'deals',
      inputs: [{ properties: { dealname: 'D1' } }],
    });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/crm/v3/objects/deals/batch/create');
  });

  it('throws ZodError when inputs exceeds 100', async () => {
    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_batch_create');

    const inputs = Array.from({ length: 101 }, (_, i) => ({
      properties: { dealname: `Deal ${i}` },
    }));

    await expect(tool.handler({ objectType: 'deals', inputs })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Suite: hubspot_crm_batch_read
// ---------------------------------------------------------------------------

describe('hubspot_crm_batch_read', () => {
  it('batch reads deals by ID', async () => {
    mockFetchSuccess(batchResponse([DEAL_FIXTURE]));

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_batch_read');

    const result = await tool.handler({
      objectType: 'deals',
      inputs: [{ id: '111' }],
      properties: ['dealname', 'amount'],
    });
    expect(result).toMatchObject({
      status: 'COMPLETE',
      results: [expect.objectContaining({ id: '111' })],
    });
  });

  it('sends idProperty when specified', async () => {
    const fetchMock = mockFetchSuccess(batchResponse([DEAL_FIXTURE]));

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_batch_read');

    await tool.handler({
      objectType: 'deals',
      inputs: [{ id: 'external-123' }],
      idProperty: 'hs_external_id',
    });

    const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(requestInit.body as string) as { idProperty: string };
    expect(body.idProperty).toBe('hs_external_id');
  });
});

// ---------------------------------------------------------------------------
// Suite: hubspot_crm_batch_update
// ---------------------------------------------------------------------------

describe('hubspot_crm_batch_update', () => {
  it('batch updates deals', async () => {
    mockFetchSuccess(batchResponse([DEAL_FIXTURE]));

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_batch_update');

    const result = await tool.handler({
      objectType: 'deals',
      inputs: [{ id: '111', properties: { amount: '8888' } }],
    });
    expect(result).toMatchObject({ status: 'COMPLETE' });
  });

  it('calls the batch/update endpoint', async () => {
    const fetchMock = mockFetchSuccess(batchResponse([]));

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_batch_update');

    await tool.handler({
      objectType: 'deals',
      inputs: [{ id: '111', properties: {} }],
    });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/crm/v3/objects/deals/batch/update');
  });
});

// ---------------------------------------------------------------------------
// Suite: hubspot_crm_batch_archive
// ---------------------------------------------------------------------------

describe('hubspot_crm_batch_archive', () => {
  it('batch archives deals and returns count', async () => {
    mockFetchSuccess({}, 204);

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_batch_archive');

    const result = await tool.handler({
      objectType: 'deals',
      inputs: [{ id: '111' }, { id: '222' }],
    });
    expect(result).toMatchObject({ success: true, archived: 2 });
  });

  it('calls batch/archive endpoint', async () => {
    const fetchMock = mockFetchSuccess({}, 204);

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_batch_archive');

    await tool.handler({ objectType: 'deals', inputs: [{ id: '111' }] });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/crm/v3/objects/deals/batch/archive');
  });
});

// ---------------------------------------------------------------------------
// Suite: hubspot_crm_batch_upsert
// ---------------------------------------------------------------------------

describe('hubspot_crm_batch_upsert', () => {
  it('batch upserts deals', async () => {
    mockFetchSuccess(batchResponse([DEAL_FIXTURE]));

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_batch_upsert');

    const result = await tool.handler({
      objectType: 'deals',
      inputs: [
        {
          idProperty: 'hs_external_id',
          id: 'ext-001',
          properties: { dealname: 'Upserted Deal' },
        },
      ],
    });
    expect(result).toMatchObject({ status: 'COMPLETE' });
  });

  it('calls batch/upsert endpoint', async () => {
    const fetchMock = mockFetchSuccess(batchResponse([]));

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_batch_upsert');

    await tool.handler({
      objectType: 'deals',
      inputs: [{ idProperty: 'hs_external_id', id: 'x', properties: {} }],
    });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/crm/v3/objects/deals/batch/upsert');
  });

  it('throws ZodError for invalid objectType on upsert', async () => {
    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_batch_upsert');

    await expect(
      tool.handler({
        objectType: 'widgets',
        inputs: [{ idProperty: 'hs_external_id', id: 'x', properties: {} }],
      })
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Suite: Object type coverage across all 9 types
// ---------------------------------------------------------------------------

describe('CRM tools — objectType coverage', () => {
  const objectTypes = [
    'deals',
    'line_items',
    'products',
    'quotes',
    'calls',
    'meetings',
    'tasks',
    'notes',
    'emails',
  ];

  it.each(objectTypes)('hubspot_crm_list accepts objectType=%s', async (objectType) => {
    mockFetchSuccess({ results: [], paging: null });

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_list');

    const result = await tool.handler({ objectType });
    // Should NOT return an error response
    expect((result as { isError?: boolean }).isError).toBeUndefined();
  });

  it('hubspot_crm_list rejects unknown objectType', async () => {
    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_list');

    await expect(tool.handler({ objectType: 'invoices' })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Suite: batch error paths (previously uncovered catch branches)
// ---------------------------------------------------------------------------

describe('hubspot_crm_batch_read — error path', () => {
  it('returns isError when the API call fails', async () => {
    mockFetchError({ status: 'error', message: 'Not found' }, 404);

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_batch_read');

    const result = (await tool.handler({
      objectType: 'deals',
      inputs: [{ id: '999' }],
    })) as { isError: boolean };

    expect(result.isError).toBe(true);
  });
});

describe('hubspot_crm_batch_update — error path', () => {
  it('returns isError when the API call fails', async () => {
    mockFetchError({ status: 'error', message: 'Validation error' }, 400);

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_batch_update');

    const result = (await tool.handler({
      objectType: 'deals',
      inputs: [{ id: '111', properties: { amount: 'invalid' } }],
    })) as { isError: boolean };

    expect(result.isError).toBe(true);
  });
});

describe('hubspot_crm_batch_archive — error path', () => {
  it('returns isError when the API call fails', async () => {
    mockFetchError({ status: 'error', message: 'Server error' }, 500);

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_batch_archive');

    const result = (await tool.handler({
      objectType: 'deals',
      inputs: [{ id: '111' }],
    })) as { isError: boolean };

    expect(result.isError).toBe(true);
  });
});

describe('hubspot_crm_batch_upsert — error path', () => {
  it('returns isError when the API call fails', async () => {
    mockFetchError({ status: 'error', message: 'Missing scopes' }, 403);

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_batch_upsert');

    const result = (await tool.handler({
      objectType: 'deals',
      inputs: [{ idProperty: 'hs_external_id', id: 'ext-001', properties: { dealname: 'Test' } }],
    })) as { isError: boolean };

    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite: more error paths (create, update, batch_create)
// ---------------------------------------------------------------------------

describe('hubspot_crm_create — error path', () => {
  it('returns isError when the POST call fails', async () => {
    mockFetchError({ status: 'error', message: 'Validation error' }, 400);

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_create');

    const result = (await tool.handler({
      objectType: 'deals',
      properties: { dealname: 'Fail Deal' },
    })) as { isError: boolean };

    expect(result.isError).toBe(true);
  });
});

describe('hubspot_crm_update — error path', () => {
  it('returns isError when the PATCH call fails', async () => {
    mockFetchError({ status: 'error', message: 'Not found' }, 404);

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_update');

    const result = (await tool.handler({
      objectType: 'deals',
      id: '999',
      properties: { dealname: 'Updated' },
    })) as { isError: boolean };

    expect(result.isError).toBe(true);
  });
});

describe('hubspot_crm_batch_create — error path', () => {
  it('returns isError when the batch POST call fails', async () => {
    mockFetchError({ status: 'error', message: 'Server error' }, 500);

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_batch_create');

    const result = (await tool.handler({
      objectType: 'deals',
      inputs: [{ properties: { dealname: 'Fail Deal' } }],
    })) as { isError: boolean };

    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite: crm_search with after cursor (line 591 branch)
// ---------------------------------------------------------------------------

describe('hubspot_crm_search — after cursor pagination', () => {
  it('includes after cursor in the search body when provided', async () => {
    const fetchMock = mockFetchSuccess({ results: [DEAL_FIXTURE], paging: null });

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_search');

    await tool.handler({ objectType: 'deals', after: '100' });

    const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(requestInit.body as string) as { after: string };
    expect(body.after).toBe('100');
  });
});

// ---------------------------------------------------------------------------
// Suite: crm_batch_read with propertiesWithHistory (line 752 branch)
// ---------------------------------------------------------------------------

describe('hubspot_crm_batch_read — propertiesWithHistory', () => {
  it('includes propertiesWithHistory in the request body when provided', async () => {
    const fetchMock = mockFetchSuccess({
      status: 'COMPLETE',
      results: [DEAL_FIXTURE],
      startedAt: '2025-01-01T00:00:00Z',
      completedAt: '2025-01-01T00:00:01Z',
    });

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_crm_batch_read');

    await tool.handler({
      objectType: 'deals',
      inputs: [{ id: '111' }],
      propertiesWithHistory: ['amount', 'dealstage'],
    });

    const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(requestInit.body as string) as {
      propertiesWithHistory: string[];
    };
    expect(body.propertiesWithHistory).toEqual(['amount', 'dealstage']);
  });
});

// ---------------------------------------------------------------------------
// Suite: hubspot_search_by_property
// ---------------------------------------------------------------------------

describe('hubspot_search_by_property', () => {
  it('POSTs to the /search endpoint with the right single filter', async () => {
    const fetchMock = mockFetchSuccess({ results: [DEAL_FIXTURE], paging: null });

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_search_by_property');

    const result = await tool.handler({
      objectType: 'deals',
      propertyName: 'dealname',
      value: 'Acme',
      operator: 'CONTAINS_TOKEN',
      properties: ['dealname', 'amount'],
    });

    const url = fetchMock.mock.calls[0][0] as string;
    const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect(url).toContain('/crm/v3/objects/deals/search');
    expect(requestInit.method).toBe('POST');

    const body = JSON.parse(requestInit.body as string) as {
      filterGroups: { filters: { propertyName: string; operator: string; value: string }[] }[];
      properties: string[];
    };
    expect(body.filterGroups[0].filters[0]).toEqual({
      propertyName: 'dealname',
      operator: 'CONTAINS_TOKEN',
      value: 'Acme',
    });
    expect(body.properties).toEqual(['dealname', 'amount']);
    expect(result).toMatchObject({ results: [expect.objectContaining({ id: '111' })] });
  });

  it('defaults the operator to EQ when omitted', async () => {
    const fetchMock = mockFetchSuccess({ results: [], paging: null });

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_search_by_property');

    await tool.handler({
      objectType: 'contacts',
      propertyName: 'email',
      value: 'jane@example.com',
    });

    const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(requestInit.body as string) as {
      filterGroups: { filters: { operator: string }[] }[];
    };
    expect(body.filterGroups[0].filters[0].operator).toBe('EQ');
  });

  it('throws ZodError when propertyName is missing', async () => {
    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_search_by_property');

    await expect(tool.handler({ objectType: 'deals', value: 'Acme' })).rejects.toThrow();
  });

  it('returns isError on HubSpot API error', async () => {
    mockFetchError({ status: 'error', message: 'Missing scopes' }, 403);

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_search_by_property');

    const result = (await tool.handler({
      objectType: 'deals',
      propertyName: 'dealname',
      value: 'Acme',
    })) as { isError: boolean };
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite: hubspot_search_recent
// ---------------------------------------------------------------------------

describe('hubspot_search_recent', () => {
  it('resolves hs_lastmodifieddate for field=modified with a DESCENDING sort', async () => {
    const fetchMock = mockFetchSuccess({ results: [DEAL_FIXTURE], paging: null });

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_search_recent');

    const result = await tool.handler({
      objectType: 'deals',
      since: '2025-01-01T00:00:00Z',
      properties: ['dealname'],
    });

    const url = fetchMock.mock.calls[0][0] as string;
    const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect(url).toContain('/crm/v3/objects/deals/search');
    expect(requestInit.method).toBe('POST');

    const body = JSON.parse(requestInit.body as string) as {
      filterGroups: { filters: { propertyName: string; operator: string; value: string }[] }[];
      sorts: { propertyName: string; direction: string }[];
    };
    expect(body.filterGroups[0].filters[0]).toEqual({
      propertyName: 'hs_lastmodifieddate',
      operator: 'GTE',
      value: '2025-01-01T00:00:00Z',
    });
    expect(body.sorts[0]).toEqual({
      propertyName: 'hs_lastmodifieddate',
      direction: 'DESCENDING',
    });
    expect(result).toMatchObject({ results: [expect.objectContaining({ id: '111' })] });
  });

  it('resolves createdate for field=created', async () => {
    const fetchMock = mockFetchSuccess({ results: [], paging: null });

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_search_recent');

    await tool.handler({
      objectType: 'deals',
      since: '1735689600000',
      field: 'created',
    });

    const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(requestInit.body as string) as {
      filterGroups: { filters: { propertyName: string }[] }[];
      sorts: { propertyName: string; direction: string }[];
    };
    expect(body.filterGroups[0].filters[0].propertyName).toBe('createdate');
    expect(body.sorts[0]).toEqual({ propertyName: 'createdate', direction: 'DESCENDING' });
  });

  it('honors the dateProperty override (e.g., contacts lastmodifieddate)', async () => {
    const fetchMock = mockFetchSuccess({ results: [], paging: null });

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_search_recent');

    await tool.handler({
      objectType: 'contacts',
      since: '2025-06-01T00:00:00Z',
      dateProperty: 'lastmodifieddate',
    });

    const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(requestInit.body as string) as {
      filterGroups: { filters: { propertyName: string }[] }[];
      sorts: { propertyName: string }[];
    };
    expect(body.filterGroups[0].filters[0].propertyName).toBe('lastmodifieddate');
    expect(body.sorts[0].propertyName).toBe('lastmodifieddate');
  });

  it('throws ZodError when since is missing', async () => {
    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_search_recent');

    await expect(tool.handler({ objectType: 'deals' })).rejects.toThrow();
  });

  it('returns isError on HubSpot API error', async () => {
    mockFetchError({ status: 'error', message: 'Server error' }, 500);

    const { tools } = makeTools();
    const tool = getTool(tools, 'hubspot_search_recent');

    const result = (await tool.handler({
      objectType: 'deals',
      since: '2025-01-01T00:00:00Z',
    })) as { isError: boolean };
    expect(result.isError).toBe(true);
  });
});
