# @nubiia/mcp-hubspot

[![npm version](https://img.shields.io/npm/v/@nubiia/mcp-hubspot.svg)](https://www.npmjs.com/package/@nubiia/mcp-hubspot)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js >=20](https://img.shields.io/badge/node-%3E%3D20.18.0-brightgreen.svg)](https://nodejs.org)

**The most complete HubSpot MCP server for Claude.**

A Model Context Protocol (MCP) server that gives Claude comprehensive, enterprise-grade access to HubSpot CRM — covering contacts, deals, quotes, workflows, automation callbacks, and more, all through 37 battle-tested tools.

---

## Features

- **37 Tools Across 7 Domains** (+ 16 with developer key = 53 total) — complete coverage of the HubSpot CRM API surface
- **Workflow Automation v4 BETA** — create, update, monitor, and delete automation workflows
- **Contact Enrollment** — enroll and unenroll any CRM object in a workflow
- **CRM Object CRUD** — full create/read/update/archive for contacts, companies, deals, tickets, quotes, line_items, notes, calls, emails, meetings, and tasks
- **Batch Operations** — up to 100 objects per call for efficient bulk reads and writes
- **Smart Search** — filter groups, multiple operators, multi-field sorting, and cursor pagination
- **Deal & Quote Assembly** — merge duplicate deals, assemble quotes from existing deals
- **Association Management** — link any two CRM objects with typed association labels
- **Custom Properties** — discover, read, and create property definitions for any object type
- **Rate Limiting + Retry Logic** — automatic backoff to protect your HubSpot API quota
- **MCP Resources** — three static reference resources (scope guide, object type catalog, conventions)
- **MCP Prompts** — five guided workflows to orchestrate multi-step CRM operations
- **Toolset Filtering** — enable only the domains you need via `HUBSPOT_TOOLSETS`
- **Full TypeScript** — strict types, Zod validation, and comprehensive TSDoc

---

## Tool Categories

| Domain | Tools | Description |
|--------|------:|-------------|
| CRM | 11 | Generic CRUD and batch for all object types (contacts, companies, deals, tickets, quotes, line_items, and engagement types) |
| Sales | 2 | Deal merging and quote assembly |
| Associations | 5 | Create, archive, list, and batch-create object associations |
| Properties | 3 | List, get, and create custom property definitions |
| Workflows v4 BETA | 9 | Create, update, delete, and monitor automation workflows |
| Automation | 2 | Complete delayed workflow callbacks (single and batch) |
| Enrollment | 5 | Enroll/unenroll objects in workflows; v3 legacy reads ¹ |
| Actions *(dev key)* | 16 | Custom Workflow Action definitions — requires `HUBSPOT_DEVELOPER_API_KEY` ² |

> ¹ The v3 legacy tools (`hubspot_workflows_v3_list`, `hubspot_workflows_v3_get`) belong to the `automation`
> toolset — activate them with `HUBSPOT_TOOLSETS=automation`.
>
> ² Actions tools use developer API key auth (hapikey) instead of a Private App access token and are only
> registered when `HUBSPOT_DEVELOPER_API_KEY` is present. See [Actions Toolset](#actions-toolset-phase-7) below.

---

## Installation

### Global install

```bash
npm install -g @nubiia/mcp-hubspot
```

### Via npx (no install needed)

```bash
npx @nubiia/mcp-hubspot
```

---

## Configuration

### Prerequisites

You need a **HubSpot Private App** to obtain an access token:

1. Log in to HubSpot and go to **Settings → Integrations → Private Apps**
2. Click **Create a Private App**
3. Give it a name and select the required scopes (see table below)
4. Click **Create app** and copy the generated access token (`pat-na1-...`)

### Claude Desktop Setup

Add the server to your Claude Desktop config file:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
**Linux:** `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "hubspot": {
      "command": "npx",
      "args": ["-y", "@nubiia/mcp-hubspot"],
      "env": {
        "HUBSPOT_ACCESS_TOKEN": "pat-na1-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
      }
    }
  }
}
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HUBSPOT_ACCESS_TOKEN` | Yes | — | HubSpot Private App access token (`pat-na1-...`) |
| `HUBSPOT_TOOLSETS` | No | all | Comma-separated domains to enable: `sales,engagements,associations,properties,workflows,automation,actions,owners` (note: `actions` also requires `HUBSPOT_DEVELOPER_API_KEY`) |
| `LOG_LEVEL` | No | `info` | Logging level: `debug`, `info`, `warn`, `error` |

### Required Scopes

Grant only the scopes your use-case needs:

| Toolset | Required Scopes |
|---------|----------------|
| `sales` | `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.objects.deals.read`, `crm.objects.deals.write`, `crm.objects.quotes.read`, `crm.objects.quotes.write` |
| `engagements` | `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.objects.engagements.read`, `crm.objects.engagements.write` |
| `associations` | `crm.objects.contacts.read`, `crm.objects.contacts.write` |
| `properties` | `crm.schemas.deals.read`, `crm.schemas.contacts.read` |
| `workflows` | `automation` (requires BETA access approval from HubSpot) |
| `automation` | `automation` |
| `owners` | `crm.objects.owners.read` |

### Advanced Configuration Examples

**Enable only sales and properties toolsets:**

```json
{
  "mcpServers": {
    "hubspot": {
      "command": "npx",
      "args": ["-y", "@nubiia/mcp-hubspot"],
      "env": {
        "HUBSPOT_ACCESS_TOKEN": "pat-na1-...",
        "HUBSPOT_TOOLSETS": "sales,properties"
      }
    }
  }
}
```

**Enable debug logging for troubleshooting:**

```json
{
  "env": {
    "HUBSPOT_ACCESS_TOKEN": "pat-na1-...",
    "LOG_LEVEL": "debug"
  }
}
```

---

## Usage Examples

### Create a deal and attach products

> "Create a deal named 'Acme Corp - Enterprise Plan' closing on March 31st, add a line item for the Enterprise annual plan at $24,000, and associate it with the contact john.doe@acme.com."

Claude will:
1. Search for the contact by email using `hubspot_crm_search`
2. Create the deal with `hubspot_crm_create` (objectType: deals)
3. Create the line item with `hubspot_crm_create` (objectType: lineItems)
4. Link them with `hubspot_associations_create`
5. Associate the contact with `hubspot_associations_create`

### Find all deals closing this month above $10k

> "Search for all open deals with a close date in the current month and amount greater than $10,000. Sort by amount descending."

Claude will:
1. Use `hubspot_crm_search` with filterGroups combining `closedate` BETWEEN and `amount` GT operators
2. Set sorts to `[{ propertyName: "amount", direction: "DESCENDING" }]`
3. Paginate through results using the `after` cursor if there are more than one page

### Enroll a contact who just filled a form in the onboarding workflow

> "The contact with ID 98765 just submitted the trial sign-up form. Enroll them in the onboarding workflow."

Claude will:
1. Use `hubspot_workflows_list` to find the onboarding workflow (filtering by objectTypeId for contacts)
2. Verify the contact exists with `hubspot_crm_get`
3. Enroll with `hubspot_enrollment_enroll`
4. Confirm enrollment with `hubspot_enrollment_get_enrollments`

---

## Workflows v4 BETA

The `workflows` toolset uses HubSpot's Workflows v4 API, which is currently in **BETA**:

- Breaking changes may occur without notice
- Access requires explicit approval from HubSpot — contact HubSpot support if you receive 403 errors
- The following tools are included in the `workflows` toolset: `hubspot_workflows_list`, `hubspot_workflows_get`, `hubspot_workflows_create`, `hubspot_workflows_update`, `hubspot_workflows_delete`, `hubspot_workflows_batch_read`, `hubspot_workflows_email_campaigns`, `hubspot_workflows_performance`, `hubspot_workflows_id_mappings`

**For stable, read-only access to existing workflows**, use the legacy v3 tools included in the `automation` toolset:

- `hubspot_workflows_v3_list` — list all workflows
- `hubspot_workflows_v3_get` — get a specific workflow by ID

---

## Actions Toolset (Phase 7)

The `actions` toolset exposes 16 tools for managing **Custom Workflow Action definitions** — the
reusable action types that developers can publish to the HubSpot Workflows editor.

### Required environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `HUBSPOT_DEVELOPER_API_KEY` | Yes (for actions) | HubSpot developer API key — obtain from your developer account at developers.hubspot.com |
| `HUBSPOT_APP_ID` | Yes (for actions) | The HubSpot App ID that owns the action definitions |

### Activation

Actions tools are **only registered when `HUBSPOT_DEVELOPER_API_KEY` is present**. They do not
appear in the tool list when only `HUBSPOT_ACCESS_TOKEN` is configured. You can also explicitly
enable them via `HUBSPOT_TOOLSETS=actions` (still requires the developer key).

### Authentication

All 16 `hubspot_actions_*` tools authenticate via **hapikey** (developer API key appended to the
query string), not the Private App bearer token used by the other 37 tools.

### Tools

| Tool | Description |
|------|-------------|
| `hubspot_actions_list` | List all custom action definitions for an app |
| `hubspot_actions_create` | Create a new action definition |
| `hubspot_actions_get` | Get a single action definition |
| `hubspot_actions_update` | Update (PATCH) an action definition |
| `hubspot_actions_delete` | Delete an action definition |
| `hubspot_actions_revisions_list` | List all revisions for an action |
| `hubspot_actions_revisions_get` | Get a specific revision |
| `hubspot_actions_functions_list` | List all functions on an action |
| `hubspot_actions_functions_get_by_type` | Get a function by type |
| `hubspot_actions_functions_put` | Create or replace a function by type |
| `hubspot_actions_functions_delete_by_type` | Delete a function by type |
| `hubspot_actions_functions_get_by_id` | Get a function by type and ID |
| `hubspot_actions_functions_update_by_id` | Replace a function by type and ID |
| `hubspot_actions_functions_delete_by_id` | Delete a function by type and ID |
| `hubspot_actions_requires_object_get` | Get the requires-object setting for an action |
| `hubspot_actions_requires_object_set` | Set the requires-object setting for an action |

### Claude Desktop configuration example

```json
{
  "mcpServers": {
    "hubspot": {
      "command": "npx",
      "args": ["-y", "@nubiia/mcp-hubspot"],
      "env": {
        "HUBSPOT_ACCESS_TOKEN": "pat-na1-...",
        "HUBSPOT_DEVELOPER_API_KEY": "your-developer-api-key",
        "HUBSPOT_APP_ID": "123456"
      }
    }
  }
}
```

---

## Known Limitations

- **Search latency**: Records created or updated via the API may take 1–5 minutes to appear in `hubspot_crm_search` results due to HubSpot's indexing pipeline
- **Batch cap**: All `hubspot_crm_batch_*` tools enforce a hard limit of 100 objects per call; split larger sets across multiple calls
- **Workflows v4 API**: Subject to breaking changes while in BETA; HubSpot support approval required for access
- **Quote assembly**: `hubspot_quotes_assemble` requires the deal to have at least one associated line item; the call will fail otherwise

---

## MCP Resources

Three static reference resources are available to LLM clients:

| URI | Name | Description |
|-----|------|-------------|
| `hubspot://scopes-guide` | HubSpot Private App Scopes Guide | Required OAuth scopes per toolset/domain |
| `hubspot://crm-object-types` | CRM Object Types Catalog | Supported objectType values and key properties |
| `hubspot://conventions` | HubSpot MCP Usage Conventions | Rate limits, batch caps, search latency, pagination |

---

## MCP Prompts

Five guided workflow prompts help orchestrate multi-step operations:

| Prompt | Description |
|--------|-------------|
| `create-deal-with-line-items` | Create a Deal and attach Line Items from HubSpot Products |
| `assemble-quote` | Assemble a HubSpot Quote from an existing Deal |
| `log-engagement-and-associate` | Log a CRM engagement (call, email, or meeting) and associate it with contacts/deals |
| `enroll-contact-in-workflow` | Enroll a contact (or other object) in a HubSpot Workflow |
| `search-crm-records` | Search CRM records with filters, sort, and pagination |

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, code style guidelines, testing requirements, and how to add new tools.

---

## Security

See [SECURITY.md](SECURITY.md) for the vulnerability reporting policy and security best practices.

---

## License

[MIT](LICENSE) — Copyright (c) 2025 Samuel Fraga
