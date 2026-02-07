import {
  proxyActivities,
  defineQuery,
  defineSignal,
  setHandler,
  executeChild,
  workflowInfo,
  condition,
} from '@temporalio/workflow';

import type * as scanActivities from '../activities/scan';
import type * as filesystemActivities from '../activities/filesystem';
import type * as metadataActivities from '../activities/metadata';

type Activities = typeof scanActivities &
  typeof filesystemActivities &
  typeof metadataActivities;

import type {
  OrganizeLibraryInput,
  OrganizeLibraryResult,
  OrganizeLibraryProgress,
  ProcessFolderInput,
  ProcessFolderResult,
  FolderStatus,
  FolderResult,
  FinalizeDecision,
  WorkflowStage,
  SeriesMetadata,
  FileTreeNode,
} from '../../../shared/types';
import { processFolder } from './process-folder';

// ── Activity proxies with appropriate NAS timeouts ──────────────────

/** Scanning is fast even over NFS */
const { scanDirectory } = proxyActivities<Activities>({
  startToCloseTimeout: '2 minutes',
});

/** Metadata fetching (AniList API, including relation traversal) */
const { fetchSeriesMetadata } = proxyActivities<Activities>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 3 },
});

/** Copying a large series from NAS input to processing can be slow */
const { copyToProcessing } = proxyActivities<Activities>({
  startToCloseTimeout: '30 minutes',
  heartbeatTimeout: '2 minutes',
  retry: { maximumAttempts: 2 },
});

/** Structuring, merging, and cleanup involve moderate-to-large NAS copies */
const {
  structureToStaging,
  mergeToOutput,
  cleanupProcessing,
  cleanupStaging,
  listStagingTree,
} = proxyActivities<Activities>({
  startToCloseTimeout: '30 minutes',
  heartbeatTimeout: '2 minutes',
  retry: { maximumAttempts: 2 },
});

// ── Signals & Queries ───────────────────────────────────────────────

export const getProgressQuery =
  defineQuery<OrganizeLibraryProgress>('getProgress');
export const getStagingTreeQuery =
  defineQuery<FileTreeNode[]>('getStagingTree');
export const finalizeSignal = defineSignal<[FinalizeDecision]>('finalize');

/** Maximum number of folders to process in parallel */
const MAX_PARALLEL_FOLDERS = 5;

// ── Workflow ────────────────────────────────────────────────────────

/**
 * Parent workflow: organizes a single anime series.
 *
 * Phase 1 — Processing:
 *   1. Copy series root to processing dir (input is read-only)
 *   2. Fetch full series metadata (all seasons) from AniList
 *   3. Detect disc structure
 *   4. Spawn processFolder child for each disc (block-finalize HIL)
 *
 * Phase 2 — Staging:
 *   5. Structure into Plex-compatible layout in staging dir
 *   6. Capture staging file tree for user review
 *   7. Clean up processing dir
 *   8. Await explicit finalize signal from user
 *
 * Phase 3 — Output:
 *   9. Merge staging into output (handles existing series dirs)
 *  10. Clean up staging dir
 */
