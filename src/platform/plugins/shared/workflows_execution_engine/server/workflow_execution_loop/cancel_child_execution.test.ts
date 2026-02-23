/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { EsWorkflowStepExecution } from '@kbn/workflows';
import { ExecutionStatus } from '@kbn/workflows';

import { cancelChildExecution, findActiveChildExecutionId } from './cancel_child_execution';
import type { WorkflowExecutionRepository } from '../repositories/workflow_execution_repository';
import type { WorkflowExecutionState } from '../workflow_context_manager/workflow_execution_state';
import type { WorkflowTaskManager } from '../workflow_task_manager/workflow_task_manager';

describe('findActiveChildExecutionId', () => {
  const createMockState = (
    stepExecutions: EsWorkflowStepExecution[]
  ): jest.Mocked<WorkflowExecutionState> =>
    ({
      getAllStepExecutions: jest.fn().mockReturnValue(stepExecutions),
    } as unknown as jest.Mocked<WorkflowExecutionState>);

  const makeStepExecution = (
    overrides: Partial<EsWorkflowStepExecution>
  ): EsWorkflowStepExecution =>
    ({
      id: 'step-1',
      stepId: 'myStep',
      stepType: 'slack',
      status: ExecutionStatus.RUNNING,
      scopeStack: [],
      ...overrides,
    } as EsWorkflowStepExecution);

  it('should return undefined when no step executions exist', () => {
    const state = createMockState([]);
    expect(findActiveChildExecutionId(state)).toBeUndefined();
  });

  it('should return undefined when no workflow.execute steps exist', () => {
    const state = createMockState([
      makeStepExecution({ stepType: 'slack', status: ExecutionStatus.RUNNING }),
    ]);
    expect(findActiveChildExecutionId(state)).toBeUndefined();
  });

  it('should return the child execution ID from a non-terminal workflow.execute step', () => {
    const state = createMockState([
      makeStepExecution({
        stepType: 'workflow.execute',
        status: ExecutionStatus.RUNNING,
        state: { executionId: 'child-exec-123', workflowId: 'w1', pollCount: 0 },
      }),
    ]);
    expect(findActiveChildExecutionId(state)).toBe('child-exec-123');
  });

  it('should skip terminal workflow.execute steps', () => {
    const state = createMockState([
      makeStepExecution({
        stepType: 'workflow.execute',
        status: ExecutionStatus.COMPLETED,
        state: { executionId: 'old-child', workflowId: 'w1', pollCount: 5 },
      }),
    ]);
    expect(findActiveChildExecutionId(state)).toBeUndefined();
  });

  it('should return the first active child when multiple workflow.execute steps exist', () => {
    const state = createMockState([
      makeStepExecution({
        id: 'step-1',
        stepType: 'workflow.execute',
        status: ExecutionStatus.COMPLETED,
        state: { executionId: 'old-child' },
      }),
      makeStepExecution({
        id: 'step-2',
        stepType: 'workflow.execute',
        status: ExecutionStatus.RUNNING,
        state: { executionId: 'active-child' },
      }),
    ]);
    expect(findActiveChildExecutionId(state)).toBe('active-child');
  });

  it('should return undefined when workflow.execute step has no state', () => {
    const state = createMockState([
      makeStepExecution({
        stepType: 'workflow.execute',
        status: ExecutionStatus.RUNNING,
        state: undefined,
      }),
    ]);
    expect(findActiveChildExecutionId(state)).toBeUndefined();
  });
});

describe('cancelChildExecution', () => {
  let mockRepo: jest.Mocked<WorkflowExecutionRepository>;
  let mockTaskManager: jest.Mocked<WorkflowTaskManager>;

  beforeEach(() => {
    mockRepo = {
      getWorkflowExecutionById: jest.fn(),
      updateWorkflowExecution: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<WorkflowExecutionRepository>;

    mockTaskManager = {
      forceRunIdleTasks: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<WorkflowTaskManager>;
  });

  it('should do nothing when child execution is not found', async () => {
    mockRepo.getWorkflowExecutionById.mockResolvedValue(null);

    await cancelChildExecution('child-1', 'default', mockRepo, mockTaskManager);

    expect(mockRepo.updateWorkflowExecution).not.toHaveBeenCalled();
    expect(mockTaskManager.forceRunIdleTasks).not.toHaveBeenCalled();
  });

  it('should do nothing when child is already in terminal state', async () => {
    mockRepo.getWorkflowExecutionById.mockResolvedValue({
      id: 'child-1',
      status: ExecutionStatus.COMPLETED,
      spaceId: 'default',
    } as any);

    await cancelChildExecution('child-1', 'default', mockRepo, mockTaskManager);

    expect(mockRepo.updateWorkflowExecution).not.toHaveBeenCalled();
    expect(mockTaskManager.forceRunIdleTasks).not.toHaveBeenCalled();
  });

  it('should set cancelRequested for a running child without setting CANCELLED status', async () => {
    mockRepo.getWorkflowExecutionById.mockResolvedValue({
      id: 'child-1',
      status: ExecutionStatus.RUNNING,
      spaceId: 'default',
    } as any);

    await cancelChildExecution('child-1', 'default', mockRepo, mockTaskManager);

    expect(mockRepo.updateWorkflowExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'child-1',
        cancelRequested: true,
      })
    );
    // Running children should NOT be set to CANCELLED directly
    const updateArg = mockRepo.updateWorkflowExecution.mock.calls[0][0];
    expect(updateArg.status).toBeUndefined();

    expect(mockTaskManager.forceRunIdleTasks).toHaveBeenCalledWith('child-1');
  });

  it('should set CANCELLED status directly for idle (WAITING) children', async () => {
    mockRepo.getWorkflowExecutionById.mockResolvedValue({
      id: 'child-1',
      status: ExecutionStatus.WAITING,
      spaceId: 'default',
    } as any);

    await cancelChildExecution('child-1', 'default', mockRepo, mockTaskManager);

    expect(mockRepo.updateWorkflowExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'child-1',
        cancelRequested: true,
        status: ExecutionStatus.CANCELLED,
        finishedAt: expect.any(String),
      })
    );
    expect(mockTaskManager.forceRunIdleTasks).toHaveBeenCalledWith('child-1');
  });

  it('should set CANCELLED status directly for idle (PENDING) children', async () => {
    mockRepo.getWorkflowExecutionById.mockResolvedValue({
      id: 'child-1',
      status: ExecutionStatus.PENDING,
      spaceId: 'default',
    } as any);

    await cancelChildExecution('child-1', 'default', mockRepo, mockTaskManager);

    expect(mockRepo.updateWorkflowExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'child-1',
        cancelRequested: true,
        status: ExecutionStatus.CANCELLED,
      })
    );
  });

  it('should use the provided cancellation reason', async () => {
    mockRepo.getWorkflowExecutionById.mockResolvedValue({
      id: 'child-1',
      status: ExecutionStatus.RUNNING,
      spaceId: 'default',
    } as any);

    await cancelChildExecution('child-1', 'default', mockRepo, mockTaskManager, 'Custom reason');

    expect(mockRepo.updateWorkflowExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        cancellationReason: 'Custom reason',
      })
    );
  });
});
