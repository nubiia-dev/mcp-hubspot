/**
 * Generic CRM tools for HubSpot MCP server — Phase 1 (Sales + Engagements).
 *
 * This module exposes 13 tools parametrized by `objectType`, covering the full
 * HubSpot v3 CRM object surface for all 12 standard types:
 * - Core objects: contacts, companies, tickets
 * - Sales objects: deals, line_items, products, quotes
 * - Engagement objects: calls, meetings, tasks, notes, emails
 *
 * Custom object type IDs (e.g. "2-12345678") are also accepted.
 *
 * Tools:
 * 1.  hubspot_crm_list          — GET  /crm/v3/objects/{type}
 * 2.  hubspot_crm_get           — GET  /crm/v3/objects/{type}/{id}
 * 3.  hubspot_crm_create        — POST /crm/v3/objects/{type}
 * 4.  hubspot_crm_update        — PATCH /crm/v3/objects/{type}/{id}
 * 5.  hubspot_crm_archive       — DELETE /crm/v3/objects/{type}/{id}
 * 6.  hubspot_crm_search        — POST /crm/v3/objects/{type}/search
 * 7.  hubspot_crm_batch_create  — POST /crm/v3/objects/{type}/batch/create
 * 8.  hubspot_crm_batch_read    — POST /crm/v3/objects/{type}/batch/read
 * 9.  hubspot_crm_batch_update  — POST /crm/v3/objects/{type}/batch/update
 * 10. hubspot_crm_batch_archive — POST /crm/v3/objects/{type}/batch/archive
 * 11. hubspot_crm_batch_upsert  — POST /crm/v3/objects/{type}/batch/upsert
 * 12. hubspot_search_by_property — POST /crm/v3/objects/{type}/search (guided single-property filter)
 * 13. hubspot_search_recent     — POST /crm/v3/objects/{type}/search (guided created/modified-since filter)
 *
 * Implementation notes:
 * - All search operations use `client.search()` which applies the stricter search rate limiter.
 * - `objectType` is validated via `validateObjectType()` before any API call.
 * - Properties must be requested explicitly — HubSpot returns only default properties otherwise.
 * - Batch operations are limited to 100 inputs per request by HubSpot.
 *
 * @module tools/crm
 */

import { z } from 'zod';
import { type Tool } from '../../types/common.js';
import { type HubSpotClient } from '../../hubspot-client.js';
import { handleToolError } from '../../utils/error-handler.js';
import {
  validateObjectType,
  isAcceptedObjectType,
  CRM_OBJECT_TYPES,
} from '../../utils/object-types.js';
import {
  SearchInputSchema,
  BatchCreateInputSchema,
  BatchReadInputSchema,
  BatchUpdateInputSchema,
  BatchIdInputSchema,
  BatchUpsertInputSchema,
  CrmPropertiesSchema,
  InlineAssociationSchema,
} from '../../schemas/common.js';
import {
  type CollectionResponse,
  type SimplePublicObject,
  type BatchResponse,
} from '../../types/hubspot-api.js';

// ---------------------------------------------------------------------------
// Shared Zod fragment: objectType enum
// ---------------------------------------------------------------------------

/** Reusable Zod schema for the objectType parameter used in every CRM tool. */
const ObjectTypeSchema = z
  .string()
  .refine(isAcceptedObjectType, {
    message:
      'Invalid CRM object type. Use a standard type ' +
      `(${CRM_OBJECT_TYPES.join(', ')}) or a custom object type ID like "2-12345678".`,
  })
  .describe(
    'CRM object type. ' +
      'Standard objects: contacts, companies, tickets, deals, line_items, products, quotes. ' +
      'Engagement objects: calls, meetings, tasks, notes, emails. ' +
      'Custom objects: pass the object type ID, e.g. "2-12345678".'
  );

// ---------------------------------------------------------------------------
// Shared JSON Schema fragments
// ---------------------------------------------------------------------------

/** JSON Schema descriptor reused across all CRM tools. */
const OBJECT_TYPE_JSON = {
  type: 'string',
  examples: [...CRM_OBJECT_TYPES],
  description:
    'CRM object type. Standard objects: contacts, companies, tickets, deals, line_items, products, quotes. ' +
    'Engagement objects: calls, meetings, tasks, notes, emails. ' +
    'Custom objects: pass the object type ID, e.g. "2-12345678".',
};

const PROPERTIES_QUERY_JSON = {
  type: 'string',
  description:
    'Comma-separated list of property internal names to include in the response ' +
    '(e.g., "dealname,amount,closedate"). HubSpot returns ONLY default properties unless ' +
    'requested explicitly — always specify the properties you need.',
};

const ASSOCIATIONS_QUERY_JSON = {
  type: 'string',
  description:
    'Comma-separated list of object types to include as associations ' +
    '(e.g., "contacts,companies"). Returns associated record IDs inline.',
};

const ARCHIVED_JSON = {
  type: 'boolean',
  description:
    'When true, returns archived (soft-deleted) records instead of active ones. Default: false.',
  default: false,
};

