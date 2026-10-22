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
  'fad_list_policies',
  'fad_get_policy',
  'fad_create_policy',
  'fad_update_draft_policy',
  'fad_activate_policy',
  'fad_disable_policy',
  'fad_evaluate_access',
  'fad_get_enforcement_config',
  'fad_preflight_enforcement',
  'fad_set_enforcement_config',
  'fad_get_enforcement_decision',
  'fad_list_events',
  'fad_get_event',
  'fad_create_event_subscription',
  'fad_list_event_subscriptions',
  'fad_get_event_subscription',
  'fad_update_event_subscription',
  'fad_rotate_event_subscription_secret',
  'fad_replay_events',
  'fad_get_event_replay',
  'fad_list_event_deliveries',
] as const;

export type ApprovedMcpTool = (typeof APPROVED_MCP_TOOLS)[number];

const APPROVED = new Set<string>(APPROVED_MCP_TOOLS);

export function approvedMcpTool(name: string): name is ApprovedMcpTool {
  return APPROVED.has(name);
}
