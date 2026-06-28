/**
 * HubSpot Owners tools: resolve owner IDs to real users.
 *
 * Records in HubSpot (deals, contacts, companies, tickets…) reference their
 * assignee through the `hubspot_owner_id` property, whose value is an **owner
 * id** (e.g. `31012607`). On its own that number is meaningless to an LLM —
 * this toolset translates it into a human: name, email and HubSpot user id.
 *
 * Tools:
 * 1. `hubspot_owners_list` — GET /crm/v3/owners. List/search owners, optionally
 *    filtered by `email`, with cursor pagination. Use it to build an
 *    id → name/email map for the whole portal.
 * 2. `hubspot_owners_get` — GET /crm/v3/owners/{ownerId}. Resolve a single
 *    owner id (the value found in `hubspot_owner_id`) to its user.
 *
 * Required scope: `crm.objects.owners.read`.
 *
 * @see {@link https://developers.hubspot.com/docs/reference/api/crm/owners}
 * @module tools/owners
 */

import { z } from 'zod';
import { type Tool } from '../../types/common.js';
import { type HubSpotClient } from '../../hubspot-client.js';
import { handleToolError } from '../../utils/error-handler.js';

// ---------------------------------------------------------------------------
// Owner response types
// ---------------------------------------------------------------------------

/** A team an owner belongs to, as returned by the Owners API. */
interface OwnerTeam {
  id: string;
  name: string;
  primary: boolean;
}

/**
 * An owner record from the HubSpot Owners API.
 *
 * The `id` field is the value referenced by `hubspot_owner_id` on CRM records.
 * `userId` is the distinct HubSpot account user id (null for archived users,
 * in which case `userIdIncludingInactive` holds it).
 */
interface Owner {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  userId?: number | null;
  userIdIncludingInactive?: number | null;
  archived?: boolean;
  teams?: OwnerTeam[];
  createdAt?: string;
  updatedAt?: string;
}

/** Paged list response from GET /crm/v3/owners. */
interface OwnersListResponse {
  results: Owner[];
  paging?: { next?: { after: string; link?: string } };
}

/** HubSpot caps the Owners list page size at 500. */
const MAX_OWNERS_LIMIT = 500;
const DEFAULT_OWNERS_LIMIT = 100;

// ---------------------------------------------------------------------------
// Tool 1: hubspot_owners_list
// ---------------------------------------------------------------------------

/** Input schema for listing/searching owners. */
const OwnersListSchema = z.object({
  email: z
    .string()
    .optional()
    .describe('Filter to the single owner with this exact email address. Optional.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_OWNERS_LIMIT)
    .optional()
    .default(DEFAULT_OWNERS_LIMIT)
    .describe(
      `Maximum number of owners to return per page (1-${MAX_OWNERS_LIMIT}). Default: ${DEFAULT_OWNERS_LIMIT}.`
    ),
  after: z
    .string()
    .optional()
    .describe(
      'Pagination cursor. Pass the `paging.next.after` value from a previous response to get the next page.'
    ),
  archived: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'When true, return deactivated/archived owners instead of active ones. Default: false.'
    ),
});

/**
 * Creates the `hubspot_owners_list` tool.
 *
 * Endpoint: GET /crm/v3/owners
 *
 * @param client - Authenticated HubSpotClient instance.
 * @returns Tool definition for listing HubSpot owners.
 */
