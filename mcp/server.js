#!/usr/bin/env node
// Fencely CRM — MCP server for Claude (REAL @modelcontextprotocol/sdk, stdio transport).
// Operates on the SAME data layer as the web app (src/db.js — local SQLite here,
// or Turso if the TURSO_* env vars are set). For the hosted/remote variant that
// Claude.ai connectors use, see POST /api/mcp in src/app.js (MCP_TOKEN auth).
// Safety: keep write tools set to "ask/confirm" in your Claude connector settings.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as db from '../src/db.js';

await db.init();

const server = new McpServer({ name: 'fencely-crm', version: '1.1.0' });
const txt = obj => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });

server.tool('search_contractors', 'Search/list contractors with filters',
  { q: z.string().optional(), state: z.string().optional(), city: z.string().optional(), niche: z.string().optional(), whatsapp_status: z.string().optional(), stage: z.string().optional(), has_email: z.boolean().optional(), has_mobile: z.boolean().optional() },
  async (f) => txt(await db.listContractors(f)));

server.tool('get_contractor', 'Get one contractor with timeline + tasks', { id: z.number() },
  async ({ id }) => { const c = await db.getContractor(id); return txt(c || { error: 'Not found' }); });

server.tool('create_contractor', 'Create a contractor (de-dupe checked; set force:true to override)',
  { business_name: z.string(), state: z.string().optional(), city: z.string().optional(), suburb: z.string().optional(), niches: z.array(z.string()).optional(), landline: z.string().optional(), mobile: z.string().optional(), whatsapp_number: z.string().optional(), whatsapp_status: z.string().optional(), email: z.string().optional(), website: z.string().optional(), source: z.string().optional(), stage: z.string().optional(), notes: z.string().optional(), force: z.boolean().optional() },
  async (input) => {
    const dupes = await db.findDuplicates(input);
    if (dupes.length && !input.force) return txt({ error: 'Possible duplicate — re-run with force:true to create anyway', duplicates: dupes.map(d => ({ id: d.id, business_name: d.business_name })) });
    return txt(await db.createContractor(input));
  });

server.tool('update_contractor', 'Update fields on a contractor (partial)', { id: z.number(), fields: z.record(z.any()) },
  async ({ id, fields }) => txt((await db.updateContractor(id, fields)) || { error: 'Not found' }));

server.tool('move_stage', 'Move a contractor to a pipeline stage', { id: z.number(), stage: z.enum(db.STAGES) },
  async ({ id, stage }) => txt((await db.updateContractor(id, { stage })) || { error: 'Not found' }));

server.tool('add_note', 'Add a note/activity to a contractor timeline', { id: z.number(), body: z.string() },
  async ({ id, body }) => txt(await db.addNote(id, body)));

server.tool('list_followups', 'List open follow-up tasks (due=today for due/overdue only)', { due: z.enum(['all','today']).optional() },
  async ({ due }) => txt(await db.listTasks({ dueToday: due === 'today' })));

server.tool('create_task', 'Create a follow-up task', { contractor_id: z.number().optional(), title: z.string(), due_date: z.string().optional() },
  async (t) => txt(await db.createTask(t)));

await server.connect(new StdioServerTransport());
console.error('fencely-crm MCP server running (stdio)');