export async function organizeLibrary(
  input: OrganizeLibraryInput,
): Promise<OrganizeLibraryResult> {
  const confidenceThreshold = input.confidenceThreshold ?? 0.85;
  const minDurationMinutes = input.minDurationMinutes ?? 20;

  // ── Mutable state ──
  let workflowStage: WorkflowStage = 'copying';
  let expectedCoreEpisodeCount = 0;
  let resolvedCoreEpisodeCount = 0;
  let unresolvedCoreEpisodeCount = 0;
  let canFinalize = false;
  let awaitingFinalApproval = false;
  let finalized = false;
  let stagingTree: FileTreeNode[] = [];

  const folderStatuses: Record<string, FolderStatus> = {};
  const folderResults: FolderResult[] = [];
  const allRenamedFilePaths: string[] = [];
  const allExtraFiles: string[] = [];

  // ── Finalize signal handler ──
  setHandler(finalizeSignal, (decision: FinalizeDecision) => {
    if (decision.approved && canFinalize) {
      finalized = true;
    }
  });

  // ── Progress query handler ──
  setHandler(getProgressQuery, (): OrganizeLibraryProgress => {
    const statuses = Object.values(folderStatuses);
    return {
      totalFolders: Object.keys(folderStatuses).length,
      foldersCompleted: statuses.filter((s) => s === 'completed').length,
      foldersFailed: statuses.filter((s) => s === 'failed').length,
      foldersInProgress: statuses.filter(
        (s) =>
          s !== 'completed' &&
          s !== 'failed' &&
          s !== 'pending' &&
          s !== 'awaiting_review',
      ).length,
      foldersPendingReview: statuses.filter(
        (s) => s === 'awaiting_review',
      ).length,
      folderStatuses: { ...folderStatuses },
      workflowStage,
      expectedCoreEpisodeCount,
      resolvedCoreEpisodeCount,
      unresolvedCoreEpisodeCount,
      canFinalize,
      awaitingFinalApproval,
    };
  });

  // ── Staging tree query handler ──
  setHandler(getStagingTreeQuery, (): FileTreeNode[] => {
    return stagingTree;
  });

  // ════════════════════════════════════════════════════════════════════
  // Phase 1: Processing
  // ════════════════════════════════════════════════════════════════════

  // ── Step 1: Copy to processing ──
  const wfId = workflowInfo().workflowId;
  const processingSeriesDir = await copyToProcessing(
    input.sourceDir,
    wfId,
    input.dryRun,
  );
  // The processing workflow dir is the parent of the series dir
  // e.g., processing/{wfId}/SeriesName → parent is processing/{wfId}
  const processingWorkflowDir = processingSeriesDir.substring(
    0,
    processingSeriesDir.lastIndexOf('/'),
  );

  // ── Step 2: Fetch full series metadata (all seasons) ──
  workflowStage = 'detecting';
  const seriesName = resolveShowName(input.sourceDir);
  const seriesMetadata = await fetchSeriesMetadata(seriesName);

  if (!seriesMetadata || seriesMetadata.seasons.length === 0) {
    workflowStage = 'failed';
    await cleanupProcessing(processingWorkflowDir, input.dryRun);
    return {
      totalFolders: 0,
      completed: 0,
      failed: 0,
      pendingReview: 0,
      folders: [],
      extraFiles: [],
    };
  }

  expectedCoreEpisodeCount = seriesMetadata.totalCoreEpisodes;

  // ── Step 3: Detect disc structure ──
  const subdirs = await scanDirectory(processingSeriesDir);

  // Build the list of folders (discs) to process.
  // Flat structure (no subdirs): treat the series root itself as one folder.
  // Nested structure (Disc 01/, Disc 02/, etc.): each subdir is a disc.
  // NOTE: disc numbers are NOT season numbers. The LLM + metadata determine seasons.
  let foldersToProcess: Array<{ name: string; path: string }>;

  if (subdirs.length === 0) {
    foldersToProcess = [
      { name: seriesName, path: processingSeriesDir },
    ];
  } else {
    foldersToProcess = subdirs.map((dir) => ({
      name: dir.name,
      path: dir.path,
    }));
  }

  // Initialize folder statuses
  for (const folder of foldersToProcess) {
    folderStatuses[folder.name] = 'pending';
  }

  // ── Step 4: Process discs in parallel ──
  workflowStage = 'extracting';
  const pendingFolders = [...foldersToProcess];
  const inFlightPromises = new Map<string, Promise<ProcessFolderResult>>();

  while (pendingFolders.length > 0 || inFlightPromises.size > 0) {
    // Launch up to MAX_PARALLEL_FOLDERS concurrent children
    while (
      pendingFolders.length > 0 &&
      inFlightPromises.size < MAX_PARALLEL_FOLDERS
    ) {
      const folder = pendingFolders.shift()!;
      folderStatuses[folder.name] = 'scanning';

      const childInput: ProcessFolderInput = {
        folderPath: folder.path,
        folderName: folder.name,
        seriesMetadata,
        dryRun: input.dryRun,
        minDurationMinutes,
        confidenceThreshold,
      };

      const promise = executeChild(processFolder, {
        args: [childInput],
        workflowId: `${wfId}/process-folder/${sanitizeWorkflowId(folder.name)}`,
      });

      inFlightPromises.set(folder.name, promise);
    }

    // Wait for the next child to complete
    if (inFlightPromises.size > 0) {
      const entries = Array.from(inFlightPromises.entries());
      const raceResult = await Promise.race(
        entries.map(async ([name, promise]) => {
          const result = await promise;
          return { name, result };
        }),
      );

      const { name, result } = raceResult;
      folderStatuses[name] = result.status;
      folderResults.push({
        folderName: result.folderName,
        folderPath: '',
        status: result.status,
        episodesFound: result.episodesFound,
        episodesRenamed: result.episodesRenamed,
        episodesPendingReview: result.episodesPendingReview,
        error: result.error,
      });

      // Aggregate episode counts
      resolvedCoreEpisodeCount += result.episodesRenamed;

      // Collect renamed file paths for output structuring
      for (const rf of result.renamedFiles) {
        allRenamedFilePaths.push(rf.newPath);
      }

      // Update stage based on what's still happening
      const hasAwaitingReview = Object.values(folderStatuses).some(
        (s) => s === 'awaiting_review',
      );
      if (hasAwaitingReview) {
        workflowStage = 'awaiting_review';
      } else if (pendingFolders.length > 0 || inFlightPromises.size > 1) {
        workflowStage = 'matching';
      }

      inFlightPromises.delete(name);
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // Phase 2: Staging
  // ════════════════════════════════════════════════════════════════════

  // All children done. Since children block-finalize, every episode is resolved.
  const totalCompleted = folderResults.filter(
    (r) => r.status === 'completed',
  ).length;
  const totalFailed = folderResults.filter(
    (r) => r.status === 'failed',
  ).length;
  unresolvedCoreEpisodeCount = 0;
  resolvedCoreEpisodeCount = allRenamedFilePaths.length;

  // ── Step 5: Structure into staging ──
  workflowStage = 'structuring';
  const showName = seriesMetadata.seriesName;
  const { stagingShowDir, extraFiles } = await structureToStaging(
    processingSeriesDir,
    wfId,
    showName,
    allRenamedFilePaths,
    input.dryRun,
  );
  allExtraFiles.push(...extraFiles);

  // The staging workflow dir is the parent of the show dir
  // e.g., staging/{wfId}/ShowName → parent is staging/{wfId}
  const stagingWorkflowDir = stagingShowDir.substring(
    0,
    stagingShowDir.lastIndexOf('/'),
  );

  // ── Step 6: Capture staging file tree for user review ──
  stagingTree = await listStagingTree(stagingShowDir);

  // ── Step 7: Clean up processing ──
  await cleanupProcessing(processingWorkflowDir, input.dryRun);

  // ── Step 8: Await finalize signal from user ──
  canFinalize = totalFailed === 0 && allRenamedFilePaths.length > 0;
  awaitingFinalApproval = canFinalize;
  workflowStage = 'awaiting_finalize';

  if (canFinalize) {
    await condition(() => finalized);
  }

  // ════════════════════════════════════════════════════════════════════
  // Phase 3: Output
  // ════════════════════════════════════════════════════════════════════

  // ── Step 9: Merge staging into output ──
  workflowStage = 'finalizing';
  await mergeToOutput(stagingShowDir, showName, input.dryRun);

  // ── Step 10: Clean up staging ──
  await cleanupStaging(stagingWorkflowDir, input.dryRun);

  workflowStage = 'completed';
  return {
    totalFolders: folderResults.length,
    completed: totalCompleted,
    failed: totalFailed,
    pendingReview: 0,
    folders: folderResults,
    extraFiles: allExtraFiles,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Extract the show name from the source directory path.
 * Uses the directory basename, which is the series folder name on the NAS.
 */
function resolveShowName(sourceDir: string): string {
  return basename(sourceDir);
}

/**
 * Sanitize a string for use as a Temporal workflow ID component.
 */
function sanitizeWorkflowId(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 200);
}

/**
 * Get the basename of a path. Workflow-safe (no Node.js path module).
 */
function basename(filePath: string): string {
  const parts = filePath.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] ?? '';
}
