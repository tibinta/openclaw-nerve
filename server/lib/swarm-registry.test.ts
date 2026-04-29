import { describe, it, expect } from 'vitest';
import {
  COUNCIL_CLUSTER_AGENT_IDS,
  DEFAULT_SWARM_WAVE_LIMIT,
  MAX_LIVE_SWARM_DISPATCH,
  MAX_SWARM_PACKETS,
  normalizeWaveLimit,
  validateSwarmDispatchInput,
  type SwarmDispatchPacketInput,
} from './swarm-registry.js';

function packet(overrides: Partial<SwarmDispatchPacketInput> = {}): SwarmDispatchPacketInput {
  return {
    packetId: 'crm-math-001',
    cluster: 'crm',
    ownerAgentId: 'james-bell---growth-director',
    checkerAgentId: 'hannah-clark---validation-lead',
    title: 'Calculate reachouts needed for 20 customers',
    task: 'Use the current conversion rate and compute channel targets.',
    dod: 'Reachout target per channel is calculated and written to evidence.',
    evidencePath: '/Users/alexnedelea/.openclaw/workspace/docs/evidence/crm-math-001.md',
    stopCondition: 'Stop after target math is written or CRM source is unavailable.',
    ...overrides,
  };
}

describe('swarm registry', () => {
  const allowedAgentIds = [
    'james-bell---growth-director',
    'hannah-clark---validation-lead',
    'charlotte-price---operations-director',
  ];

  it('hard-codes the executive council clusters used by Jane', () => {
    expect(COUNCIL_CLUSTER_AGENT_IDS.growth).toContain('james-bell---growth-director');
    expect(COUNCIL_CLUSTER_AGENT_IDS.ops).toContain('charlotte-price---operations-director');
    expect(COUNCIL_CLUSTER_AGENT_IDS.qa).toContain('hannah-clark---validation-lead');
    expect(COUNCIL_CLUSTER_AGENT_IDS.crm).toContain('james-bell---growth-director');
  });

  it('defaults wave limit to 8 and refuses to exceed the live dispatch ceiling', () => {
    expect(normalizeWaveLimit(undefined)).toBe(DEFAULT_SWARM_WAVE_LIMIT);
    expect(normalizeWaveLimit(1)).toBe(1);
    expect(() => normalizeWaveLimit(MAX_LIVE_SWARM_DISPATCH + 1)).toThrow('wave_limit_exceeds_max');
  });

  it('accepts a valid packet bundle and returns normalized settings', () => {
    const result = validateSwarmDispatchInput({
      objective: 'Get 20 customers today',
      sourceKind: 'crm_goal',
      waveLimit: 4,
      packets: [packet()],
    }, { allowedAgentIds });

    expect(result.waveLimit).toBe(4);
    expect(result.packets[0].packetId).toBe('crm-math-001');
  });

  it('rejects owner and checker reuse inside one packet', () => {
    expect(() => validateSwarmDispatchInput({
      objective: 'Bad packet',
      sourceKind: 'manual',
      packets: [packet({ checkerAgentId: 'james-bell---growth-director' })],
    }, { allowedAgentIds })).toThrow('checker_must_differ');
  });

  it('rejects owner and checker ids outside the OpenClaw allowlist', () => {
    expect(() => validateSwarmDispatchInput({
      objective: 'Unknown worker',
      sourceKind: 'manual',
      packets: [packet({ ownerAgentId: 'unknown-agent' })],
    }, { allowedAgentIds })).toThrow('agent_not_allowed');
  });

  it('requires packet identity, evidence, done criteria, and stop condition', () => {
    expect(() => validateSwarmDispatchInput({
      objective: 'Incomplete packet',
      sourceKind: 'manual',
      packets: [packet({ evidencePath: '' })],
    }, { allowedAgentIds })).toThrow('packet_missing_evidencePath');
  });

  it('rejects swarms larger than thirty packets', () => {
    const packets = Array.from({ length: MAX_SWARM_PACKETS + 1 }, (_, index) => packet({
      packetId: `packet-${index}`,
    }));

    expect(() => validateSwarmDispatchInput({
      objective: 'Too much at once',
      sourceKind: 'manual',
      packets,
    }, { allowedAgentIds })).toThrow('packet_count_exceeds_max');
  });
});
