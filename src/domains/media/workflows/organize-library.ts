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
  CopyProgress,
  MetadataSummary,
  StructuringProgress,
  OutputProgress,
  ProcessFolderInput,
  ProcessFolderResult,
  FolderStatus,
  FolderResult,
  FinalizeDecision,
  WorkflowStage,
  SeasonInfo,
  SeriesMetadata,
  FileTreeNode,
  SourceFileInfo,
} from '../../../shared/types';
import { processFolder } from './process-folder';

// ── Activity proxies ─────────────────────────────────────────────────

const { scanDirectory } = proxyActivities<Activities>({
  startToCloseTimeout: '2 minutes',
});

const { searchAnimeByName, discoverAllSeasons, fetchSeasonEpisodes } =
  proxyActivities<Activities>({
    startToCloseTimeout: '5 minutes',
    retry: { maximumAttempts: 3 },
  });

const { enumerateSourceFiles, copySingleFile } = proxyActivities<Activities>({
  startToCloseTimeout: '30 minutes',
  heartbeatTimeout: '2 minutes',
  retry: { maximumAttempts: 2 },
});

const {
  structureInProcessing,
  copySingleFileToOutput,
  verifyOutputIntegrity,
  cleanupDirectory,
  listStagingTree,
} = proxyActivities<Activities>({
  startToCloseTimeout: '30 minutes',
  heartbeatTimeout: '2 minutes',
  retry: { maximumAttempts: 2 },
});

// ── Signals & Queries ────────────────────────────────────────────────

export const getProgressQuery =
  defineQuery<OrganizeLibraryProgress>('getProgress');
export const getStagingTreeQuery =
  defineQuery<FileTreeNode[]>('getStagingTree');
export const finalizeSignal = defineSignal<[FinalizeDecision]>('finalize');

/** Maximum parallel file copies */
const MAX_PARALLEL_COPIES = 4;
/** Maximum parallel folder processing */
const MAX_PARALLEL_FOLDERS = 5;

// ── Workflow ─────────────────────────────────────────────────────────

