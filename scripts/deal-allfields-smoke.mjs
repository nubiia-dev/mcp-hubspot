// Prove the MCP can set ALL writable deal fields — standard AND custom —
// entirely through MCP tools (properties_list + crm_update + crm_get).
import { HubSpotClient } from '../dist/hubspot-client.js';
import { getCrmTools } from '../dist/tools/crm/index.js';
import { getPropertiesTools } from '../dist/tools/properties/index.js';

const token = process.env.HUBSPOT_ACCESS_TOKEN;
if (!token) { console.error('No token'); process.exit(1); }
const client = new HubSpotClient({ accessToken: token });
const tools = Object.fromEntries(
  [...getCrmTools(client), ...getPropertiesTools(client)].map((t) => [t.name, t])
);
const call = (n, a) => tools[n].handler(a);
const isErr = (r) => r && typeof r === 'object' && r.isError === true;
const errText = (r) => String(r?.content?.[0]?.text ?? JSON.stringify(r)).replace(/\s+/g, ' ');

const DEAL_ID = '508317843674';
const TAG = 'ZZZ-TEST-MCP';
const TODAY = new Date().toISOString().slice(0, 10);
const NOW = new Date().toISOString();

// 1) List ALL deal properties via the MCP
const list = await call('hubspot_properties_list', { objectType: 'deals' });
if (isErr(list)) { console.error('properties_list failed:', errText(list)); process.exit(1); }
const props = list.results || [];

const isWritable = (p) =>
  !p.calculated &&
  p.modificationMetadata?.readOnlyValue !== true &&
  p.fieldType !== 'calculation_equation' &&
  p.type !== 'object_coordinates';

function valueFor(p) {
  switch (p.type) {
    case 'enumeration': {
      const opts = (p.options || []).filter((o) => !o.hidden && !o.readOnly).map((o) => o.value);
      if (!opts.length) return undefined;
      return p.fieldType === 'checkbox' ? opts.slice(0, 1).join(';') : opts[0];
    }
    case 'bool':
      return 'true';
    case 'number':
      return '42';
    case 'date':
      return TODAY;
    case 'datetime':
      return NOW;
    case 'phone_number':
      return '+34600000000';
    default:
      return `${TAG} ${p.name}`.slice(0, 60);
  }
}

const writable = props.filter(isWritable).filter((p) => valueFor(p) !== undefined);
const customWritable = writable.filter((p) => p.hubspotDefined !== true);
const stdWritable = writable.filter((p) => p.hubspotDefined !== false);
const readOnly = props.filter((p) => !isWritable(p));

console.log(`Deal properties: total=${props.length}`);
console.log(`  writable attempted = ${writable.length}  (custom=${customWritable.length}, standard=${stdWritable.length})`);
console.log(`  read-only/calculated (skipped, HubSpot blocks) = ${readOnly.length}`);

// 2) Set each writable property via the MCP, one at a time (isolates failures)
let ok = 0;
const failed = [];
const okCustom = [];
for (const p of writable) {
  const v = valueFor(p);
  const r = await call('hubspot_crm_update', {
    objectType: 'deals',
    id: DEAL_ID,
    properties: { [p.name]: v },
  });
  if (isErr(r)) {
    failed.push({ name: p.name, custom: p.hubspotDefined !== true, type: p.type, why: errText(r).slice(0, 90) });
  } else {
    ok++;
    if (p.hubspotDefined !== true) okCustom.push(p.name);
  }
}

console.log(`\n── Resultado set vía MCP (hubspot_crm_update) ──`);
console.log(`  ✓ establecidas OK: ${ok}/${writable.length}  (de ellas personalizadas: ${okCustom.length}/${customWritable.length})`);
console.log(`  ✗ rechazadas por HubSpot: ${failed.length}`);

console.log(`\n── Muestra de CAMPOS PERSONALIZADOS establecidos vía MCP ──`);
console.log('  ' + okCustom.slice(0, 25).join(', ') + (okCustom.length > 25 ? `, … (+${okCustom.length - 25})` : ''));

if (failed.length) {
  console.log(`\n── Rechazadas (HubSpot, no el MCP) — muestra con motivo ──`);
  for (const f of failed.slice(0, 12)) {
    console.log(`  • ${f.name} [${f.type}${f.custom ? ', custom' : ''}] → ${f.why}`);
  }
  if (failed.length > 12) console.log(`  … (+${failed.length - 12} más)`);
}

// 3) Read back a sample of custom fields via the MCP to confirm persistence
if (okCustom.length) {
  const sample = okCustom.slice(0, 8);
  const rb = await call('hubspot_crm_get', { objectType: 'deals', id: DEAL_ID, properties: sample.join(',') });
  console.log(`\n── Read-back de campos personalizados (MCP crm_get) ──`);
  for (const n of sample) console.log(`  ${n} = ${JSON.stringify(rb.properties?.[n] ?? null)}`);
}