const AFTER_CURSOR_JSON = {
  type: 'string',
  description: 'Pagination cursor from `pagination.nextCursor` in the previous response.',
};

const LIST_LIMIT_JSON = {
  type: 'integer',
  description: 'Records per page (1–100). Default: 10.',
  minimum: 1,
  maximum: 100,
  default: 10,
};

const PROPERTIES_MAP_JSON = {
  type: 'object',
  description:
    'Key-value map of property names to string values. ' +
    'All HubSpot property values are strings. ' +
    'For engagements, `hs_timestamp` is REQUIRED (epoch ms string or ISO 8601). ' +
    'Custom properties are accepted in addition to standard ones.',
  additionalProperties: { type: 'string' },
};

const INLINE_ASSOCIATIONS_JSON = {
  type: 'array',
  description:
    'Optional associations to create atomically with this object. ' +
    'Use this to link a new deal to existing contacts in a single API call.',
  items: {
    type: 'object',
    properties: {
      to: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'HubSpot record ID of the target object.' },
        },
        required: ['id'],
      },
      types: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            associationCategory: {
              type: 'string',
              enum: ['HUBSPOT_DEFINED', 'USER_DEFINED', 'INTEGRATOR_DEFINED'],
              description: 'Association category.',
            },
            associationTypeId: {
              type: 'integer',
              description:
                'Numeric association type ID. Verify with hubspot_associations_labels_list.',
            },
          },
          required: ['associationCategory', 'associationTypeId'],
        },
      },
    },
    required: ['to', 'types'],
  },
};

// ---------------------------------------------------------------------------
// Tool 1: hubspot_crm_list
// ---------------------------------------------------------------------------

