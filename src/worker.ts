import 'dotenv/config';
import { NativeConnection, Worker } from '@temporalio/worker';
import { loadConfig } from './shared/config';
import * as scanActivities from './domains/media/activities/scan';
import * as subtitleActivities from './domains/media/activities/subtitles';
import * as metadataActivities from './domains/media/activities/metadata';
import * as llmActivities from './domains/media/activities/llm';
import * as filesystemActivities from './domains/media/activities/filesystem';

async function run() {
  const config = loadConfig();

  // Connect to Temporal Server
  const connection = await NativeConnection.connect({
    address: config.temporalAddress,
  });

  try {
    // Create the worker with all domain activities
    const worker = await Worker.create({
      connection,
      namespace: config.temporalNamespace,
      taskQueue: config.taskQueue,

      // Workflows are bundled separately (V8 isolate)
      workflowsPath: require.resolve('./workflows'),

      // Register all domain activities
      activities: {
        ...scanActivities,
        ...subtitleActivities,
        ...metadataActivities,
        ...llmActivities,
        ...filesystemActivities,
      },

      // Concurrency limits
      maxConcurrentActivityTaskExecutions: config.maxConcurrentActivities,
      maxConcurrentWorkflowTaskExecutions: config.maxConcurrentWorkflowTasks,

      // Required by @temporalio/worker >=1.13 when workflow caching is enabled
      workflowTaskPollerBehavior: { type: 'simple-maximum', maximum: 2 },
    });

    console.log(
      `seraex worker started on task queue: ${config.taskQueue}`,
    );
    console.log(
      `media roots input=${config.mediaInputRoot} staging=${config.mediaStagingRoot} output=${config.mediaOutputRoot}`,
    );

    // Run the worker until shutdown signal
    await worker.run();
  } finally {
    await connection.close();
  }
}

run().catch((err) => {
  console.error('Worker failed:', err);
  process.exit(1);
});