function buildOwnersListTool(client: HubSpotClient): Tool {
  return {
    name: 'hubspot_owners_list',
    description:
      'List the owners (users with CRM access) in the HubSpot account. Use this to translate ' +
      'the numeric owner ids found in `hubspot_owner_id` on deals/contacts/companies into real ' +
      'people — each result includes id, email, firstName, lastName and userId. ' +
      'Filter to one person with `email`, or page through everyone with `limit` + `after`. ' +
      'The `id` field is exactly the value stored in `hubspot_owner_id`. ' +
      'Required scope: crm.objects.owners.read.',
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Filter to the single owner with this exact email address. Optional.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_OWNERS_LIMIT,
          default: DEFAULT_OWNERS_LIMIT,
          description: `Owners per page (1-${MAX_OWNERS_LIMIT}). Default: ${DEFAULT_OWNERS_LIMIT}.`,
        },
        after: {
          type: 'string',
          description:
            'Pagination cursor from a previous response (`paging.next.after`) to fetch the next page.',
        },
        archived: {
          type: 'boolean',
          default: false,
          description:
            'Return archived (deactivated) owners instead of active ones. Default: false.',
        },
      },
      required: [],
      additionalProperties: false,
    },
    handler: async (rawArgs: unknown) => {
      const args = OwnersListSchema.parse(rawArgs ?? {});

      try {
        const result = await client.get<OwnersListResponse>('/crm/v3/owners', {
          email: args.email,
          limit: args.limit,
          after: args.after,
          archived: args.archived,
        });
        return result;
      } catch (error) {
        return handleToolError(error);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tool 2: hubspot_owners_get
// ---------------------------------------------------------------------------

/** Input schema for fetching a single owner. */
const OwnersGetSchema = z.object({
  ownerId: z
    .string()
    .min(1)
    .describe(
      'The owner id to resolve — this is the value found in the `hubspot_owner_id` property of a ' +
        'deal/contact/company. Example: "31012607".'
    ),
  idProperty: z
    .enum(['id', 'userId'])
    .optional()
    .default('id')
    .describe(
      'Which id the `ownerId` value refers to. "id" (default) = owner id (the hubspot_owner_id value); ' +
        '"userId" = HubSpot account user id.'
    ),
});

/**
 * Creates the `hubspot_owners_get` tool.
 *
 * Endpoint: GET /crm/v3/owners/{ownerId}
 *
 * @param client - Authenticated HubSpotClient instance.
 * @returns Tool definition for fetching a single HubSpot owner.
 */
function buildOwnersGetTool(client: HubSpotClient): Tool {
  return {
    name: 'hubspot_owners_get',
    description:
      'Resolve a single HubSpot owner id to its user (name, email, userId, teams). ' +
      'Pass the numeric value from a record’s `hubspot_owner_id` as `ownerId` to find out who ' +
      'owns that deal/contact/company. Set idProperty="userId" to look up by HubSpot user id instead. ' +
      'Required scope: crm.objects.owners.read.',
    inputSchema: {
      type: 'object',
      properties: {
        ownerId: {
          type: 'string',
          minLength: 1,
          description:
            'Owner id to resolve (the `hubspot_owner_id` value on a record). Example: "31012607".',
        },
        idProperty: {
          type: 'string',
          enum: ['id', 'userId'],
          default: 'id',
          description:
            'Whether `ownerId` is an owner id ("id", default) or a HubSpot account user id ("userId").',
        },
      },
      required: ['ownerId'],
      additionalProperties: false,
    },
    handler: async (rawArgs: unknown) => {
      const args = OwnersGetSchema.parse(rawArgs);

      try {
        const result = await client.get<Owner>(
          `/crm/v3/owners/${encodeURIComponent(args.ownerId)}`,
          { idProperty: args.idProperty }
        );
        return result;
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
 * Returns all Owners tools (resolve owner ids to users).
 *
 * Tools included:
 * - `hubspot_owners_list`: List/search owners (id → name/email map).
 * - `hubspot_owners_get`: Resolve a single owner id.
 *
 * @param client - Authenticated HubSpotClient instance.
 * @returns Array of 2 Tool objects ready for MCP registration.
 *
 * @example
 * import { getOwnersTools } from './tools/owners/index.js';
 * const tools = getOwnersTools(client);
 */
export function getOwnersTools(client: HubSpotClient): Tool[] {
  return [buildOwnersListTool(client), buildOwnersGetTool(client)];
}
