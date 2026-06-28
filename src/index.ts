#!/usr/bin/env node
/**
 * HubSpot MCP Server entry point.
 *
 * Bootstraps the MCP server with:
 * - Environment validation (HUBSPOT_ACCESS_TOKEN required)
 * - HubSpot API client initialization
 * - Tool registration and toolset filtering
 * - MCP protocol handlers (ListTools, CallTool)
 * - Graceful shutdown with final metrics logging
 * - Uncaught exception/rejection handlers
 *
 * Usage:
 *   HUBSPOT_ACCESS_TOKEN=<token> node dist/index.js
 *
 * @see {@link https://developers.hubspot.com/docs/api/private-apps}
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { HubSpotClient } from './hubspot-client.js';
import { type Tool } from './types/common.js';
import { logger } from './utils/logger.js';
import { handleToolError } from './utils/error-handler.js';
import { metricsCollector } from './utils/metrics.js';
import { getEnabledToolsets, type HubSpotToolset } from './utils/toolset-filter.js';
import { getCrmTools } from './tools/crm/index.js';
import { getSalesTools } from './tools/sales/index.js';
import { getAssociationsTools } from './tools/associations/index.js';
import { getPropertiesTools } from './tools/properties/index.js';
import { getWorkflowsTools } from './tools/workflows/index.js';
import { getAutomationTools } from './tools/automation/index.js';
import { getEnrollmentTools } from './tools/enrollment/index.js';
import { getActionsTools } from './tools/actions/index.js';
import { getOwnersTools } from './tools/owners/index.js';
import { setupResources } from './resources/index.js';
import { setupPrompts } from './prompts/index.js';

// ─── Environment validation ──────────────────────────────────────────────────

const ACCESS_TOKEN = process.env['HUBSPOT_ACCESS_TOKEN'];
const DEVELOPER_API_KEY = process.env['HUBSPOT_DEVELOPER_API_KEY'];
const APP_ID = process.env['HUBSPOT_APP_ID'];

if (!ACCESS_TOKEN) {
  console.error('Error: HUBSPOT_ACCESS_TOKEN environment variable is required');
  console.error('');
  console.error('How to create a HubSpot Private App:');
  console.error('  1. Go to HubSpot → Settings → Integrations → Private Apps');
  console.error('  2. Click "Create a Private App"');
  console.error('  3. Name your app and select the required scopes');
  console.error('  4. Copy the generated access token');
  console.error('');
  console.error('Set it in your Claude Desktop config (~/.claude/claude_desktop_config.json):');
  console.error('{');
  console.error('  "mcpServers": {');
  console.error('    "hubspot": {');
  console.error('      "command": "npx",');
  console.error('      "args": ["-y", "@iamsamuelfraga/mcp-hubspot"],');
  console.error('      "env": {');
  console.error('        "HUBSPOT_ACCESS_TOKEN": "pat-na1-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"');
  console.error('      }');
  console.error('    }');
  console.error('  }');
  console.error('}');
  process.exit(1);
}

// ─── Client initialization ───────────────────────────────────────────────────

const client = new HubSpotClient({ accessToken: ACCESS_TOKEN, developerApiKey: DEVELOPER_API_KEY });

// ─── Tool registration ───────────────────────────────────────────────────────

/**
 * A group of tools tagged with the toolset(s) it belongs to.
 *
 * The hybrid tool design means a single factory can serve more than one
 * toolset: the generic CRM tools cover both `sales` and `engagements`
 * object types, so they are enabled when either toolset is active.
 */
interface ToolGroup {
  toolsets: HubSpotToolset[];
  tools: Tool[];
}

/**
 * Builds every domain's tools, each tagged with its owning toolset(s).
 *
 * Tool names follow `hubspot_<area>_<action>` and do not always match a
 * toolset name (e.g. `hubspot_crm_*`, `hubspot_enrollment_*`), so toolset
 * membership is declared explicitly here rather than inferred from the name.
 *
 * @param client - The HubSpotClient instance passed to each domain's factory.
 * @returns Array of tool groups with explicit toolset membership.
 */