export async function organizeLibrary(
  input: OrganizeLibraryInput,
): Promise<OrganizeLibraryResult> {
  const confidenceThreshold = input.confidenceThreshold ?? 0.85;

  // ── Mutable state ──
  let workflowStage: WorkflowStage = 'copying';
  let expectedCoreEpisodeCount = 0;
  let resolvedCoreEpisodeCount = 0;
  let unresolvedCoreEpisodeCount = 0;
  let canFinalize = false;
  let awaitingFinalApproval = false;
  let finalized = false;
  let rejected = false;
  let stagingTree: FileTreeNode[] = [];

  // Stage-specific progress
  let copyProgress: CopyProgress | undefined;
  let metadataSummary: MetadataSummary | undefined;
  let structuringProgress: StructuringProgress | undefined;
  let outputProgress: OutputProgress | undefined;

  const folderStatuses: Record<string, FolderStatus> = {};
  const folderResults: FolderResult[] = [];
  const allRenamedFilePaths: string[] = [];
  const allEpisodeOriginalPaths: string[] = [];
  const allExtraFiles: string[] = [];

  // ── Finalize signal handler ──
  setHandler(finalizeSignal, (decision: FinalizeDecision) => {
    if (decision.approved && canFinalize) {
      finalized = true;
    } else if (!decision.approved) {
      rejected = true;
    }
  });

  // ── Progress query handler ──
  setHandler(getProgressQuery, (): OrganizeLibraryProgress => {
    const statuses = Object.values(folderStatuses);
    return {
      workflowStage,
      copyProgress,
      metadataSummary,
      structuringProgress,
      outputProgress,
      totalFolders: Object.keys(folderStatuses).length,
      foldersCompleted: statuses.filter((s) => s === 'completed').length,
      foldersFailed: statuses.filter((s) => s === 'failed').length,
      foldersInProgress: statuses.filter(
        (s) =>
          s !== 'completed' &&
          s !== 'failed' &&
          s !== 'pending' &&
          s !== 'awaiting_review' &&
          s !== 'awaiting_detection_review',
      ).length,
      foldersPendingReview: statuses.filter(
        (s) => s === 'awaiting_review' || s === 'awaiting_detection_review',
      ).length,
      folderStatuses: { ...folderStatuses },
      expectedCoreEpisodeCount,
      resolvedCoreEpisodeCount,
      unresolvedCoreEpisodeCount,
      canFinalize,
      awaitingFinalApproval,
    };
  });

  // ── Staging tree query handler ──
  setHandler(getStagingTreeQuery, (): FileTreeNode[] => stagingTree);

  const wfId = workflowInfo().workflowId;
  const processingRoot = input.processingRoot ?? '/mnt/media/processing';
  const stagingRoot = input.stagingRoot ?? '/mnt/media/staging';
  const outputRoot = input.outputRoot ?? '/mnt/media/output';

  // ════════════════════════════════════════════════════════════════════
  // Stage 1: COPYING — enumerate + parallel copy to processing
  // ════════════════════════════════════════════════════════════════════

  workflowStage = 'copying';
  const sourceFiles = await enumerateSourceFiles(input.sourceDir);

  const seriesName = resolveShowName(input.sourceDir);
  const processingSeriesDir = `${processingRoot}/${wfId}/${seriesName}`;
  const processingWorkflowDir = `${processingRoot}/${wfId}`;

  copyProgress = {
    totalFiles: sourceFiles.length,
    filesCopied: 0,
    totalBytes: sourceFiles.reduce((sum, f) => sum + f.size, 0),
    bytesCopied: 0,
    currentFiles: [],
    currentFileSizes: [],
  };

  // Parallel sliding window copy
  await parallelCopyFiles(
    sourceFiles,
    input.sourceDir,
    processingSeriesDir,
    copyProgress,
    input.dryRun,
  );

  // ════════════════════════════════════════════════════════════════════
  // Stage 2: FETCHING METADATA — AniList search, season traversal
  // ════════════════════════════════════════════════════════════════════

  workflowStage = 'fetching_metadata';
  metadataSummary = { status: 'searching' };

  const anime = await searchAnimeByName(seriesName);
  if (!anime) {
    workflowStage = 'failed';
    return emptyResult();
  }

  metadataSummary = {
    status: 'found',
    seriesName: anime.title.english ?? anime.title.romaji,
  };

  // Discover all seasons
  metadataSummary = { ...metadataSummary, status: 'traversing' };
  const seasonEntries = await discoverAllSeasons(anime.anilistId);

  if (seasonEntries.length === 0) {
    workflowStage = 'failed';
    return emptyResult();
  }

  metadataSummary = {
    ...metadataSummary,
    status: 'fetching_episodes',
    seasonCount: seasonEntries.length,
    seasons: [],
  };

  // Fetch episodes for each season
  const seasons: SeasonInfo[] = [];
  for (let i = 0; i < seasonEntries.length; i++) {
    const entry = seasonEntries[i];
    const episodes = await fetchSeasonEpisodes(
      entry.anilistId,
      entry.episodeCount,
    );
    const seasonInfo: SeasonInfo = {
      seasonNumber: i + 1,
      anilistId: entry.anilistId,
      title: entry.title,
      episodeCount: entry.episodeCount,
      episodes,
    };
    seasons.push(seasonInfo);

    metadataSummary = {
      ...metadataSummary,
      seasons: [
        ...(metadataSummary.seasons ?? []),
        {
          seasonNumber: i + 1,
          title: entry.title.english ?? entry.title.romaji,
          episodeCount: entry.episodeCount,
        },
      ],
    };
  }

  const seriesMetadata: SeriesMetadata = {
    seriesName: anime.title.english ?? anime.title.romaji ?? seriesName,
    seasons,
    totalCoreEpisodes: seasons.reduce((sum, s) => sum + s.episodeCount, 0),
  };

  expectedCoreEpisodeCount = seriesMetadata.totalCoreEpisodes;
  metadataSummary = {
    ...metadataSummary,
    status: 'complete',
    totalEpisodes: expectedCoreEpisodeCount,
  };

  // ════════════════════════════════════════════════════════════════════
  // Stage 3: PROCESSING FOLDERS — scan, detect, extract, match, rename
  // ════════════════════════════════════════════════════════════════════

  workflowStage = 'processing_folders';

  // Scan disc structure
  const subdirs = await scanDirectory(processingSeriesDir);

  let foldersToProcess: Array<{ name: string; path: string }>;
  if (subdirs.length === 0) {
    foldersToProcess = [{ name: seriesName, path: processingSeriesDir }];
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

  // Process folders in parallel (sliding window of MAX_PARALLEL_FOLDERS)
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
        seriesRootDir: processingSeriesDir,
        seriesMetadata,
        dryRun: input.dryRun,
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

      resolvedCoreEpisodeCount += result.episodesRenamed;

      for (const rf of result.renamedFiles) {
        allRenamedFilePaths.push(rf.newPath);
      }
      for (const origPath of result.episodeOriginalPaths) {
        allEpisodeOriginalPaths.push(origPath);
      }

      inFlightPromises.delete(name);
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // Stage 4: STRUCTURING — build Plex layout in processing, copy to staging
  // ════════════════════════════════════════════════════════════════════

  workflowStage = 'structuring';
  const showName = seriesMetadata.seriesName;

  // Build _structured/ in processing
  const { structuredDir, extraFiles, totalFiles } =
    await structureInProcessing(
      processingSeriesDir,
      showName,
      allEpisodeOriginalPaths,
      input.dryRun,
    );
  allExtraFiles.push(...extraFiles);

  // Copy _structured/ShowName/ to staging
  const cleanShowName = showName
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const stagingShowDir = `${stagingRoot}/${wfId}/${cleanShowName}`;
  const stagingWorkflowDir = `${stagingRoot}/${wfId}`;

  const structuredFiles = await enumerateSourceFiles(structuredDir);
  structuringProgress = {
    totalFiles: structuredFiles.length,
    filesStructured: 0,
  };

  // Parallel copy to staging
  await parallelCopyFiles(
    structuredFiles,
    structuredDir,
    stagingShowDir,
    structuringProgress as unknown as CopyProgress,
    input.dryRun,
  );

  // Capture staging tree
  if (!input.dryRun) {
    stagingTree = await listStagingTree(stagingShowDir);
  }

  // ════════════════════════════════════════════════════════════════════
  // Stage 5: AWAITING FINALIZE — user reviews and approves/rejects
  // ════════════════════════════════════════════════════════════════════

  const totalCompleted = folderResults.filter(
    (r) => r.status === 'completed',
  ).length;
  const totalFailed = folderResults.filter(
    (r) => r.status === 'failed',
  ).length;
  unresolvedCoreEpisodeCount = 0;
  resolvedCoreEpisodeCount = allRenamedFilePaths.length;

  canFinalize = totalFailed === 0 && allRenamedFilePaths.length > 0;
  awaitingFinalApproval = canFinalize;
  workflowStage = 'awaiting_finalize';

  if (canFinalize) {
    await condition(() => finalized || rejected);
  }

  // Handle rejection
  if (rejected) {
    workflowStage = 'failed';
    return {
      totalFolders: folderResults.length,
      completed: totalCompleted,
      failed: totalFailed,
      pendingReview: 0,
      folders: folderResults,
      extraFiles: allExtraFiles,
    };
  }

  // ════════════════════════════════════════════════════════════════════
  // Stage 6: FINALIZING — parallel copy to output, verify, cleanup
  // ════════════════════════════════════════════════════════════════════

  workflowStage = 'finalizing';
  const outputDir = `${outputRoot}/${cleanShowName}`;

  const stagingFiles = await enumerateSourceFiles(stagingShowDir);
  outputProgress = {
    totalFiles: stagingFiles.length,
    filesCopied: 0,
    currentFiles: [],
  };

  // Parallel copy staging → output
  if (!input.dryRun) {
    const outputPending = [...stagingFiles];
    const outputInFlight = new Map<string, Promise<void>>();
    const outputCompleted = new Set<string>();

    while (outputPending.length > 0 || outputInFlight.size > 0) {
      while (
        outputPending.length > 0 &&
        outputInFlight.size < MAX_PARALLEL_COPIES
      ) {
        const file = outputPending.shift()!;
        const fileName = file.name;
        outputProgress = {
          ...outputProgress!,
          currentFiles: [
            ...outputProgress!.currentFiles.filter((f) =>
              outputInFlight.has(f),
            ),
            fileName,
          ],
        };

        const promise = copySingleFileToOutput(
          file.path,
          stagingShowDir,
          outputDir,
        ).then(() => {
          outputProgress = {
            ...outputProgress!,
            filesCopied: outputProgress!.filesCopied + 1,
            currentFiles: outputProgress!.currentFiles.filter(
              (f) => f !== fileName,
            ),
          };
          outputCompleted.add(fileName);
        });

        outputInFlight.set(fileName, promise);
      }

      if (outputInFlight.size > 0) {
        await Promise.race(Array.from(outputInFlight.values()));
        // Remove completed entries
        for (const name of outputCompleted) {
          outputInFlight.delete(name);
        }
        outputCompleted.clear();
      }
    }
  }

  // Verify output integrity
  if (!input.dryRun) {
    const { verified, missingFiles } = await verifyOutputIntegrity(
      stagingShowDir,
      outputDir,
    );

    if (!verified) {
      workflowStage = 'failed';
      return {
        totalFolders: folderResults.length,
        completed: totalCompleted,
        failed: totalFailed,
        pendingReview: 0,
        folders: folderResults,
        extraFiles: allExtraFiles,
      };
    }
  }

  // Cleanup staging and processing
  await cleanupDirectory(stagingWorkflowDir, input.dryRun);
  await cleanupDirectory(processingWorkflowDir, input.dryRun);

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

// ── Parallel Copy Helper ─────────────────────────────────────────────

/**
 * Copy files in parallel using a sliding window of MAX_PARALLEL_COPIES.
 * Updates the provided progress object between each completion.
 */
async function parallelCopyFiles(
  files: SourceFileInfo[],
  sourceRoot: string,
  destRoot: string,
  progress: CopyProgress | StructuringProgress,
  dryRun?: boolean,
): Promise<void> {
  if (dryRun) return;

  const pending = [...files];
  const inFlight = new Map<string, Promise<void>>();
  const completed = new Set<string>();
  const isCopyProgress = 'bytesCopied' in progress;

  while (pending.length > 0 || inFlight.size > 0) {
    while (pending.length > 0 && inFlight.size < MAX_PARALLEL_COPIES) {
      const file = pending.shift()!;
      const destPath = `${destRoot}/${file.relativePath}`;

      if (isCopyProgress) {
        const cp = progress as CopyProgress;
        cp.currentFiles = [...cp.currentFiles, file.name];
        cp.currentFileSizes = [...cp.currentFileSizes, file.size];
      } else {
        (progress as StructuringProgress).currentFile = file.name;
      }

      const fileName = file.name;
      const fileSize = file.size;
      const promise = copySingleFile(file.path, destPath).then(() => {
        if (isCopyProgress) {
          const cp = progress as CopyProgress;
          cp.filesCopied++;
          cp.bytesCopied += fileSize;
          cp.currentFiles = cp.currentFiles.filter((f) => f !== fileName);
          cp.currentFileSizes = cp.currentFileSizes.filter(
            (_, i) => cp.currentFiles[i] !== undefined,
          );
        } else {
          (progress as StructuringProgress).filesStructured++;
        }
        completed.add(fileName);
      });

      inFlight.set(fileName, promise);
    }

    if (inFlight.size > 0) {
      await Promise.race(Array.from(inFlight.values()));
      // Remove completed entries from the in-flight map
      for (const name of completed) {
        inFlight.delete(name);
      }
      completed.clear();
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function emptyResult(): OrganizeLibraryResult {
  return {
    totalFolders: 0,
    completed: 0,
    failed: 0,
    pendingReview: 0,
    folders: [],
    extraFiles: [],
  };
}

function resolveShowName(sourceDir: string): string {
  return basename(sourceDir);
}

function sanitizeWorkflowId(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 200);
}

function basename(filePath: string): string {
  const parts = filePath.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] ?? '';
}
