import { useState } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import { useKanbanDragDrop } from './useKanbanDragDrop';
import type { KanbanTask } from '../types';

afterEach(cleanup);
const items = [
  { id: 'normal', priority: 'normal', columnOrder: 0 },
  { id: 'high-a', priority: 'high', columnOrder: 1 },
  { id: 'high-b', priority: 'high', columnOrder: 2 },
].map(t => ({ ...t, status: 'todo', version: 1 } as KanbanTask));
const start = (id: string) => ({ active: { id } } as DragStartEvent);
const drop = (id: string, over: string) => ({ active: { id }, over: { id: over } } as DragEndEvent);

it.each([['high-a', 'high-b', 2], ['high-b', 'high-a', 1]] as const)(
  'moves %s over %s within priority while using raw API index', async (id, over, index) => {
    const reorder = vi.fn(async () => ({ ...items.find(t => t.id === id)!, version: 2, columnOrder: index }));
    const { result } = renderHook(() => {
      const [tasks, setTasks] = useState(items);
      return { tasks, ...useKanbanDragDrop({ tasks, setTasksOptimistic: setTasks, reorderTask: reorder }) };
    });
    act(() => result.current.onDragStart(start(id)));
    await act(async () => { await result.current.onDragEnd(drop(id, over)); });
    expect(reorder).toHaveBeenCalledWith(id, 1, 'todo', index);
    expect(result.current.tasks.find(t => t.id === id)?.version).toBe(2);
  },
);

it('rolls back a conflict using a captured snapshot and keeps the latest version', async () => {
  const latest = { ...items[1], version: 4 };
  const reorder = vi.fn(async () => { throw Object.assign(new Error('version_conflict'), { latest }); });
  const { result } = renderHook(() => {
    const [tasks, setTasks] = useState(items);
    return { tasks, ...useKanbanDragDrop({ tasks, setTasksOptimistic: setTasks, reorderTask: reorder }) };
  });
  act(() => result.current.onDragStart(start('high-a')));
  await act(async () => { await result.current.onDragEnd(drop('high-a', 'high-b')); });
  expect(result.current.tasks.find(t => t.id === 'high-a')).toEqual(latest);
  expect(result.current.tasks).toHaveLength(3);
});
