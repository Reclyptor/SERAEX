/**
 * Typed environment configuration for seraex worker.
 */

export interface SeraexConfig {
  /** Temporal server address (default: localhost:7233) */
  temporalAddress: string;
  /** Temporal namespace (default: default) */
  temporalNamespace: string;
  /** Task queue name (default: SERA) */
  taskQueue: string;
  /** Maximum concurrent activities per worker (default: 10) */
  maxConcurrentActivities: number;
  /** Maximum concurrent workflow tasks per worker (default: 10) */
  maxConcurrentWorkflowTasks: number;
  /** Read-only media input root mounted from NFS */
  mediaInputRoot: string;
  /** Writable processing root for active workflow work */
  mediaProcessingRoot: string;
  /** Writable staging root for structured output awaiting approval */
  mediaStagingRoot: string;
  /** Writable media output root mounted from NFS */
  mediaOutputRoot: string;
  /** Anthropic model for episode matching (default: claude-3-5-haiku-latest) */
  anthropicModel: string;
}

export function loadConfig(): SeraexConfig {
  return {
    temporalAddress: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
    temporalNamespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'SERA',
    maxConcurrentActivities: parseInt(
      process.env.MAX_CONCURRENT_ACTIVITIES ?? '10',
      10,
    ),
    maxConcurrentWorkflowTasks: parseInt(
      process.env.MAX_CONCURRENT_WORKFLOW_TASKS ?? '10',
      10,
    ),
    mediaInputRoot: process.env.MEDIA_INPUT_ROOT ?? '/mnt/media/input',
    mediaProcessingRoot: process.env.MEDIA_PROCESSING_ROOT ?? '/mnt/media/processing',
    mediaStagingRoot: process.env.MEDIA_STAGING_ROOT ?? '/mnt/media/staging',
    mediaOutputRoot: process.env.MEDIA_OUTPUT_ROOT ?? '/mnt/media/output',
    anthropicModel: process.env.ANTHROPIC_MODEL ?? 'claude-3-5-haiku-latest',
  };
}
