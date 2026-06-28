/**
 * Unit tests for Engagements tools (getEngagementsTools).
 *
 * Covers:
 * - hubspot_engagements_log: create an engagement and associate it to records
 *
 * Strategy: mock global `fetch` to intercept HubSpotClient HTTP calls. Because
 * the handler makes multiple fetch calls (one create + one per association),
 * assertions target specific call indices on `fetchMock.mock.calls`.
 */

import { describe, it, expect } from 'vitest';
import { HubSpotClient } from '../hubspot-client.js';
import { getEngagementsTools } from '../tools/engagements/index.js';
import { type Tool } from '../types/common.js';
import { mockFetchSuccess, mockFetchError } from './mock-client.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const ACCESS_TOKEN = 'test-token-engagements';

function makeTools(): Tool[] {
  const client = new HubSpotClient({ accessToken: ACCESS_TOKEN });
  return getEngagementsTools(client);
}

function getTool(tools: Tool[], name: string): Tool {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found in getEngagementsTools() output`);
  return tool;
}

/** Minimal engagement fixture returned by HubSpot after create. */
const ENGAGEMENT_FIXTURE = {
  id: '900',
  properties: {
    hs_note_body: 'Followed up with the customer',
    hs_timestamp: '1700000000000',
  },
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
  archived: false,
};

// ---------------------------------------------------------------------------
// Suite: getEngagementsTools — exported set
// ---------------------------------------------------------------------------

describe('getEngagementsTools', () => {
  it('returns exactly 1 tool', () => {
    const tools = makeTools();
    expect(tools).toHaveLength(1);
  });

  it('contains hubspot_engagements_log', () => {
    const tools = makeTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('hubspot_engagements_log');
  });

  it('the tool has a non-empty description', () => {
    const tools = makeTools();
    expect(tools[0].description.length).toBeGreaterThan(30);
  });
});

// ---------------------------------------------------------------------------
// Suite: hubspot_engagements_log
// ---------------------------------------------------------------------------

describe('hubspot_engagements_log', () => {
  it('creates a note and returns the engagement plus association summary', async () => {
    mockFetchSuccess(ENGAGEMENT_FIXTURE);

    const tools = makeTools();
    const tool = getTool(tools, 'hubspot_engagements_log');

    const result = (await tool.handler({
      engagementType: 'note',
      body: 'Followed up with the customer',
      contactIds: ['111'],
    })) as {
      engagement: { id: string };
      associations: { contacts: string[]; deals: string[] };
    };

    expect(result.engagement).toMatchObject({ id: '900' });
    expect(result.associations.contacts).toEqual(['111']);
    expect(result.associations.deals).toEqual([]);
  });

  it('first POSTs /crm/v3/objects/notes and then PUTs the v4 default contact association', async () => {
    const fetchMock = mockFetchSuccess(ENGAGEMENT_FIXTURE);

    const tools = makeTools();
    const tool = getTool(tools, 'hubspot_engagements_log');

    await tool.handler({
      engagementType: 'note',
      body: 'Note body',
      contactIds: ['111'],
    });

    // (a) First fetch call: create the note.
    const createUrl = fetchMock.mock.calls[0][0] as string;
    const createInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect(createUrl).toContain('/crm/v3/objects/notes');
    expect(createInit.method).toBe('POST');

    // (b) A subsequent fetch call: the v4 default association PUT.
    const assocUrl = fetchMock.mock.calls[1][0] as string;
    const assocInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect(assocUrl).toContain('/associations/default/contacts/');
    expect(assocUrl).toContain('/crm/v4/objects/notes/900/');
    expect(assocUrl).toContain('/contacts/111');
    expect(assocInit.method).toBe('PUT');
  });

  it('maps the note body to hs_note_body in the create body', async () => {
    const fetchMock = mockFetchSuccess(ENGAGEMENT_FIXTURE);

    const tools = makeTools();
    const tool = getTool(tools, 'hubspot_engagements_log');

    await tool.handler({
      engagementType: 'note',
      body: 'My note content',
    });

    const createInit = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(createInit.body as string) as {
      properties: Record<string, string>;
    };
    expect(body.properties.hs_note_body).toBe('My note content');
    // hs_timestamp is always set (defaults to now)
    expect(body.properties.hs_timestamp).toBeDefined();
  });

  it('uses the correct object path for a different type (call → /crm/v3/objects/calls)', async () => {
    const fetchMock = mockFetchSuccess(ENGAGEMENT_FIXTURE);

    const tools = makeTools();
    const tool = getTool(tools, 'hubspot_engagements_log');

    await tool.handler({
      engagementType: 'call',
      subject: 'Discovery call',
      body: 'Talked about pricing',
    });

    const createUrl = fetchMock.mock.calls[0][0] as string;
    expect(createUrl).toContain('/crm/v3/objects/calls');

    const createInit = fetchMock.mock.calls[0][1] as RequestInit;
    const reqBody = JSON.parse(createInit.body as string) as {
      properties: Record<string, string>;
    };
    expect(reqBody.properties.hs_call_title).toBe('Discovery call');
    expect(reqBody.properties.hs_call_body).toBe('Talked about pricing');
  });

  it('associates across multiple object types at distinct call indices', async () => {
    const fetchMock = mockFetchSuccess(ENGAGEMENT_FIXTURE);

    const tools = makeTools();
    const tool = getTool(tools, 'hubspot_engagements_log');

    const result = (await tool.handler({
      engagementType: 'meeting',
      subject: 'Kickoff',
      contactIds: ['111'],
      dealIds: ['222'],
    })) as { associations: { contacts: string[]; deals: string[] } };

    // 1 create + 2 associations = 3 fetch calls
    expect(fetchMock.mock.calls).toHaveLength(3);
    const contactAssoc = fetchMock.mock.calls[1][0] as string;
    const dealAssoc = fetchMock.mock.calls[2][0] as string;
    expect(contactAssoc).toContain('/associations/default/contacts/111');
    expect(dealAssoc).toContain('/associations/default/deals/222');
    expect(result.associations.contacts).toEqual(['111']);
    expect(result.associations.deals).toEqual(['222']);
  });

  it('throws ZodError when engagementType is missing', async () => {
    const tools = makeTools();
    const tool = getTool(tools, 'hubspot_engagements_log');

    await expect(tool.handler({ body: 'No type provided' })).rejects.toThrow();
  });

  it('returns isError on HubSpot API error during create', async () => {
    mockFetchError(
      {
        status: 'error',
        message: 'Property hs_timestamp is invalid',
        category: 'VALIDATION_ERROR',
      },
      400
    );

    const tools = makeTools();
    const tool = getTool(tools, 'hubspot_engagements_log');

    const result = (await tool.handler({
      engagementType: 'note',
      body: 'Some note',
    })) as { isError: boolean; content: { text: string }[] };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/hs_timestamp/);
  });
});
