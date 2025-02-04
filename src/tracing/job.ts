import {
  Span,
  TraceAPI,
  SpanStatusCode,
  ROOT_CONTEXT,
  Context,
  trace,
  SpanContext,
} from "@opentelemetry/api";
import { BasicTracerProvider, Tracer } from "@opentelemetry/sdk-trace-base";
import * as core from "@actions/core";
import {
  WorkflowRunJobs,
  WorkflowRunJob,
  WorkflowRunJobStep,
  WorkflowArtifactLookup,
  WorkflowRun,
} from "../github";

import { traceWorkflowRunStep } from "./step";

export type TraceWorkflowRunJobsParams = {
  provider: BasicTracerProvider;
  workflowRunJobs: WorkflowRunJobs;
};

export async function traceWorkflowRunJobs({
  provider,
  workflowRunJobs,
}: TraceWorkflowRunJobsParams): Promise<SpanContext> {
  const tracer = provider.getTracer("otel-export-trace");

  const startTime = new Date(
    workflowRunJobs.workflowRun.run_started_at ||
      workflowRunJobs.workflowRun.created_at
  );
  let headRef = undefined;
  let baseRef = undefined;
  let baseSha = undefined;
  let pull_requests = {};
  if (
    workflowRunJobs.workflowRun.pull_requests &&
    workflowRunJobs.workflowRun.pull_requests.length > 0
  ) {
    headRef = workflowRunJobs.workflowRun.pull_requests[0].head?.ref;
    baseRef = workflowRunJobs.workflowRun.pull_requests[0].base?.ref;
    baseSha = workflowRunJobs.workflowRun.pull_requests[0].base?.sha;
    pull_requests = workflowRunJobs.workflowRun.pull_requests.reduce(
      (result, pr, idx) => {
        const prefix = `github.pull_requests.${idx}`;
        return {
          ...result,
          [`${prefix}.id`]: pr.id,
          [`${prefix}.url`]: pr.url,
          [`${prefix}.number`]: pr.number,
          [`${prefix}.head.sha`]: pr.head.sha,
          [`${prefix}.head.ref`]: pr.head.ref,
          [`${prefix}.head.repo.id`]: pr.head.repo.id,
          [`${prefix}.head.repo.url`]: pr.head.repo.url,
          [`${prefix}.head.repo.name`]: pr.head.repo.name,
          [`${prefix}.base.ref`]: pr.base.ref,
          [`${prefix}.base.sha`]: pr.base.sha,
          [`${prefix}.base.repo.id`]: pr.base.repo.id,
          [`${prefix}.base.repo.url`]: pr.base.repo.url,
          [`${prefix}.base.repo.name`]: pr.base.repo.name,
        };
      },
      {}
    );
  }

  const rootSpan = tracer.startSpan(
    workflowRunJobs.workflowRun.name ||
      `${workflowRunJobs.workflowRun.workflow_id}`,
    {
      attributes: {
        "github.workflow_id": workflowRunJobs.workflowRun.workflow_id,
        "github.run_id": workflowRunJobs.workflowRun.id,
        "github.run_number": workflowRunJobs.workflowRun.run_number,
        "github.run_attempt": workflowRunJobs.workflowRun.run_attempt || 1,
        "github.html_url": workflowRunJobs.workflowRun.html_url,
        "github.workflow_url": workflowRunJobs.workflowRun.workflow_url,
        "github.event": workflowRunJobs.workflowRun.event,
        "github.workflow": workflowRunJobs.workflowRun.name || undefined,
        "github.conclusion":
          workflowRunJobs.workflowRun.conclusion || undefined,
        "github.created_at": workflowRunJobs.workflowRun.created_at,
        "github.updated_at": workflowRunJobs.workflowRun.updated_at,
        "github.run_started_at": workflowRunJobs.workflowRun.run_started_at,
        "github.author_name":
          workflowRunJobs.workflowRun.head_commit?.author?.name || undefined,
        "github.author_email":
          workflowRunJobs.workflowRun.head_commit?.author?.email || undefined,
        "github.head_commit.id":
          workflowRunJobs.workflowRun.head_commit?.id || undefined,
        "github.head_commit.tree_id":
          workflowRunJobs.workflowRun.head_commit?.tree_id || undefined,
        "github.head_commit.author.name":
          workflowRunJobs.workflowRun.head_commit?.author?.email || undefined,
        "github.head_commit.author.email":
          workflowRunJobs.workflowRun.head_commit?.author?.email || undefined,
        "github.head_commit.committer.name":
          workflowRunJobs.workflowRun.head_commit?.committer?.email ||
          undefined,
        "github.head_commit.committer.email":
          workflowRunJobs.workflowRun.head_commit?.committer?.email ||
          undefined,
        "github.head_commit.message":
          workflowRunJobs.workflowRun.head_commit?.message || undefined,
        "github.head_commit.timestamp":
          workflowRunJobs.workflowRun.head_commit?.timestamp || undefined,
        "github.head_sha": workflowRunJobs.workflowRun.head_sha,
        "github.head_ref": headRef,
        "github.base_ref": baseRef,
        "github.base_sha": baseSha,
        error: workflowRunJobs.workflowRun.conclusion === "failure",
        ...pull_requests,
      },
      root: true,
      startTime,
    },
    ROOT_CONTEXT
  );
  core.debug(`TraceID: ${rootSpan.spanContext().traceId}`);
  let code = SpanStatusCode.OK;
  if (workflowRunJobs.workflowRun.conclusion === "failure") {
    code = SpanStatusCode.ERROR;
  }
  rootSpan.setStatus({ code });
  core.debug(
    `Root Span: ${rootSpan.spanContext().traceId}: ${
      workflowRunJobs.workflowRun.created_at
    }`
  );

  try {
    if (workflowRunJobs.jobs.length > 0) {
      const firstJob = workflowRunJobs.jobs[0];
      const queueCtx = trace.setSpan(ROOT_CONTEXT, rootSpan);
      const queueSpan = tracer.startSpan("Queued", { startTime }, queueCtx);
      queueSpan.end(new Date(firstJob.started_at));
    }

    for (let i = 0; i < workflowRunJobs.jobs.length; i++) {
      const job = workflowRunJobs.jobs[i];
      await traceWorkflowRunJob({
        parentSpan: rootSpan,
        parentContext: ROOT_CONTEXT,
        trace,
        tracer,
        job,
        workflowRun: workflowRunJobs.workflowRun,
        workflowArtifacts: workflowRunJobs.workflowRunArtifacts,
      });
    }
  } finally {
    rootSpan.end(new Date(workflowRunJobs.workflowRun.updated_at));
  }
  return rootSpan.spanContext();
}

