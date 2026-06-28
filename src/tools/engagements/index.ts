/**
 * HubSpot Engagements tool: log an engagement and associate it to CRM records.
 *
 * Engagements (notes, calls, emails, meetings, tasks) are first-class CRM objects
 * in HubSpot, but creating one and linking it to the records it relates to
 * normally requires several steps: create the engagement via the generic CRM
 * endpoint, then issue a separate association call per related record while
 * knowing the right property names and association wiring.
 *
 * `hubspot_engagements_log` collapses that into a single tool call:
 *
 * 1. It maps friendly parameters (`body`, `subject`, `timestamp`, `ownerId`) to
 *    the correct engagement-type-specific HubSpot properties.
 * 2. It creates the engagement on the right object path
 *    (notes / calls / emails / meetings / tasks).
 * 3. It associates the new engagement to any number of contacts, deals,
 *    companies, and tickets using the v4 DEFAULT association endpoint — no
 *    association type IDs required.
 *
 * @module tools/engagements
 */

import { z } from 'zod';
import { type Tool } from '../../types/common.js';
import { type HubSpotClient } from '../../hubspot-client.js';
import { handleToolError } from '../../utils/error-handler.js';
import { type SimplePublicObject } from '../../types/hubspot-api.js';

// ---------------------------------------------------------------------------
// Engagement type → object path / target object type maps
// ---------------------------------------------------------------------------

/**
 * The CRM v3 object path used to create each engagement type.
 *
 * @see {@link https://developers.hubspot.com/docs/api/crm/engagements}
 */
const ENGAGEMENT_OBJECT_PATH = {
  note: 'notes',
  call: 'calls',
  email: 'emails',
  meeting: 'meetings',
  task: 'tasks',
} as const;

/** Engagement types supported by this tool. */
type EngagementType = keyof typeof ENGAGEMENT_OBJECT_PATH;

/**
 * The v4 association target object type used for each kind of record id.
 *
 * Used to build the DEFAULT association URL:
 * `/crm/v4/objects/{engagementPath}/{id}/associations/default/{toObjectType}/{toId}`.
 */
const ASSOCIATION_OBJECT_TYPE = {
  contacts: 'contacts',
  deals: 'deals',
  companies: 'companies',
  tickets: 'tickets',
} as const;

// ---------------------------------------------------------------------------
// Tool: hubspot_engagements_log
// ---------------------------------------------------------------------------

/**
 * Input schema for logging an engagement.
 */
const EngagementsLogSchema = z.object({
  engagementType: z
    .enum(['note', 'call', 'email', 'meeting', 'task'])
    .describe(
      'Type of engagement to log. Determines the object created and how `body`/`subject` ' +
        'map to HubSpot properties: note→notes, call→calls, email→emails, meeting→meetings, task→tasks.'
    ),
  body: z
    .string()
    .optional()
    .describe(
      'Main content of the engagement. Mapped per type: note→hs_note_body, call→hs_call_body, ' +
        'email→hs_email_html, meeting→hs_meeting_body, task→hs_task_body.'
    ),
  subject: z
    .string()
    .optional()
    .describe(
      'Title/subject of the engagement. Mapped per type: call→hs_call_title, email→hs_email_subject, ' +
        'meeting→hs_meeting_title, task→hs_task_subject. Ignored for notes (notes have no title).'
    ),
  timestamp: z
    .string()
    .optional()
    .describe(
      'When the engagement occurred, as an ISO 8601 date-time or epoch milliseconds string ' +
        '(hs_timestamp). Defaults to the current time when omitted.'
    ),
  ownerId: z
    .string()
    .optional()
    .describe('HubSpot user ID of the engagement owner (hubspot_owner_id).'),
  contactIds: z
    .array(z.string().min(1))
    .optional()
    .describe('HubSpot contact record IDs to associate this engagement to.'),
  dealIds: z
    .array(z.string().min(1))
    .optional()
    .describe('HubSpot deal record IDs to associate this engagement to.'),
  companyIds: z
    .array(z.string().min(1))
    .optional()
    .describe('HubSpot company record IDs to associate this engagement to.'),
  ticketIds: z
    .array(z.string().min(1))
    .optional()
    .describe('HubSpot ticket record IDs to associate this engagement to.'),
  additionalProperties: z
    .record(z.string())
    .optional()
    .describe(
      'Additional engagement properties to set (key-value map). Merged with the mapped parameters; ' +
        'explicit parameters take precedence. Use for portal-specific custom properties.'
    ),
});