function buildListTool(client: HubSpotClient): Tool {
  const schema = z.object({
    objectType: ObjectTypeSchema,
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(10)
      .describe('Records per page (1–100). Default: 10.'),
    after: z.string().optional().describe('Pagination cursor from `pagination.nextCursor`.'),
    properties: z
      .string()
      .optional()
      .describe(
        'Comma-separated property names to return. ' +
          'HubSpot returns only default properties unless requested explicitly.'
      ),
    associations: z
      .string()
      .optional()
      .describe(
        'Comma-separated association types to include inline (e.g., "contacts,companies").'
      ),
    archived: z.boolean().default(false).describe('Include archived records. Default: false.'),
  });

  return {
    name: 'hubspot_crm_list',
    description:
      'List HubSpot CRM records of any object type (deals, line_items, products, quotes, calls, ' +
      'meetings, tasks, notes, emails). Returns a paginated collection with shape ' +
      '{ results, total, pagination: { nextCursor } | null }. ' +
      'IMPORTANT: HubSpot returns only default properties unless you specify them explicitly ' +
      'via the `properties` parameter (e.g., "dealname,amount,closedate"). ' +
      'Use `pagination.nextCursor` from the response as the `after` parameter to page through large result sets.',
    inputSchema: {
      type: 'object',
      properties: {
        objectType: OBJECT_TYPE_JSON,
        limit: LIST_LIMIT_JSON,
        after: AFTER_CURSOR_JSON,
        properties: PROPERTIES_QUERY_JSON,
        associations: ASSOCIATIONS_QUERY_JSON,
        archived: ARCHIVED_JSON,
      },
      required: ['objectType'],
      additionalProperties: false,
    },
    handler: async (rawArgs: unknown) => {
      const args = schema.parse(rawArgs);
      const validType = validateObjectType(args.objectType);
      const config = (await import('../../utils/object-types.js')).getObjectTypeConfig(validType);

      try {
        const result = await client.get<CollectionResponse<SimplePublicObject>>(
          `/${config.basePath}`,
          {
            limit: args.limit,
            after: args.after,
            properties: args.properties,
            associations: args.associations,
            archived: args.archived,
          }
        );
        // Normalize to canonical pagination shape used by all list tools:
        // { results, total, pagination: { nextCursor } | null }
        return {
          results: result.results,
          total: result.results.length,
          pagination: result.paging?.next ? { nextCursor: result.paging.next.after } : null,
        };
      } catch (error) {
        return handleToolError(error);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tool 2: hubspot_crm_get
// ---------------------------------------------------------------------------

function buildGetTool(client: HubSpotClient): Tool {
  const schema = z.object({
    objectType: ObjectTypeSchema,
    id: z.string().min(1).describe('HubSpot record ID.'),
    properties: z
      .string()
      .optional()
      .describe(
        'Comma-separated property names to return. ' +
          'HubSpot returns only default properties unless specified.'
      ),
    associations: z.string().optional().describe('Comma-separated association types to include.'),
    archived: z.boolean().default(false).describe('Retrieve archived record. Default: false.'),
  });

  return {
    name: 'hubspot_crm_get',
    description:
      'Retrieve a single HubSpot CRM record by its ID. Works with all object types. ' +
      'IMPORTANT: Specify the `properties` parameter to get non-default property values ' +
      '(e.g., "dealname,amount,closedate"). Returns 404 if the record does not exist or ' +
      'is archived (use archived=true to fetch archived records).',
    inputSchema: {
      type: 'object',
      properties: {
        objectType: OBJECT_TYPE_JSON,
        id: {
          type: 'string',
          minLength: 1,
          description: 'HubSpot record ID (numeric string, e.g., "12345678").',
        },
        properties: PROPERTIES_QUERY_JSON,
        associations: ASSOCIATIONS_QUERY_JSON,
        archived: ARCHIVED_JSON,
      },
      required: ['objectType', 'id'],
      additionalProperties: false,
    },
    handler: async (rawArgs: unknown) => {
      const args = schema.parse(rawArgs);
      const validType = validateObjectType(args.objectType);
      const config = (await import('../../utils/object-types.js')).getObjectTypeConfig(validType);

      try {
        const result = await client.get<SimplePublicObject>(
          `/${config.basePath}/${encodeURIComponent(args.id)}`,
          {
            properties: args.properties,
            associations: args.associations,
            archived: args.archived,
          }
        );
        return result;
      } catch (error) {
        return handleToolError(error);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tool 3: hubspot_crm_create
// ---------------------------------------------------------------------------

function buildCreateTool(client: HubSpotClient): Tool {
  const schema = z.object({
    objectType: ObjectTypeSchema,
    properties: CrmPropertiesSchema,
    associations: z.array(InlineAssociationSchema).optional(),
  });

  return {
    name: 'hubspot_crm_create',
    description:
      'Create a new HubSpot CRM record (deal, line item, product, quote, call, meeting, ' +
      'task, note, or email engagement). ' +
      'Required properties vary by type — for engagements, `hs_timestamp` (epoch ms string) is ' +
      'mandatory. For deals, `dealname` is required. For tasks, `hs_task_subject` is required. ' +
      'Optionally associate the new record to existing objects inline via the `associations` ' +
      'parameter (avoids a separate association API call). ' +
      'Returns the created record with its HubSpot-assigned `id`.',
    inputSchema: {
      type: 'object',
      properties: {
        objectType: OBJECT_TYPE_JSON,
        properties: PROPERTIES_MAP_JSON,
        associations: INLINE_ASSOCIATIONS_JSON,
      },
      required: ['objectType', 'properties'],
      additionalProperties: false,
    },
    handler: async (rawArgs: unknown) => {
      const args = schema.parse(rawArgs);
      const validType = validateObjectType(args.objectType);
      const config = (await import('../../utils/object-types.js')).getObjectTypeConfig(validType);

      try {
        const body: Record<string, unknown> = { properties: args.properties };
        if (args.associations && args.associations.length > 0) {
          body['associations'] = args.associations;
        }
        const result = await client.post<SimplePublicObject>(`/${config.basePath}`, body);
        return result;
      } catch (error) {
        return handleToolError(error);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tool 4: hubspot_crm_update
// ---------------------------------------------------------------------------

function buildUpdateTool(client: HubSpotClient): Tool {
  const schema = z.object({
    objectType: ObjectTypeSchema,
    id: z.string().min(1).describe('HubSpot record ID to update.'),
    properties: CrmPropertiesSchema,
  });

  return {
    name: 'hubspot_crm_update',
    description:
      'Update an existing HubSpot CRM record (partial update — only provided properties are ' +
      'changed). Applies to all object types. Pass only the properties you want to modify; ' +
      'omitted properties are left unchanged. To clear a property, pass an empty string "" as ' +
      'the value. Returns the updated record.',
    inputSchema: {
      type: 'object',
      properties: {
        objectType: OBJECT_TYPE_JSON,
        id: {
          type: 'string',
          minLength: 1,
          description: 'HubSpot record ID to update.',
        },
        properties: PROPERTIES_MAP_JSON,
      },
      required: ['objectType', 'id', 'properties'],
      additionalProperties: false,
    },
    handler: async (rawArgs: unknown) => {
      const args = schema.parse(rawArgs);
      const validType = validateObjectType(args.objectType);
      const config = (await import('../../utils/object-types.js')).getObjectTypeConfig(validType);

      try {
        const result = await client.patch<SimplePublicObject>(
          `/${config.basePath}/${encodeURIComponent(args.id)}`,
          { properties: args.properties }
        );
        return result;
      } catch (error) {
        return handleToolError(error);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tool 5: hubspot_crm_archive
// ---------------------------------------------------------------------------

function buildArchiveTool(client: HubSpotClient): Tool {
  const schema = z.object({
    objectType: ObjectTypeSchema,
    id: z.string().min(1).describe('HubSpot record ID to archive.'),
  });

  return {
    name: 'hubspot_crm_archive',
    description:
      'Archive (soft-delete) a HubSpot CRM record. Archived records are not permanently deleted ' +
      'and can be retrieved with archived=true on list/get calls. Applies to all object types. ' +
      'Returns an empty response (HTTP 204) on success. ' +
      'To permanently delete, use the HubSpot UI or the GDPR delete endpoint.',
    inputSchema: {
      type: 'object',
      properties: {
        objectType: OBJECT_TYPE_JSON,
        id: {
          type: 'string',
          minLength: 1,
          description: 'HubSpot record ID to archive.',
        },
      },
      required: ['objectType', 'id'],
      additionalProperties: false,
    },
    handler: async (rawArgs: unknown) => {
      const args = schema.parse(rawArgs);
      const validType = validateObjectType(args.objectType);
      const config = (await import('../../utils/object-types.js')).getObjectTypeConfig(validType);

      try {
        await client.delete<unknown>(`/${config.basePath}/${encodeURIComponent(args.id)}`);
        return { success: true, id: args.id, objectType: validType, archived: true };
      } catch (error) {
        return handleToolError(error);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tool 6: hubspot_crm_search
// ---------------------------------------------------------------------------

function buildSearchTool(client: HubSpotClient): Tool {
  const schema = z.object({
    objectType: ObjectTypeSchema,
    ...SearchInputSchema.shape,
  });

  return {
    name: 'hubspot_crm_search',
    description:
      'Search HubSpot CRM records using filters, sorts, and full-text query. Applies to all ' +
      'object types. Supports up to 5 filter groups (OR-ed) with up to 6 filters per group (AND-ed). ' +
      'FILTERGROUPS GUIDANCE: each filter is { propertyName, operator, value }. Filters WITHIN the ' +
      'same group are combined with AND; separate groups are combined with OR. ' +
      'Common operators: EQ (equals), NEQ (not equals), CONTAINS_TOKEN (word/substring match, ' +
      'use "*term*" wildcards), HAS_PROPERTY (value is set — no `value` field needed), ' +
      'BETWEEN (range — provide `value` as the low bound and `highValue` as the high bound), ' +
      'IN (matches any of `values` array — use `values` not `value`). ' +
      'EXAMPLE — deals with amount >= 1000 AND stage = closedwon, OR named "Acme": ' +
      '[{"filters":[{"propertyName":"amount","operator":"GTE","value":"1000"},' +
      '{"propertyName":"dealstage","operator":"EQ","value":"closedwon"}]},' +
      '{"filters":[{"propertyName":"dealname","operator":"CONTAINS_TOKEN","value":"Acme"}]}]. ' +
      'For simple single-property lookups, prefer hubspot_search_by_property; for created/modified-since ' +
      'queries, prefer hubspot_search_recent. ' +
      'IMPORTANT NOTES: ' +
      '(1) Search has stricter rate limits (~5 req/s per token) than regular reads — avoid polling. ' +
      '(2) Search has an indexing latency of several seconds — do NOT use immediately after create/update. ' +
      '     Use hubspot_crm_get instead for read-after-write. ' +
      '(3) Max total results via paging: 10 000. ' +
      '(4) Specify `properties` explicitly — HubSpot returns only defaults otherwise. ' +
      'Returns matching records with their requested properties. ' +
      'NOTE: Search responses use the raw HubSpot format — paginate using `paging.next.after` ' +
      'from the response (not `pagination.nextCursor` which list tools return).',
    inputSchema: {
      type: 'object',
      properties: {
        objectType: OBJECT_TYPE_JSON,
        filterGroups: {
          type: 'array',
          maxItems: 5,
          description:
            'OR-ed filter groups (max 5). Each group contains AND-ed filters (max 6). ' +
            'Leave empty with a `query` for full-text-only search.',
          items: {
            type: 'object',
            properties: {
              filters: {
                type: 'array',
                maxItems: 6,
                items: {
                  type: 'object',
                  properties: {
                    propertyName: { type: 'string', description: 'HubSpot property name.' },
                    operator: {
                      type: 'string',
                      enum: [
                        'EQ',
                        'NEQ',
                        'LT',
                        'LTE',
                        'GT',
                        'GTE',
                        'HAS_PROPERTY',
                        'NOT_HAS_PROPERTY',
                        'CONTAINS_TOKEN',
                        'NOT_CONTAINS_TOKEN',
                        'IN',
                        'NOT_IN',
                        'BETWEEN',
                      ],
                      description: 'Comparison operator.',
                    },
                    value: {
                      type: 'string',
                      description: 'Filter value (for EQ, NEQ, comparisons, CONTAINS_TOKEN).',
                    },
                    values: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'Array of values (for IN / NOT_IN).',
                    },
                    highValue: {
                      type: 'string',
                      description: 'Upper bound (for BETWEEN).',
                    },
                  },
                  required: ['propertyName', 'operator'],
                },
              },
            },
            required: ['filters'],
          },
        },
        sorts: {
          type: 'array',
          description: 'Sort specifications applied in order.',
          items: {
            type: 'object',
            properties: {
              propertyName: { type: 'string', description: 'Property to sort by.' },
              direction: {
                type: 'string',
                enum: ['ASCENDING', 'DESCENDING'],
                description: 'Sort direction.',
              },
            },
            required: ['propertyName', 'direction'],
          },
        },
        query: {
          type: 'string',
          description: 'Full-text search query across all searchable string properties.',
        },
        properties: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Property names to return. Always specify — HubSpot omits non-default properties.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          default: 10,
          description: 'Records per response (1–200). Default: 10.',
        },
        after: {
          type: ['string', 'integer'],
          description: 'Pagination cursor. Use 0 (or omit) for first page.',
        },
      },
      required: ['objectType'],
      additionalProperties: false,
    },
    handler: async (rawArgs: unknown) => {
      const args = schema.parse(rawArgs);
      const validType = validateObjectType(args.objectType);
      const config = (await import('../../utils/object-types.js')).getObjectTypeConfig(validType);

      try {
        const searchBody: Record<string, unknown> = {
          filterGroups: args.filterGroups ?? [],
          sorts: args.sorts ?? [],
          properties: args.properties ?? [],
          limit: args.limit,
        };
        if (args.query !== undefined) searchBody['query'] = args.query;
        if (args.after !== undefined) searchBody['after'] = args.after;

        const result = await client.search<CollectionResponse<SimplePublicObject>>(
          `/${config.basePath}/search`,
          searchBody
        );
        return result;
      } catch (error) {
        return handleToolError(error);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tool 7: hubspot_crm_batch_create
// ---------------------------------------------------------------------------

function buildBatchCreateTool(client: HubSpotClient): Tool {
  const schema = z.object({
    objectType: ObjectTypeSchema,
    inputs: z
      .array(BatchCreateInputSchema)
      .min(1)
      .max(100)
      .describe('Records to create (1–100). Each must have at least a `properties` object.'),
  });

  return {
    name: 'hubspot_crm_batch_create',
    description:
      'Create up to 100 HubSpot CRM records in a single request. Applies to all object types. ' +
      'Each input requires a `properties` map and may optionally include inline `associations`. ' +
      'For engagements, each record must include `hs_timestamp` in its properties. ' +
      'Returns a batch response with created records and any per-record errors. ' +
      'LIMIT: Maximum 100 inputs per request.',
    inputSchema: {
      type: 'object',
      properties: {
        objectType: OBJECT_TYPE_JSON,
        inputs: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          description: 'Array of records to create (1–100 per batch).',
          items: {
            type: 'object',
            properties: {
              properties: PROPERTIES_MAP_JSON,
              associations: INLINE_ASSOCIATIONS_JSON,
            },
            required: ['properties'],
          },
        },
      },
      required: ['objectType', 'inputs'],
      additionalProperties: false,
    },
    handler: async (rawArgs: unknown) => {
      const args = schema.parse(rawArgs);
      const validType = validateObjectType(args.objectType);
      const config = (await import('../../utils/object-types.js')).getObjectTypeConfig(validType);

      try {
        const result = await client.post<BatchResponse<SimplePublicObject>>(
          `/${config.basePath}/batch/create`,
          { inputs: args.inputs }
        );
        return result;
      } catch (error) {
        return handleToolError(error);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tool 8: hubspot_crm_batch_read
// ---------------------------------------------------------------------------

function buildBatchReadTool(client: HubSpotClient): Tool {
  const schema = z.object({
    objectType: ObjectTypeSchema,
    inputs: z
      .array(BatchReadInputSchema)
      .min(1)
      .max(100)
      .describe('Record identifiers to read (1–100).'),
    properties: z
      .array(z.string())
      .optional()
      .describe(
        'Property names to return for each record. ' +
          'Specify explicitly — HubSpot returns only defaults otherwise.'
      ),
    propertiesWithHistory: z
      .array(z.string())
      .optional()
      .describe('Property names to return with full value history.'),
    idProperty: z
      .string()
      .optional()
      .describe(
        'Custom unique property name to use as the ID field instead of `hs_object_id`. ' +
          'The `id` in each input must be the value of this property.'
      ),
  });

  return {
    name: 'hubspot_crm_batch_read',
    description:
      'Read up to 100 HubSpot CRM records by ID in a single request. Applies to all object types. ' +
      'Specify `properties` to control which fields are returned. ' +
      'Optionally use `idProperty` to look up records by a custom unique property value ' +
      '(e.g., your own external system ID) instead of the HubSpot `hs_object_id`. ' +
      'Returns a batch response with found records and any per-record errors. ' +
      'LIMIT: Maximum 100 inputs per request.',
    inputSchema: {
      type: 'object',
      properties: {
        objectType: OBJECT_TYPE_JSON,
        inputs: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          description: 'Record IDs to fetch (1–100).',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', minLength: 1, description: 'Record identifier value.' },
            },
            required: ['id'],
          },
        },
        properties: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Property names to return. Always specify — HubSpot omits non-default properties.',
        },
        propertiesWithHistory: {
          type: 'array',
          items: { type: 'string' },
          description: 'Property names for which to return full value history.',
        },
        idProperty: {
          type: 'string',
          description: 'Custom unique property to use as the lookup key instead of hs_object_id.',
        },
      },
      required: ['objectType', 'inputs'],
      additionalProperties: false,
    },
    handler: async (rawArgs: unknown) => {
      const args = schema.parse(rawArgs);
      const validType = validateObjectType(args.objectType);
      const config = (await import('../../utils/object-types.js')).getObjectTypeConfig(validType);

      try {
        const body: Record<string, unknown> = { inputs: args.inputs };
        if (args.properties) body['properties'] = args.properties;
        if (args.propertiesWithHistory) body['propertiesWithHistory'] = args.propertiesWithHistory;
        if (args.idProperty) body['idProperty'] = args.idProperty;

        const result = await client.post<BatchResponse<SimplePublicObject>>(
          `/${config.basePath}/batch/read`,
          body
        );
        return result;
      } catch (error) {
        return handleToolError(error);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tool 9: hubspot_crm_batch_update
// ---------------------------------------------------------------------------

function buildBatchUpdateTool(client: HubSpotClient): Tool {
  const schema = z.object({
    objectType: ObjectTypeSchema,
    inputs: z
      .array(BatchUpdateInputSchema)
      .min(1)
      .max(100)
      .describe('Records to update (1–100). Each must have `id` and `properties`.'),
  });

  return {
    name: 'hubspot_crm_batch_update',
    description:
      'Update up to 100 existing HubSpot CRM records in a single request. Applies to all object types. ' +
      'Each input must include the record `id` and the `properties` to change (partial update — ' +
      'omitted properties are unchanged). Pass "" as a property value to clear it. ' +
      'Returns a batch response with updated records and any per-record errors. ' +
      'LIMIT: Maximum 100 inputs per request.',
    inputSchema: {
      type: 'object',
      properties: {
        objectType: OBJECT_TYPE_JSON,
        inputs: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          description: 'Records to update (1–100).',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', minLength: 1, description: 'HubSpot record ID to update.' },
              properties: PROPERTIES_MAP_JSON,
            },
            required: ['id', 'properties'],
          },
        },
      },
      required: ['objectType', 'inputs'],
      additionalProperties: false,
    },
    handler: async (rawArgs: unknown) => {
      const args = schema.parse(rawArgs);
      const validType = validateObjectType(args.objectType);
      const config = (await import('../../utils/object-types.js')).getObjectTypeConfig(validType);

      try {
        const result = await client.post<BatchResponse<SimplePublicObject>>(
          `/${config.basePath}/batch/update`,
          { inputs: args.inputs }
        );
        return result;
      } catch (error) {
        return handleToolError(error);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tool 10: hubspot_crm_batch_archive
// ---------------------------------------------------------------------------

function buildBatchArchiveTool(client: HubSpotClient): Tool {
  const schema = z.object({
    objectType: ObjectTypeSchema,
    inputs: z.array(BatchIdInputSchema).min(1).max(100).describe('Record IDs to archive (1–100).'),
  });

  return {
    name: 'hubspot_crm_batch_archive',
    description:
      'Archive (soft-delete) up to 100 HubSpot CRM records in a single request. Applies to all ' +
      'object types. Archived records are not permanently deleted and can be retrieved with ' +
      'archived=true. Returns an empty response (HTTP 204) on success. ' +
      'LIMIT: Maximum 100 inputs per request.',
    inputSchema: {
      type: 'object',
      properties: {
        objectType: OBJECT_TYPE_JSON,
        inputs: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          description: 'Array of record IDs to archive (1–100).',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', minLength: 1, description: 'HubSpot record ID to archive.' },
            },
            required: ['id'],
          },
        },
      },
      required: ['objectType', 'inputs'],
      additionalProperties: false,
    },
    handler: async (rawArgs: unknown) => {
      const args = schema.parse(rawArgs);
      const validType = validateObjectType(args.objectType);
      const config = (await import('../../utils/object-types.js')).getObjectTypeConfig(validType);

      try {
        await client.post<unknown>(`/${config.basePath}/batch/archive`, { inputs: args.inputs });
        return {
          success: true,
          archived: args.inputs.length,
          objectType: validType,
        };
      } catch (error) {
        return handleToolError(error);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tool 11: hubspot_crm_batch_upsert
// ---------------------------------------------------------------------------

function buildBatchUpsertTool(client: HubSpotClient): Tool {
  const schema = z.object({
    objectType: ObjectTypeSchema,
    inputs: z.array(BatchUpsertInputSchema).min(1).max(100).describe('Records to upsert (1–100).'),
  });

  return {
    name: 'hubspot_crm_batch_upsert',
    description:
      'Upsert up to 100 HubSpot CRM records: creates them if they do not exist, ' +
      'updates them if they do. Each input must include `idProperty` (the unique property name ' +
      'used for matching, e.g., "email" or a custom external ID property), `id` (the value of ' +
      'that property), and `properties` (fields to set). ' +
      'The `idProperty` must be marked as unique in HubSpot. ' +
      'LIMIT: Maximum 100 inputs per request.',
    inputSchema: {
      type: 'object',
      properties: {
        objectType: OBJECT_TYPE_JSON,
        inputs: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          description: 'Records to upsert (1–100). Each must have idProperty, id, and properties.',
          items: {
            type: 'object',
            properties: {
              idProperty: {
                type: 'string',
                minLength: 1,
                description:
                  'Unique property name used to identify the record (e.g., "hs_external_id"). ' +
                  'Must be configured as a unique property in HubSpot.',
              },
              id: {
                type: 'string',
                minLength: 1,
                description: 'Value of the `idProperty` that identifies this record.',
              },
              properties: PROPERTIES_MAP_JSON,
            },
            required: ['idProperty', 'id', 'properties'],
          },
        },
      },
      required: ['objectType', 'inputs'],
      additionalProperties: false,
    },
    handler: async (rawArgs: unknown) => {
      const args = schema.parse(rawArgs);
      const validType = validateObjectType(args.objectType);
      const config = (await import('../../utils/object-types.js')).getObjectTypeConfig(validType);

      try {
        const result = await client.post<BatchResponse<SimplePublicObject>>(
          `/${config.basePath}/batch/upsert`,
          { inputs: args.inputs }
        );
        return result;
      } catch (error) {
        return handleToolError(error);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tool 12: hubspot_search_by_property
// ---------------------------------------------------------------------------

function buildSearchByPropertyTool(client: HubSpotClient): Tool {
  const schema = z.object({
    objectType: ObjectTypeSchema,
    propertyName: z
      .string()
      .min(1)
      .describe('HubSpot property internal name to filter on (e.g., "email", "dealname").'),
    value: z.string().describe('Value to match against the property.'),
    operator: z
      .enum(['EQ', 'NEQ', 'CONTAINS_TOKEN', 'GT', 'GTE', 'LT', 'LTE'])
      .default('EQ')
      .describe('Comparison operator. Default: EQ (exact match).'),
    properties: z
      .array(z.string())
      .optional()
      .describe('Property names to return. Always specify — HubSpot omits non-default properties.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(10)
      .describe('Records per response (1–100). Default: 10.'),
    after: z.string().optional().describe('Pagination cursor from `paging.next.after`.'),
  });

  return {
    name: 'hubspot_search_by_property',
    description:
      'Find HubSpot CRM records where a single property matches a value — a guided shortcut over ' +
      'hubspot_crm_search that builds the filterGroups for you (no hand-written filter JSON). ' +
      'Applies to all object types. Provide `propertyName`, `value`, and optionally an `operator` ' +
      '(EQ exact match [default], NEQ not-equal, CONTAINS_TOKEN word/substring match, or the ' +
      'numeric/date comparisons GT/GTE/LT/LTE). ' +
      'IMPORTANT: Specify `properties` explicitly — HubSpot returns only defaults otherwise. ' +
      'For multi-condition queries (AND/OR across several properties) use hubspot_crm_search instead. ' +
      'Returns the raw HubSpot search response — paginate using `paging.next.after`.',
    inputSchema: {
      type: 'object',
      properties: {
        objectType: OBJECT_TYPE_JSON,
        propertyName: {
          type: 'string',
          minLength: 1,
          description: 'HubSpot property internal name to filter on (e.g., "email", "dealname").',
        },
        value: {
          type: 'string',
          description: 'Value to match against the property.',
        },
        operator: {
          type: 'string',
          enum: ['EQ', 'NEQ', 'CONTAINS_TOKEN', 'GT', 'GTE', 'LT', 'LTE'],
          default: 'EQ',
          description:
            'Comparison operator: EQ (exact, default), NEQ (not equal), CONTAINS_TOKEN ' +
            '(word/substring match), or GT/GTE/LT/LTE (numeric/date comparisons).',
        },
        properties: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Property names to return. Always specify — HubSpot omits non-default properties.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          default: 10,
          description: 'Records per response (1–100). Default: 10.',
        },
        after: AFTER_CURSOR_JSON,
      },
      required: ['objectType', 'propertyName', 'value'],
      additionalProperties: false,
    },
    handler: async (rawArgs: unknown) => {
      const args = schema.parse(rawArgs);
      const validType = validateObjectType(args.objectType);
      const config = (await import('../../utils/object-types.js')).getObjectTypeConfig(validType);

      try {
        const searchBody: Record<string, unknown> = {
          filterGroups: [
            {
              filters: [
                {
                  propertyName: args.propertyName,
                  operator: args.operator,
                  value: args.value,
                },
              ],
            },
          ],
          limit: args.limit,
        };
        if (args.properties !== undefined) searchBody['properties'] = args.properties;
        if (args.after !== undefined) searchBody['after'] = args.after;

        const result = await client.search<CollectionResponse<SimplePublicObject>>(
          `/${config.basePath}/search`,
          searchBody
        );
        return result;
      } catch (error) {
        return handleToolError(error);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tool 13: hubspot_search_recent
// ---------------------------------------------------------------------------

function buildSearchRecentTool(client: HubSpotClient): Tool {
  const schema = z.object({
    objectType: ObjectTypeSchema,
    since: z
      .string()
      .min(1)
      .describe('Moment to search from: ISO 8601 timestamp or epoch milliseconds.'),
    field: z
      .enum(['modified', 'created'])
      .default('modified')
      .describe('Whether to match on last-modified or created time. Default: modified.'),
    dateProperty: z
      .string()
      .optional()
      .describe(
        'Override the date property used (e.g., "lastmodifieddate" for contacts). ' +
          'When omitted, resolves from `field`.'
      ),
    properties: z
      .array(z.string())
      .optional()
      .describe('Property names to return. Always specify — HubSpot omits non-default properties.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(10)
      .describe('Records per response (1–100). Default: 10.'),
    after: z.string().optional().describe('Pagination cursor from `paging.next.after`.'),
  });

  return {
    name: 'hubspot_search_recent',
    description:
      'Find HubSpot CRM records created or modified since a given moment — a guided shortcut over ' +
      'hubspot_crm_search that builds the filterGroups and sort for you. Applies to all object types. ' +
      'Provide `since` (ISO 8601 timestamp or epoch milliseconds) and optionally `field` ' +
      '("modified" [default] → hs_lastmodifieddate, or "created" → createdate). ' +
      'Results are sorted by that date property DESCENDING (most recent first). ' +
      'NOTE: the `contacts` object uses `lastmodifieddate` (not hs_lastmodifieddate) for modified ' +
      'time — pass `dateProperty: "lastmodifieddate"` to override when searching contacts. ' +
      'IMPORTANT: Specify `properties` explicitly — HubSpot returns only defaults otherwise. ' +
      'Returns the raw HubSpot search response — paginate using `paging.next.after`.',
    inputSchema: {
      type: 'object',
      properties: {
        objectType: OBJECT_TYPE_JSON,
        since: {
          type: 'string',
          minLength: 1,
          description: 'Moment to search from: ISO 8601 timestamp or epoch milliseconds.',
        },
        field: {
          type: 'string',
          enum: ['modified', 'created'],
          default: 'modified',
          description:
            'Whether to match on last-modified (hs_lastmodifieddate) or created (createdate) time. ' +
            'Default: modified.',
        },
        dateProperty: {
          type: 'string',
          description:
            'Override the date property used (e.g., "lastmodifieddate" for contacts). ' +
            'When omitted, resolves from `field`.',
        },
        properties: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Property names to return. Always specify — HubSpot omits non-default properties.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          default: 10,
          description: 'Records per response (1–100). Default: 10.',
        },
        after: AFTER_CURSOR_JSON,
      },
      required: ['objectType', 'since'],
      additionalProperties: false,
    },
    handler: async (rawArgs: unknown) => {
      const args = schema.parse(rawArgs);
      const validType = validateObjectType(args.objectType);
      const config = (await import('../../utils/object-types.js')).getObjectTypeConfig(validType);

      // Resolve which date property to filter and sort on.
      const resolvedProperty =
        args.dateProperty ?? (args.field === 'created' ? 'createdate' : 'hs_lastmodifieddate');

      try {
        const searchBody: Record<string, unknown> = {
          filterGroups: [
            {
              filters: [
                {
                  propertyName: resolvedProperty,
                  operator: 'GTE',
                  value: args.since,
                },
              ],
            },
          ],
          sorts: [{ propertyName: resolvedProperty, direction: 'DESCENDING' }],
          limit: args.limit,
        };
        if (args.properties !== undefined) searchBody['properties'] = args.properties;
        if (args.after !== undefined) searchBody['after'] = args.after;

        const result = await client.search<CollectionResponse<SimplePublicObject>>(
          `/${config.basePath}/search`,
          searchBody
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
 * Returns all 13 generic CRM tools parametrized by `objectType`.
 *
 * Covers HubSpot v3 CRM object operations for all 12 standard types:
 * - Core objects: contacts, companies, tickets
 * - Sales objects: deals, line_items, products, quotes
 * - Engagement objects: calls, meetings, tasks, notes, emails
 *
 * Custom object type IDs (e.g. "2-12345678") are also accepted.
 *
 * Each tool is wired to the provided `HubSpotClient` instance which handles
 * authentication, rate limiting, retry, and error parsing.
 *
 * @param client - Authenticated HubSpotClient instance.
 * @returns Array of 13 Tool objects ready for MCP registration.
 *
 * @example
 * import { getCrmTools } from './tools/crm/index.js';
 * const tools = getCrmTools(client);
 * // Register tools with MCP server...
 */
export function getCrmTools(client: HubSpotClient): Tool[] {
  return [
    buildListTool(client),
    buildGetTool(client),
    buildCreateTool(client),
    buildUpdateTool(client),
    buildArchiveTool(client),
    buildSearchTool(client),
    buildBatchCreateTool(client),
    buildBatchReadTool(client),
    buildBatchUpdateTool(client),
    buildBatchArchiveTool(client),
    buildBatchUpsertTool(client),
    buildSearchByPropertyTool(client),
    buildSearchRecentTool(client),
  ];
}