type TraceWorkflowRunJobParams = {
  parentContext: Context;
  parentSpan: Span;
  trace: TraceAPI;
  tracer: Tracer;
  job: WorkflowRunJob;
  workflowRun: WorkflowRun;
  workflowArtifacts: WorkflowArtifactLookup;
};

async function traceWorkflowRunJob({
  parentContext,
  trace,
  parentSpan,
  tracer,
  job,
  workflowRun,
  workflowArtifacts,
}: TraceWorkflowRunJobParams) {
  core.debug(`Trace Job ${job.id}`);
  if (!job.completed_at) {
    console.warn(`Job ${job.id} is not completed yet`);
    return;
  }
  job.name;
  const ctx = trace.setSpan(parentContext, parentSpan);
  const startTime = new Date(job.started_at);
  const completedTime = new Date(job.completed_at);

  /* eslint-disable */
  // Tried bumping the version to 19 of @octokit/rest but created_at is not available on it :/
  // It surely exists though https://docs.github.com/en/rest/actions/workflow-jobs?apiVersion=2022-11-28
  // @ts-ignore
  const job_created_at: string | undefined = job.created_at || undefined;
  /* eslint-enable */

  // jobs can be queued waiting for a runner to be available
  const createdTime = job_created_at ? new Date(job_created_at) : undefined;
  const queued_ms = createdTime
    ? startTime.getTime() - createdTime.getTime()
    : undefined;

  const span = tracer.startSpan(
    job.name,
    {
      attributes: {
        "github.job.id": job.id,
        "github.job.name": job.name,
        "github.job.run_id": job.run_id,
        "github.job.run_attempt": job.run_attempt || 1,
        "github.job.runner_group_id": job.runner_group_id || undefined,
        "github.job.runner_group_name": job.runner_group_name || undefined,
        "github.job.runner_name": job.runner_name || undefined,
        "github.job.conclusion": job.conclusion || undefined,
        "github.job.labels": job.labels.join(", ") || undefined,
        "github.job.started_at": job.started_at || undefined,
        "github.job.completed_at": job.completed_at || undefined,
        "github.job.created_at": job_created_at,
        "github.job.queued_ms": queued_ms,
        "github.workflow_id": workflowRun.workflow_id,
        "github.run_id": workflowRun.id,
        "github.run_number": workflowRun.run_number,
        "github.workflow": workflowRun.name || undefined,
        "github.head_sha": workflowRun.head_sha,
        "github.head_branch": workflowRun.head_branch || undefined,
        "github.conclusion": job.conclusion || undefined,
        error: job.conclusion === "failure",
      },
      startTime,
    },
    ctx
  );
  const spanId = span.spanContext().spanId;
  core.debug(`Job Span<${spanId}>: Started<${job.started_at}>`);

  try {
    let code = SpanStatusCode.OK;
    if (job.conclusion === "failure") {
      code = SpanStatusCode.ERROR;
    }
    span.setStatus({ code });
    const numSteps = job.steps?.length || 0;
    core.debug(`Trace ${numSteps} Steps`);
    if (job.steps !== undefined) {
      for (let i = 0; i < job.steps.length; i++) {
        const step: WorkflowRunJobStep = job.steps[i];
        await traceWorkflowRunStep({
          job,
          parentContext: ctx,
          trace,
          parentSpan: span,
          tracer,
          workflowArtifacts,
          step,
          workflowRun,
        });
      }
    }
  } finally {
    core.debug(`Job Span<${spanId}>: Ended<${job.completed_at}>`);
    // Some skipped and post jobs return completed_at dates that are older than started_at
    span.end(new Date(Math.max(startTime.getTime(), completedTime.getTime())));
  }
}