/**
 * Builds the engagement `properties` map from the parsed arguments.
 *
 * Only sets a property when its source value is provided. `hs_timestamp` is
 * always set (defaulting to now). Explicit mapped parameters take precedence
 * over `additionalProperties`.
 *
 * @param args - Parsed tool arguments.
 * @returns A flat property map ready to send as `{ properties }`.
 */
function buildEngagementProperties(
  args: z.infer<typeof EngagementsLogSchema>
): Record<string, string> {
  const properties: Record<string, string> = {
    ...(args.additionalProperties ?? {}),
  };

  // Common: timestamp (default now) + optional owner
  properties['hs_timestamp'] = args.timestamp ?? String(Date.now());
  if (args.ownerId !== undefined) properties['hubspot_owner_id'] = args.ownerId;

  // Type-specific subject/body mapping (only set when provided)
  switch (args.engagementType) {
    case 'note':
      if (args.body !== undefined) properties['hs_note_body'] = args.body;
      break;
    case 'call':
      if (args.subject !== undefined) properties['hs_call_title'] = args.subject;
      if (args.body !== undefined) properties['hs_call_body'] = args.body;
      break;
    case 'email':
      if (args.subject !== undefined) properties['hs_email_subject'] = args.subject;
      if (args.body !== undefined) properties['hs_email_html'] = args.body;
      break;
    case 'meeting':
      if (args.subject !== undefined) properties['hs_meeting_title'] = args.subject;
      if (args.body !== undefined) properties['hs_meeting_body'] = args.body;
      break;
    case 'task':
      if (args.subject !== undefined) properties['hs_task_subject'] = args.subject;
      if (args.body !== undefined) properties['hs_task_body'] = args.body;
      break;
  }

  return properties;
}

/**
 * Creates the `hubspot_engagements_log` tool.
 *
 * Flow:
 * 1. Map friendly params to engagement-type-specific properties (+ additionalProperties).
 * 2. POST /crm/v3/objects/{objectPath} with { properties } to create the engagement.
 * 3. For each associated record id, PUT the v4 DEFAULT association endpoint
 *    (no association type IDs needed). Associations are created sequentially.
 * 4. Return the created engagement plus a summary of the linked record ids.
 *
 * Endpoints:
 * - POST /crm/v3/objects/{notes|calls|emails|meetings|tasks}
 * - PUT  /crm/v4/objects/{engagementPath}/{engagementId}/associations/default/{toObjectType}/{toId}
 *
 * Required scopes: the relevant engagement write scope (e.g. crm.objects.notes.write,
 * crm.objects.calls.write, etc.) plus the write scope for each associated object type
 * (crm.objects.contacts.write, crm.objects.deals.write, crm.objects.companies.write,
 * tickets).
 *
 * @param client - Authenticated HubSpotClient instance.
 * @returns Tool definition for logging an engagement and associating it to records.
 */
