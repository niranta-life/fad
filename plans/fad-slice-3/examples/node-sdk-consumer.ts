// Proposed usage sample, NOT a passed integration test.
// Run in an independent Node.js test project after installing packed @fad/sdk.
import { FadClient } from '@fad/sdk';

const fad = new FadClient({
  baseUrl: process.env.FAD_URL!,
  apiKey: () => process.env.FAD_API_KEY!
});
const agentId = process.env.FAD_AGENT_ID!;

async function main() {
  const published = await fad.capabilities.publish({
    id: 'finance.invoice.match',
    version: '1.0.0',
    display_name: 'Invoice matching',
    input_schema: { type: 'object', properties: {invoice_id: {type: 'string'}} },
    output_schema: { type: 'object', properties: {matched: {type: 'boolean'}} }
  }, { idempotencyKey: 'test-publish-capability-1' });
  console.log(published.data.id, published.data.version);

  await fad.endpoints.put(agentId, 'primary', {
    protocol: 'a2a', url: 'https://ap.internal.example/a2a', auth_scheme: 'oauth2'
  }, { idempotencyKey: 'test-put-endpoint-1', ifNoneMatch: '*' });

  await fad.bindings.put(agentId, 'finance.invoice.match', {
    version: '1.0.0', endpoint_key: 'primary'
  }, { idempotencyKey: 'test-put-binding-1', ifNoneMatch: '*' });

  const matches = await fad.discovery.agents({
    capability: {id: 'finance.invoice.match', version: '1.0.0'},
    tags: [{namespace:'department',key:'name',operator:'eq',value:'finance'}],
    protocols: ['a2a'], limit:25
  });
  console.log(matches.data.map(x => ({name:x.agent.name, url:x.endpoint.url,
    available:x.availability, authorized:x.invocation_authorization})));
}
main().catch(err => { console.error(err.code ?? err.message); process.exitCode = 1; });
