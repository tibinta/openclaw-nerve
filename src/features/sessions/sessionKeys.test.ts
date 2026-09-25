import { describe, expect, it } from 'vitest';
import type { Session } from '@/types';
import { getSessionKey } from '@/types';
import {
  buildAgentRootSessionKey,
  getAgentRegistrationName,
  getRootAgentId,
  getRootAgentSessionKey,
  getSessionDisplayLabel,
  getSessionTailSegment,
  getTopLevelAgentSessions,
  humanizeAgentFamilyId,
  isDirectSessionKey,
  inferParentSessionKey,
  JANE_DIRECT_CHAT_SESSION_KEY,
  JANE_LIVE_VOICE_SESSION_KEY,
  PRIMARY_AGENT_SESSION_KEY,
  isRootChildSession,
  isTopLevelAgentSessionKey,
  pickDefaultSessionKey,
  resolveParentSessionKey,
} from './sessionKeys';

function session(sessionKey: string, extra: Partial<Session> = {}): Session {
  return { sessionKey, ...extra };
}

describe('sessionKeys', () => {
  it('detects top-level agent sessions', () => {
    expect(isTopLevelAgentSessionKey('agent:main:main')).toBe(true);
    expect(isTopLevelAgentSessionKey('agent:reviewer:main')).toBe(true);
    expect(isTopLevelAgentSessionKey('agent:reviewer:subagent:abc')).toBe(false);
    expect(isTopLevelAgentSessionKey('agent:main:telegram:direct:123')).toBe(false);
  });

  it('resolves root keys for subagents and crons', () => {
    expect(getRootAgentSessionKey('agent:reviewer:subagent:abc')).toBe('agent:reviewer:main');
    expect(getRootAgentSessionKey('agent:reviewer:cron:daily')).toBe('agent:reviewer:main');
    expect(getRootAgentSessionKey('agent:reviewer:cron:daily:run:xyz')).toBe('agent:reviewer:main');
  });

  it('resolves root agent id and parent for direct and channel delivery sessions', () => {
    // per-channel-peer: agent:X:<channel>:direct:<peerId>
    expect(isDirectSessionKey('agent:reviewer:telegram:direct:123')).toBe(true);
    expect(getRootAgentId('agent:reviewer:telegram:direct:123')).toBe('reviewer');
    expect(getRootAgentSessionKey('agent:reviewer:telegram:direct:123')).toBe('agent:reviewer:main');
    expect(inferParentSessionKey('agent:reviewer:telegram:direct:123')).toBe('agent:reviewer:main');
    expect(getSessionTailSegment('agent:reviewer:telegram:direct:123')).toBe('123');

    // per-account-channel-peer: agent:X:<channel>:<accountId>:direct:<peerId>
    expect(getRootAgentId('agent:reviewer:telegram:myaccount:direct:123')).toBe('reviewer');
    expect(inferParentSessionKey('agent:reviewer:telegram:myaccount:direct:123')).toBe('agent:reviewer:main');

    // per-peer: agent:X:direct:<peerId>
    expect(getRootAgentId('agent:main:direct:456')).toBe('main');
    expect(inferParentSessionKey('agent:main:direct:456')).toBe('agent:main:main');

    // channel sessions should also resolve back to their root agent
    expect(getRootAgentId('agent:varys:discord:channel:1488657713385701408')).toBe('varys');
    expect(getRootAgentSessionKey('agent:varys:discord:channel:1488657713385701408')).toBe('agent:varys:main');
    expect(inferParentSessionKey('agent:varys:discord:channel:1488657713385701408')).toBe('agent:varys:main');

    // root sessions still return null parent
    expect(inferParentSessionKey('agent:main:main')).toBeNull();
    expect(inferParentSessionKey('agent:reviewer:main')).toBeNull();
  });

  it('detects root-child relationships', () => {
    expect(isRootChildSession('agent:reviewer:subagent:abc', 'agent:reviewer:main')).toBe(true);
    expect(isRootChildSession('agent:main:subagent:abc', 'agent:reviewer:main')).toBe(false);
  });

  it('builds unique root session keys', () => {
    const existing = new Set(['agent:reviewer:main', 'agent:reviewer-2:main']);
    expect(buildAgentRootSessionKey('Reviewer', existing)).toBe('agent:reviewer-3:main');
  });

  it('builds a unique agent registration name for duplicate roots', () => {
    expect(getAgentRegistrationName('Reviewer', 'agent:reviewer:main')).toBe('Reviewer');
    expect(getAgentRegistrationName('Reviewer', 'agent:reviewer-2:main')).toBe('Reviewer 2');
  });

  it('picks top-level agent roots and prefers main', () => {
    const sessions = [
      session('agent:reviewer:main', { label: 'Reviewer' }),
      session('agent:main:main'),
      session('agent:main:telegram:direct:123', { displayName: 'Telegram DM' }),
    ];
    expect(getTopLevelAgentSessions(sessions).map(getSessionKey)).toEqual([
      'agent:main:main',
      'agent:reviewer:main',
    ]);
    expect(pickDefaultSessionKey(sessions)).toBe('agent:main:main');
  });

  it('treats heartbeat-suffixed roots as the same agent family', () => {
    expect(isTopLevelAgentSessionKey('agent:reviewer:main:heartbeat')).toBe(true);
    expect(getRootAgentId('agent:reviewer:main:heartbeat')).toBe('reviewer');
    expect(inferParentSessionKey('agent:reviewer:subagent:child:heartbeat')).toBe('agent:reviewer:main');
    expect(getSessionDisplayLabel(session('agent:reviewer:main:heartbeat', { label: 'heartbeat' }), 'Nerve')).toBe('Agent reviewer');
  });

  it('prefers main before the legacy Jane root when both are present', () => {
    const sessions = [
      session('agent:main:main', { label: 'Main' }),
      session('agent:jane-whitmore---ceo:main', { label: 'Jane Whitmore' }),
      session('agent:reviewer:main', { label: 'Reviewer' }),
    ];
    expect(getTopLevelAgentSessions(sessions).map(getSessionKey)).toEqual([
      'agent:main:main',
      'agent:reviewer:main',
      'agent:jane-whitmore---ceo:main',
    ]);
    expect(pickDefaultSessionKey(sessions)).toBe('agent:main:main');
  });

  it('opens Jane chat on main while preserving explicit iMessage history', () => {
    const imessageKey = 'agent:main:imessage:direct:+447494722196';
    const sessions = [
      session('agent:reviewer:main', { label: 'Reviewer' }),
      session(imessageKey, { label: 'Jane iMessage' }),
      session('agent:main:main', { label: 'Main' }),
    ];

    expect(JANE_DIRECT_CHAT_SESSION_KEY).toBe(PRIMARY_AGENT_SESSION_KEY);
    expect(pickDefaultSessionKey(sessions)).toBe(PRIMARY_AGENT_SESSION_KEY);
    expect(pickDefaultSessionKey(sessions, imessageKey)).toBe(imessageKey);
  });

  it('keeps the preferred Jane-family session when Jane direct is also available', () => {
    const sessions = [
      session('agent:jane-whitmore---ceo:main', { label: 'Jane Whitmore' }),
      session(JANE_DIRECT_CHAT_SESSION_KEY, { label: 'Jane Direct' }),
      session('agent:reviewer:main', { label: 'Reviewer' }),
    ];

    expect(pickDefaultSessionKey(sessions, 'agent:jane-whitmore---ceo:main')).toBe('agent:jane-whitmore---ceo:main');
  });

  it('keeps the preferred session while the live list is still empty', () => {
    expect(pickDefaultSessionKey([], JANE_DIRECT_CHAT_SESSION_KEY)).toBe(JANE_DIRECT_CHAT_SESSION_KEY);
  });

  it('keeps the virtual Nerve Live session across gateway session polls', () => {
    expect(pickDefaultSessionKey([
      session(JANE_DIRECT_CHAT_SESSION_KEY, { label: 'Jane Direct' }),
    ], JANE_LIVE_VOICE_SESSION_KEY)).toBe(JANE_LIVE_VOICE_SESSION_KEY);
  });

  it('keeps the selected Live key when a heartbeat alias appears in a refresh', () => {
    expect(pickDefaultSessionKey([
      session(`${JANE_LIVE_VOICE_SESSION_KEY}:heartbeat`, { label: 'heartbeat' }),
      session(JANE_DIRECT_CHAT_SESSION_KEY, { label: 'Jane Direct' }),
    ], JANE_LIVE_VOICE_SESSION_KEY)).toBe(JANE_LIVE_VOICE_SESSION_KEY);
  });

  it('keeps a selected ordinary session when it is absent from a partial poll', () => {
    expect(pickDefaultSessionKey([
      session(JANE_DIRECT_CHAT_SESSION_KEY, { label: 'Jane Direct' }),
    ], 'agent:reviewer:main')).toBe('agent:reviewer:main');
  });

  it('deduplicates heartbeat aliases when choosing top-level agents', () => {
    const sessions = [
      session('agent:reviewer:main', { label: 'Reviewer' }),
      session('agent:reviewer:main:heartbeat', { label: 'heartbeat', updatedAt: 2_000 }),
      session('agent:reviewer:subagent:child', { label: 'Worker', updatedAt: 3_000 }),
    ];

    expect(getTopLevelAgentSessions(sessions).map(getSessionKey)).toEqual([
      'agent:reviewer:main',
    ]);
  });

  it('builds display labels from label, displayName, then root id', () => {
    expect(getSessionDisplayLabel(session('agent:reviewer:main', { label: 'Reviewer', displayName: 'webchat:reviewer' }), 'Nerve')).toBe('Reviewer');
    expect(getSessionDisplayLabel(session('agent:reviewer:main', { displayName: 'Reviewer Prime' }), 'Nerve')).toBe('Reviewer Prime');
    expect(getSessionDisplayLabel(session('agent:reviewer:main', { label: 'Reviewer' }), 'Nerve')).toBe('Reviewer');
    expect(getSessionDisplayLabel(session('agent:reviewer:main'), 'Nerve')).toBe('Agent reviewer');
    expect(getSessionDisplayLabel(session('agent:main:main'), 'Nerve')).toBe('Nerve (main)');
    expect(getSessionDisplayLabel(session('agent:jane-whitmore---ceo:main'), 'Nerve')).toBe('Agent jane-whitmore---ceo');
  });

  it('keeps the main root label canonical even if gateway metadata says heartbeat', () => {
    expect(getSessionDisplayLabel(session('agent:main:main', { label: 'heartbeat' }), 'Nerve')).toBe('Nerve (main)');
    expect(getSessionDisplayLabel(session('agent:main:main', { displayName: 'heartbeat' }), 'Nerve')).toBe('Nerve (main)');
  });

  it('falls back to inferred parent when explicit parentId is outside the current window', () => {
    const knownKeys = new Set(['agent:reviewer:main', 'agent:reviewer:subagent:child']);
    const child = session('agent:reviewer:subagent:child', { parentId: 'agent:missing:main' });
    expect(resolveParentSessionKey(child, knownKeys)).toBe('agent:reviewer:main');
  });

  it('humanizes slugged agent family ids', () => {
    expect(humanizeAgentFamilyId('jane-whitmore---ceo')).toBe('Jane Whitmore - CEO');
    expect(humanizeAgentFamilyId('atlas-reed---fast-worker')).toBe('Atlas Reed - Fast Worker');
  });
});
