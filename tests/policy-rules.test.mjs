import test from 'node:test';
import {
  POLICY_ACTIVE_CEILING,
  PolicyServiceError,
  evaluatePolicies,
  parseEvaluationRequest,
  parsePolicyDefinition,
  valuesEqual,
} from '@fad/db';

const subject = '11111111-1111-4111-8111-111111111111';
const agent = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';

function definition(extra = {}) {
  return {
    name: 'Allow invoke',
    effect: 'allow',
    actions: ['agent.invoke'],
    subjects: { principal_ids: [subject] },
    resource: { type: 'agent', agent_ids: [agent] },
    ...extra,
  };
}

function rule(partial) {
  return {
    id: partial.id,
    revision: partial.revision ?? 1,
    effect: partial.effect,
    actions: partial.actions ?? ['agent.invoke'],
    principalIds: partial.principalIds ?? [subject],
    agentIds: partial.agentIds ?? [agent],
    tagsAll: partial.tagsAll ?? null,
    containsRestricted: partial.containsRestricted ?? false,
  };
}

function facts(partial = {}) {
  return {
    organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    subjectId: subject,
    subjectActive: true,
    action: 'agent.invoke',
    agentId: agent,
    agentStatus: 'active',
    agentRevision: 3,
    activeCount: partial.policies?.length ?? 0,
    policies: [],
    tags: [],
    ...partial,
  };
}

test('policy compiler rejects untrusted and malformed definitions', () => {
  const parsed = parsePolicyDefinition(definition());
  if (parsed.effect !== 'allow' || parsed.agentIds?.[0] !== agent) throw new Error('parser dropped a valid definition');
  const cases = [
    definition({ tags: { department: 'finance' } }),
    definition({ organization_id: subject }),
    definition({ status: 'active' }),
    definition({ resource: { type: 'agent', tags_all: [{ namespace: 'department', key: 'name', operator: 'contains', value: 'a' }] } }),
    definition({ subjects: { principal_ids: [subject, subject] } }),
    definition({ resource: { type: 'agent', tags_all: [
      { namespace: 'department', key: 'name', operator: 'eq', value: 'a' },
      { namespace: 'department', key: 'name', operator: 'eq', value: 'b' },
    ] } }),
    definition({ subjects: { principal_ids: ['not-a-uuid'] } }),
    definition({ name: 'cafe\u0301' }),
    definition({ actions: ['agent.invoke', 'agent.delete'] }),
    definition({ resource: { type: 'agent' } }),
    { ...definition(), unexpected: true },
  ];
  for (const body of cases) {
    let failed = false;
    try {
      parsePolicyDefinition(body);
    } catch (error) {
      failed = error instanceof PolicyServiceError && error.status === 422;
    }
    if (!failed) throw new Error(`accepted ${JSON.stringify(body).slice(0, 120)}`);
  }
  const typed = parsePolicyDefinition(definition({
    resource: { type: 'agent', tags_all: [{ namespace: 'billing', key: 'count', operator: 'eq', value: 100 }] },
  }));
  if (typed.tagsAll?.[0]?.value !== 100) throw new Error('integer predicate was coerced');
  let badEval = false;
  try {
    parseEvaluationRequest({ subject: { principal_id: subject }, action: 'agent.invoke', resource: { type: 'agent', id: agent }, tags: [] });
  } catch (error) {
    badEval = error instanceof PolicyServiceError && error.status === 422;
  }
  if (!badEval) throw new Error('caller tag claim was accepted');
});