function registerToolGroups(client: HubSpotClient): ToolGroup[] {
  const groups: ToolGroup[] = [
    // Generic CRM CRUD/search/batch — shared backbone for sales + engagements objects.
    { toolsets: ['sales', 'engagements'], tools: getCrmTools(client) },
    // Sales-specific helpers (deals merge, quotes assemble).
    { toolsets: ['sales'], tools: getSalesTools(client) },
    { toolsets: ['associations'], tools: getAssociationsTools(client) },
    { toolsets: ['properties'], tools: getPropertiesTools(client) },
    // Owners — resolve hubspot_owner_id values to real users (name/email).
    { toolsets: ['owners'], tools: getOwnersTools(client) },
    { toolsets: ['workflows'], tools: getWorkflowsTools(client) },
    // Automation runtime (callbacks) + workflow enrollment + legacy v3 reads.
    {
      toolsets: ['automation'],
      tools: [...getAutomationTools(client), ...getEnrollmentTools(client)],
    },
  ];

  // Custom Workflow Actions require a developer API key (hapikey) and are only
  // registered when HUBSPOT_DEVELOPER_API_KEY is set in the environment.
  if (DEVELOPER_API_KEY) {
    groups.push({
      toolsets: ['actions' as HubSpotToolset],
      tools: getActionsTools(client, APP_ID),
    });
  } else {
    logger.debug('actions toolset disabled: HUBSPOT_DEVELOPER_API_KEY not set');
  }

  return groups;
}

// Build the tool registry, filtering by enabled toolsets.
const enabledToolsets = getEnabledToolsets();
const tools: Record<string, Tool> = {};
for (const group of registerToolGroups(client)) {
  if (!group.toolsets.some((t) => enabledToolsets.includes(t))) {
    logger.debug('Toolset disabled, skipping group', { toolsets: group.toolsets.join(',') });
    continue;
  }
  for (const tool of group.tools) {
    tools[tool.name] = tool;
  }
}

// ─── MCP Server setup ────────────────────────────────────────────────────────

const server = new Server(
  {
    name: 'hubspot-mcp',
    version: '0.2.0',
  },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
    },
  }
);

// ListTools handler – returns the schema for every enabled tool
server.setRequestHandler(ListToolsRequestSchema, async () => {
  logger.debug('Listing available tools', { count: Object.keys(tools).length });

  return {
    tools: Object.entries(tools).map(([name, tool]) => ({
      name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  };
});

// CallTool handler – executes the requested tool and returns its result
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  logger.info('Tool called', { tool: name, hasArgs: !!args });

  const startTime = Date.now();
  let success = true;

  try {
    const tool = tools[name];
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }

    const result = await tool.handler(args ?? {});
    const duration = Date.now() - startTime;

    logger.info('Tool executed successfully', { tool: name, duration });
    metricsCollector.recordRequest(name, duration, false);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    success = false;
    const duration = Date.now() - startTime;

    logger.error('Tool execution failed', error as Error, { tool: name, duration });
    metricsCollector.recordRequest(name, duration, true);

    return handleToolError(error);
  } finally {
    // Success path metrics are recorded in the try block; this prevents double-counting.
    if (!success) {
      // Already recorded above in the catch block.
    }
  }
});

// Register MCP Resources and Prompts (stubs for now)
setupResources(server, client);
setupPrompts(server);

// ─── Server startup ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('HubSpot MCP server started', {
    toolCount: Object.keys(tools).length,
    enabledToolsets,
  });

  logger.debug('Registered tools', { tools: Object.keys(tools) });
}

// ─── Graceful shutdown ───────────────────────────────────────────────────────

function shutdown(signal: string): void {
  logger.info(`Shutting down gracefully (${signal})...`);
  const metrics = metricsCollector.getMetrics();
  logger.info('Final metrics', metrics as unknown as Record<string, unknown>);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ─── Uncaught error handlers ─────────────────────────────────────────────────

process.on('uncaughtException', (error: Error) => {
  logger.error('Uncaught exception', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  logger.error('Unhandled rejection', new Error(String(reason)));
  process.exit(1);
});

// ─── Launch ──────────────────────────────────────────────────────────────────

main().catch((error: Error) => {
  logger.error('Fatal error during startup', error);
  process.exit(1);
});
