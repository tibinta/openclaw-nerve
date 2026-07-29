/* @vitest-environment node */
import { describe, expect, it } from 'vitest';
import {
  buildCodexDesktopPrompt,
  buildCodexDesktopUrl,
  coordinatorWorkspacePath,
  codexBoardStatus,
  isExplicitProjectTask,
  parseCoordinatorDecision,
  resolveProject,
  summarizeTaskThread,
  TASK_DEVELOPER_INSTRUCTIONS,
  type CodexProject,
} from './codex-direct.js';

const projects: CodexProject[] = [
  { label: 'OpenClaw / Nerve', path: '/Users/alex/.openclaw', aliases: ['openclaw', 'nerve', 'jane'], git: true },
  { label: 'LPV-Recorder', path: '/Users/alex/LPV-Recorder', aliases: ['lpv', 'lpv recorder'], git: true },
];

describe('direct Codex project tasks', () => {
  it('routes through a projectless Codex desktop prompt without creating a project', () => {
    const prompt = buildCodexDesktopPrompt('Fix the LPV login issue', ['/tmp/problem.png'], 'proof-123');
    const url = new URL(buildCodexDesktopUrl(prompt));

    expect(url.protocol).toBe('codex:');
    expect(url.pathname).toBe('/new');
    expect(url.searchParams.get('prompt')).toContain('Reuse the relevant existing Codex task');
    expect(url.searchParams.get('prompt')).toContain('Never create a project');
    expect(url.searchParams.get('prompt')).toContain('/tmp/problem.png');
    expect(url.searchParams.has('path')).toBe(false);
  });

  it('answers voice questions directly instead of waiting on an existing task', () => {
    const question = 'Which paired host can you see? Do not create or edit anything.';
    const prompt = buildCodexDesktopPrompt(question, [], 'proof-456');

    expect(isExplicitProjectTask(question)).toBe(false);
    expect(prompt).toContain('Answer directly');
    expect(prompt).toContain('Do not create, continue, message, or wait for another task');
    expect(prompt).not.toContain('Follow delegated work');
  });

  it('reuses the same general Codex task for later voice turns', () => {
    const threadId = '019fa928-c82e-74a2-a6f7-fe3a4fe761d0';
    const url = new URL(buildCodexDesktopUrl('Second voice turn', threadId, 'first-turn-marker'));

    expect(url.pathname).toBe(`/${threadId}`);
    expect(url.searchParams.get('prompt')).toBe('Second voice turn');
    expect(url.searchParams.get('existingMarker')).toBe('first-turn-marker');
  });

  it('keeps the coordinator and task in existing projects', () => {
    expect(coordinatorWorkspacePath()).toBe('/Users/alexnedelea/.openclaw');
    expect(TASK_DEVELOPER_INSTRUCTIONS).toContain('Do not create, fork, hand off, delegate');
    expect(TASK_DEVELOPER_INSTRUCTIONS).toContain('existing project');
    expect(codexBoardStatus('working')).toBe('in-progress');
    expect(codexBoardStatus('verified')).toBe('review');
    expect(codexBoardStatus('stopped')).toBe('cancelled');
  });

  it('can continue an existing Nerve-created Codex task', () => {
    expect(parseCoordinatorDecision(JSON.stringify({
      reply: 'I will add that to the existing task.',
      action: 'continue_task',
      projectPath: '/Users/alex/LPV-Recorder',
      threadId: 'thread-1',
      title: null,
      taskPrompt: 'Also verify the iPhone build.',
    }))).toMatchObject({ action: 'continue_task', threadId: 'thread-1' });
  });

  it('resolves the longest project alias', () => {
    expect(resolveProject('Fix LPV Recorder playback', null, projects)?.path).toBe('/Users/alex/LPV-Recorder');
    expect(isExplicitProjectTask('Fix LPV Recorder playback')).toBe(true);
    expect(isExplicitProjectTask('What is LPV Recorder?')).toBe(false);
  });

  it('only calls a completed task verified when a file change and successful check are recorded', () => {
    const status = summarizeTaskThread({
      status: { type: 'idle' },
      turns: [{
        status: 'completed',
        items: [
          { type: 'fileChange', changes: [{ path: 'src/App.tsx' }] },
          { type: 'commandExecution', command: 'npm test', exitCode: 0 },
          { type: 'agentMessage', phase: 'final_answer', text: 'Implemented and tested.' },
        ],
      }],
    }, {
      threadId: 'thread-1',
      title: 'Fix footer',
      projectPath: '/Users/alex/.openclaw',
      workspacePath: '/Users/alex/.codex/worktrees/task',
      createdAt: '2026-07-28T00:00:00.000Z',
    });

    expect(status.state).toBe('verified');
    expect(status.fileChanges).toBe(1);
    expect(status.checksPassed).toBe(1);
  });
});