test('policy decisions are deterministic and fail closed on overflow', () => {
  if (valuesEqual(100, '100') || valuesEqual('100', 100) || !valuesEqual(false, false) || valuesEqual(true, 'true')) {
    throw new Error('typed comparison is not strict');
  }
  const allow = rule({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01', effect: 'allow', tagsAll: [
    { namespace: 'department', key: 'name', operator: 'eq', value: 'finance' },
  ], agentIds: null });
  const deny = rule({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02', effect: 'deny', tagsAll: [
    { namespace: 'department', key: 'name', operator: 'eq', value: 'finance' },
  ], agentIds: null });
  const tags = [{ namespace: 'department', key: 'name', value: 'finance', revision: 2, deleted: false }];
  const allowed = evaluatePolicies(facts({ policies: [allow], tags, activeCount: 1 }));
  const denied = evaluatePolicies(facts({ policies: [allow, deny], tags, activeCount: 2 }));
  const none = evaluatePolicies(facts({ policies: [], tags, activeCount: 0 }));
  const mismatch = evaluatePolicies(facts({
    policies: [rule({ id: allow.id, effect: 'allow', agentIds: null, tagsAll: [{ namespace: 'billing', key: 'count', operator: 'eq', value: 100 }] })],
    tags: [{ namespace: 'billing', key: 'count', value: '100', revision: 1, deleted: false }],
    activeCount: 1,
  }));
  const tombstone = evaluatePolicies(facts({
    policies: [allow],
    tags: [{ namespace: 'department', key: 'name', value: 'finance', revision: 4, deleted: true }],
    activeCount: 1,
  }));
  const missing = evaluatePolicies(facts({ policies: [allow], tags: [], activeCount: 1 }));
  const inactiveSubject = evaluatePolicies(facts({ policies: [allow], tags, subjectActive: false, activeCount: 1 }));
  const inactiveAgent = evaluatePolicies(facts({ policies: [allow], tags, agentStatus: 'suspended', activeCount: 1 }));
  const again = evaluatePolicies(facts({ policies: [deny, allow], tags, activeCount: 2 }));
  if (allowed.decision !== 'allow' || allowed.reason !== 'EXPLICIT_ALLOW') throw new Error(`allow ${allowed.reason}`);
  if (denied.decision !== 'deny' || denied.reason !== 'EXPLICIT_DENY') throw new Error(`deny ${denied.reason}`);
  if (none.reason !== 'NO_MATCHING_ALLOW' || mismatch.reason !== 'NO_MATCHING_ALLOW') throw new Error('default deny failed');
  if (tombstone.reason !== 'NO_MATCHING_ALLOW' || missing.reason !== 'NO_MATCHING_ALLOW') throw new Error('absent tag matched');
  if (inactiveSubject.reason !== 'SUBJECT_INACTIVE' || inactiveAgent.reason !== 'RESOURCE_INACTIVE') throw new Error('inactive state matched');
  if (denied.inputDigest !== again.inputDigest || denied.policySetDigest !== again.policySetDigest) throw new Error('digest is not stable');
  if (allowed.inputDigest === tombstone.inputDigest) throw new Error('tombstone did not change the input digest');
  const removed = evaluatePolicies(facts({ policies: [allow], tags: [], activeCount: 1 }));
  if (allowed.inputDigest === removed.inputDigest) throw new Error('removing a referenced tag did not change the input digest');
  let overflow = false;
  try {
    evaluatePolicies(facts({ policies: [], activeCount: POLICY_ACTIVE_CEILING + 1 }));
  } catch (error) {
    overflow = error instanceof PolicyServiceError && error.status === 503;
  }
  if (!overflow) throw new Error('active overflow was not fail-closed');
  const parsedCase = parsePolicyDefinition(definition({
    subjects: { principal_ids: [subject.toUpperCase()] },
    resource: { type: 'agent', agent_ids: [agent.toUpperCase()] },
  }));
  if (parsedCase.principalIds[0] !== subject || parsedCase.agentIds?.[0] !== agent) throw new Error('uuid was not canonicalized');
  let duplicateCase = false;
  try {
    parsePolicyDefinition(definition({ subjects: { principal_ids: [subject, subject.toUpperCase()] } }));
  } catch (error) {
    duplicateCase = error instanceof PolicyServiceError && error.status === 422;
  }
  if (!duplicateCase) throw new Error('mixed-case duplicate subjects were accepted');
  const denyId = rule({
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03',
    effect: 'deny',
    agentIds: [agent],
    principalIds: [subject],
    tagsAll: null,
  });
  const allowTag = rule({
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa04',
    effect: 'allow',
    agentIds: null,
    tagsAll: [{ namespace: 'department', key: 'name', operator: 'eq', value: 'finance' }],
  });
  const mixed = evaluatePolicies(facts({
    subjectId: subject.toUpperCase(),
    agentId: agent.toUpperCase(),
    policies: [denyId, allowTag],
    tags,
    activeCount: 2,
  }));
  if (mixed.reason !== 'EXPLICIT_DENY' || mixed.decision !== 'deny') throw new Error(`mixed-case uuid decided ${mixed.reason}`);
  const badValues = [{ v: 'high' }, ['high'], 1.5, null];
  for (const value of badValues) {
    let closed = false;
    try {
      evaluatePolicies(facts({
        policies: [
          rule({
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa05',
            effect: 'deny',
            agentIds: null,
            tagsAll: [{ namespace: 'security', key: 'risk', operator: 'eq', value: 'high' }],
          }),
          rule({
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa06',
            effect: 'allow',
            agentIds: [agent],
            tagsAll: null,
          }),
        ],
        tags: [{ namespace: 'security', key: 'risk', value, revision: 1, deleted: false }],
        activeCount: 2,
      }));
    } catch (error) {
      closed = error instanceof PolicyServiceError && error.status === 503;
    }
    if (!closed) throw new Error(`invalid tag ${JSON.stringify(value)} was not fail-closed`);
  }
  const tombstoneBad = evaluatePolicies(facts({
    policies: [rule({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa05',
      effect: 'deny',
      agentIds: null,
      tagsAll: [{ namespace: 'security', key: 'risk', operator: 'eq', value: 'high' }],
    })],
    tags: [{ namespace: 'security', key: 'risk', value: { v: 'high' }, revision: 1, deleted: true }],
    activeCount: 1,
  }));
  if (tombstoneBad.reason !== 'NO_MATCHING_ALLOW') throw new Error('deleted invalid tag failed open or closed');
  const unrelated = evaluatePolicies(facts({
    policies: [rule({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa06', effect: 'allow', agentIds: [agent], tagsAll: null })],
    tags: [{ namespace: 'security', key: 'risk', value: 1.5, revision: 1, deleted: false }],
    activeCount: 1,
  }));
  if (unrelated.reason !== 'EXPLICIT_ALLOW') throw new Error('unreferenced invalid tag blocked a valid allow');
  if (other === subject) throw new Error('fixture');
});
