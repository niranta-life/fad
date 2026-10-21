/** Approved Slice 4 tools, in the stable directory order. Disabled tools are absent. */
export const APPROVED_MCP_TOOLS = [
  'fad_list_agents',
  'fad_get_agent',
  'fad_register_agent',
  'fad_update_agent',
  'fad_suspend_agent',
  'fad_activate_agent',
  'fad_list_agent_tags',
  'fad_put_agent_tag',
  'fad_search_agents_by_tags',
  'fad_list_capabilities',
  'fad_publish_capability',
  'fad_put_endpoint',
  'fad_put_binding',
  'fad_discover_agents',
] as const;

export type ApprovedMcpTool = (typeof APPROVED_MCP_TOOLS)[number];

const APPROVED = new Set<string>(APPROVED_MCP_TOOLS);

export function approvedMcpTool(name: string): name is ApprovedMcpTool {
  return APPROVED.has(name);
}