function buildEngagementsLogTool(client: HubSpotClient): Tool {
  return {
    name: 'hubspot_engagements_log',
    description:
      'Log a HubSpot engagement (note, call, email, meeting, or task) AND associate it to CRM ' +
      'records (contacts, deals, companies, tickets) in a single call. ' +
      'This high-level helper saves you from creating the engagement with the generic CRM tool and ' +
      'wiring up each association manually. ' +
      'Friendly params map to the right per-type properties automatically: ' +
      'note→hs_note_body; call→hs_call_title/hs_call_body; email→hs_email_subject/hs_email_html; ' +
      'meeting→hs_meeting_title/hs_meeting_body; task→hs_task_subject/hs_task_body. ' +
      'hs_timestamp defaults to now if `timestamp` is omitted. ' +
      'Associations use the v4 DEFAULT endpoint, so no association type IDs are needed. ' +
      'Required scopes: the relevant engagement write scope (e.g. crm.objects.notes.write / ' +
      'crm.objects.calls.write) plus crm.objects.contacts.write and the write scope of each ' +
      'associated object type (deals, companies, tickets).',
    inputSchema: {
      type: 'object',
      properties: {
        engagementType: {
          type: 'string',
          enum: ['note', 'call', 'email', 'meeting', 'task'],
          description:
            'Type of engagement to log. Determines the object created and property mapping ' +
            '(note→notes, call→calls, email→emails, meeting→meetings, task→tasks).',
        },
        body: {
          type: 'string',
          description:
            'Main content. Mapped per type: note→hs_note_body, call→hs_call_body, ' +
            'email→hs_email_html, meeting→hs_meeting_body, task→hs_task_body.',
        },
        subject: {
          type: 'string',
          description:
            'Title/subject. Mapped per type: call→hs_call_title, email→hs_email_subject, ' +
            'meeting→hs_meeting_title, task→hs_task_subject. Ignored for notes.',
        },
        timestamp: {
          type: 'string',
          description:
            'When the engagement occurred (hs_timestamp), as ISO 8601 or epoch ms string. ' +
            'Defaults to now when omitted.',
        },
        ownerId: {
          type: 'string',
          description: 'HubSpot user ID of the engagement owner (hubspot_owner_id).',
        },
        contactIds: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          description: 'HubSpot contact record IDs to associate this engagement to.',
        },
        dealIds: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          description: 'HubSpot deal record IDs to associate this engagement to.',
        },
        companyIds: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          description: 'HubSpot company record IDs to associate this engagement to.',
        },
        ticketIds: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          description: 'HubSpot ticket record IDs to associate this engagement to.',
        },
        additionalProperties: {
          type: 'object',
          description:
            'Additional engagement properties as key-value pairs. Merged with mapped params; ' +
            'explicit params take precedence.',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['engagementType'],
      additionalProperties: false,
    },
    handler: async (rawArgs: unknown) => {
      const args = EngagementsLogSchema.parse(rawArgs);

      try {
        const objectPath = ENGAGEMENT_OBJECT_PATH[args.engagementType as EngagementType];

        // 1 + 2. Build properties and create the engagement.
        const properties = buildEngagementProperties(args);
        const engagement = await client.post<SimplePublicObject>(
          `/crm/v3/objects/${encodeURIComponent(objectPath)}`,
          { properties }
        );

        // 3. Associate the new engagement to each related record using the
        //    v4 DEFAULT association endpoint (no association type IDs needed).
        const associations: {
          contacts: string[];
          deals: string[];
          companies: string[];
          tickets: string[];
        } = { contacts: [], deals: [], companies: [], tickets: [] };

        const associationGroups: {
          toObjectType: keyof typeof ASSOCIATION_OBJECT_TYPE;
          ids: string[];
        }[] = [
          { toObjectType: 'contacts', ids: args.contactIds ?? [] },
          { toObjectType: 'deals', ids: args.dealIds ?? [] },
          { toObjectType: 'companies', ids: args.companyIds ?? [] },
          { toObjectType: 'tickets', ids: args.ticketIds ?? [] },
        ];

        for (const group of associationGroups) {
          const toObjectType = ASSOCIATION_OBJECT_TYPE[group.toObjectType];
          for (const toId of group.ids) {
            await client.put(
              `/crm/v4/objects/${encodeURIComponent(objectPath)}/${encodeURIComponent(
                engagement.id
              )}/associations/default/${encodeURIComponent(toObjectType)}/${encodeURIComponent(toId)}`
            );
            associations[group.toObjectType].push(toId);
          }
        }

        // 4. Return the created engagement and a summary of what was linked.
        return { engagement, associations };
      } catch (error) {
        return handleToolError(error);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Domain entry point
// ---------------------------------------------------------------------------

/**
 * Returns all Engagements tools.
 *
 * Tools included:
 * - `hubspot_engagements_log`: Create an engagement and associate it to records in one shot.
 *
 * @param client - Authenticated HubSpotClient instance.
 * @returns Array of 1 Tool object ready for MCP registration.
 *
 * @example
 * import { getEngagementsTools } from './tools/engagements/index.js';
 * const tools = getEngagementsTools(client);
 */
export function getEngagementsTools(client: HubSpotClient): Tool[] {
  return [buildEngagementsLogTool(client)];
}
