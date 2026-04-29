import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SwarmCluster, SwarmSourceKind } from './kanban-store.js';

export const MAX_LIVE_SWARM_DISPATCH = 8;
export const DEFAULT_SWARM_WAVE_LIMIT = 8;
export const MAX_SWARM_PACKETS = 30;
export const DEFAULT_OPENCLAW_CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'openclaw.json');

export type CouncilClusterMap = Record<SwarmCluster, readonly string[]>;

// Jane's council registry, mirrored from workspace-jane-whitmore-ceo/COUNCIL.md.
// The API validates against agent ids, not display names, so packets cannot route
// to cosmetic names or the legacy agent:main lane.
export const COUNCIL_CLUSTER_AGENT_IDS: CouncilClusterMap = {
  growth: [
    'amelia-reed---cmo',
    'olivia-green---ads-lead',
    'james-bell---growth-director',
    'sophie-turner---campaign-manager',
    'benjamin-scott---outreach-lead',
    'emily-brown---ads-ic',
    'jack-wilson---outreach-ic',
  ],
  ops: [
    'charlotte-price---operations-director',
    'victoria-cole---delivery-director',
    'daniel-hughes---operations-manager',
    'matthew-king---delivery-manager',
    'george-miller---delivery-lead',
    'oscar-turner---coordination',
    'oliver-hart---coo',
    'eleanor-shaw---chief-of-staff',
    'sentinel-brooks---standard',
  ],
  finance: [
    'henry-blake---cfo',
    'ledger-vale---scout',
    'hannah-clark---validation-lead',
  ],
  product: [
    'thomas-ward---cto---head-of-product',
    'oracle-wells---reasoner',
    'architect-quinn---deep',
    'atlas-reed---fast-worker',
  ],
  qa: [
    'hannah-clark---validation-lead',
    'ruby-young---qa',
    'grace-davis---validation-ic',
    'ledger-vale---scout',
  ],
  docs: [
    'arthur-cooper---docs',
    'freya-allen---enablement',
    'echo-marin---voice-jane',
    'noah-hill---assistant',
    'isla-foster---ops',
  ],
  media: [
    'echo-marin---voice-jane',
    'amelia-reed---cmo',
    'arthur-cooper---docs',
    'benjamin-scott---outreach-lead',
    'hannah-clark---validation-lead',
  ],
  crm: [
    'james-bell---growth-director',
    'benjamin-scott---outreach-lead',
    'jack-wilson---outreach-ic',
    'amelia-reed---cmo',
    'charlotte-price---operations-director',
  ],
};

export interface SwarmDispatchPacketInput {
  packetId: string;
  cluster: SwarmCluster;
  ownerAgentId: string;
  checkerAgentId: string;
  title: string;
  task: string;
  dod: string;
  evidencePath: string;
  stopCondition: string;
  sourceUrl?: string;
}

export interface SwarmDispatchInput {
  objective: string;
  sourceKind: SwarmSourceKind;
  waveLimit?: number;
  execute?: boolean;
  packets: SwarmDispatchPacketInput[];
}

export interface SwarmValidationOptions {
  allowedAgentIds?: Iterable<string>;
  openclawConfigPath?: string;
}

export interface ValidatedSwarmDispatchInput extends SwarmDispatchInput {
  waveLimit: number;
  execute: boolean;
  packets: SwarmDispatchPacketInput[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function normalizeWaveLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_SWARM_WAVE_LIMIT;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('wave_limit_invalid: waveLimit must be a positive integer');
  }
  if (value > MAX_LIVE_SWARM_DISPATCH) {
    throw new Error(`wave_limit_exceeds_max: waveLimit cannot exceed ${MAX_LIVE_SWARM_DISPATCH}`);
  }
  return value;
}

export function loadOpenClawAllowedAgentIds(configPath = DEFAULT_OPENCLAW_CONFIG_PATH): Set<string> {
  const raw = fs.readFileSync(configPath, 'utf8');
  const config = JSON.parse(raw) as {
    agents?: {
      defaults?: { subagents?: { allowAgents?: unknown } };
      list?: Array<{ id?: unknown }>;
    };
  };

  const explicitAllow = config.agents?.defaults?.subagents?.allowAgents;
  if (Array.isArray(explicitAllow)) {
    return new Set(explicitAllow.filter((id): id is string => typeof id === 'string' && id.trim().length > 0));
  }

  const agentList = config.agents?.list;
  if (Array.isArray(agentList)) {
    return new Set(agentList
      .map((agent) => agent.id)
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0 && id !== 'main'));
  }

  return new Set();
}

function resolveAllowedAgentIds(options: SwarmValidationOptions): Set<string> {
  if (options.allowedAgentIds) return new Set(options.allowedAgentIds);
  return loadOpenClawAllowedAgentIds(options.openclawConfigPath);
}

function validatePacketRequiredFields(packet: SwarmDispatchPacketInput): void {
  const required: Array<keyof SwarmDispatchPacketInput> = [
    'packetId',
    'cluster',
    'ownerAgentId',
    'checkerAgentId',
    'title',
    'task',
    'dod',
    'evidencePath',
    'stopCondition',
  ];

  for (const field of required) {
    if (!isNonEmptyString(packet[field])) {
      throw new Error(`packet_missing_${field}: ${field} is required`);
    }
  }
}

function assertAllowedAgent(agentId: string, allowedAgentIds: Set<string>, field: 'ownerAgentId' | 'checkerAgentId'): void {
  if (agentId === 'main' || agentId === 'agent:main' || agentId.includes('agent:main')) {
    throw new Error(`agent_main_forbidden: ${field} cannot route to agent:main`);
  }
  if (!allowedAgentIds.has(agentId)) {
    throw new Error(`agent_not_allowed: ${field} ${agentId} is not in the OpenClaw allowlist`);
  }
}

export function validateSwarmDispatchInput(
  input: SwarmDispatchInput,
  options: SwarmValidationOptions = {},
): ValidatedSwarmDispatchInput {
  if (!isNonEmptyString(input.objective)) {
    throw new Error('objective_required: objective is required');
  }
  if (!Array.isArray(input.packets) || input.packets.length === 0) {
    throw new Error('packet_count_required: at least one packet is required');
  }
  if (input.packets.length > MAX_SWARM_PACKETS) {
    throw new Error(`packet_count_exceeds_max: at most ${MAX_SWARM_PACKETS} packets are allowed`);
  }

  const allowedAgentIds = resolveAllowedAgentIds(options);
  const waveLimit = normalizeWaveLimit(input.waveLimit);

  for (const packet of input.packets) {
    validatePacketRequiredFields(packet);
    if (!Object.prototype.hasOwnProperty.call(COUNCIL_CLUSTER_AGENT_IDS, packet.cluster)) {
      throw new Error(`unknown_cluster: ${packet.cluster}`);
    }
    if (packet.ownerAgentId === packet.checkerAgentId) {
      throw new Error('checker_must_differ: checkerAgentId must differ from ownerAgentId');
    }
    assertAllowedAgent(packet.ownerAgentId, allowedAgentIds, 'ownerAgentId');
    assertAllowedAgent(packet.checkerAgentId, allowedAgentIds, 'checkerAgentId');
  }

  return {
    objective: input.objective,
    sourceKind: input.sourceKind,
    waveLimit,
    execute: input.execute ?? true,
    packets: input.packets.map((packet) => ({ ...packet })),
  };
}
