/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { EsWorkflowStepExecution } from '@kbn/workflows';
import { ExecutionStatus, isCancelableStatus, isTerminalStatus } from '@kbn/workflows';
import type { WorkflowExecutionRepository } from '../repositories/workflow_execution_repository';
import type { WorkflowExecutionState } from '../workflow_context_manager/workflow_execution_state';
import type { WorkflowTaskManager } from '../workflow_task_manager/workflow_task_manager';

const IDLE_STATUSES: readonly ExecutionStatus[] = [
  ExecutionStatus.WAITING,
  ExecutionStatus.WAITING_FOR_INPUT,
  ExecutionStatus.PENDING,
];

/**
 * Finds the active sync child execution ID from the step executions in memory.
 * Looks for a `workflow.execute` step that has a `SubWorkflowWaitState` with an `executionId`.
 */
export function findActiveChildExecutionId(
  workflowExecutionState: WorkflowExecutionState
): string | undefined {
  const stepExecutions = workflowExecutionState.getAllStepExecutions();
  for (const step of stepExecutions) {
    if (step.stepType === 'workflow.execute' && !isTerminalStatus(step.status)) {
      const childId = extractChildExecutionId(step);
      if (childId) {
        return childId;
      }
    }
  }
  return undefined;
}

function extractChildExecutionId(step: EsWorkflowStepExecution): string | undefined {
  const state = step.state as { executionId?: string } | undefined;
  return state?.executionId;
}

/**
 * Cancels a single child workflow execution by its known ID using a `get` query (not `search`).
 *
 * For idle children (WAITING/PENDING), sets status to CANCELLED immediately.
 * For running children, sets cancelRequested so the monitoring loop picks it up.
 * Calls forceRunIdleTasks so the child's task wakes up and processes the cancellation.
 *
 * When that child's execution loop ends with CANCELLED, it will in turn cancel
 * its own child (if any), propagating down the chain naturally.
 */
export async function cancelChildExecution(
  childExecutionId: string,
  spaceId: string,
  workflowExecutionRepository: WorkflowExecutionRepository,
  workflowTaskManager: WorkflowTaskManager,
  cancellationReason: string = 'Cancelled due to parent workflow cancellation'
): Promise<void> {
  const childExecution = await workflowExecutionRepository.getWorkflowExecutionById(
    childExecutionId,
    spaceId
  );

  if (!childExecution) {
    return;
  }

  if (!isCancelableStatus(childExecution.status)) {
    return;
  }

  const cancellationTimestamp = new Date().toISOString();
  const isIdle = IDLE_STATUSES.includes(childExecution.status);

  await workflowExecutionRepository.updateWorkflowExecution({
    id: childExecution.id,
    cancelRequested: true,
    cancellationReason,
    cancelledAt: cancellationTimestamp,
    cancelledBy: 'system',
    ...(isIdle ? { status: ExecutionStatus.CANCELLED, finishedAt: cancellationTimestamp } : {}),
  });

  await workflowTaskManager.forceRunIdleTasks(childExecution.id);
}
