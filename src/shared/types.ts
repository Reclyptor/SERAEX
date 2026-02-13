/**
 * Shared types for seraex workflows and activities.
 */

// ============================================
// Workflow Inputs / Outputs
// ============================================

export interface OrganizeLibraryInput {
  /** Absolute path to the selected series root in input mount */
  sourceDir: string;
  /** If true, log intended actions without making changes */
  dryRun?: boolean;
  /** Confidence threshold for auto-rename (default: 0.85) */
  confidenceThreshold?: number;
  /** Root directory for processing work (default: /mnt/media/processing) */
  processingRoot?: string;
  /** Root directory for staging (default: /mnt/media/staging) */
  stagingRoot?: string;
  /** Root directory for final output (default: /mnt/media/output) */
  outputRoot?: string;
}

export interface OrganizeLibraryResult {
  /** Total folders processed */
  totalFolders: number;
  /** Successfully completed folders */
  completed: number;
  /** Folders that encountered errors */
  failed: number;
  /** Folders with items pending human review */
  pendingReview: number;
  /** Per-folder results */
  folders: FolderResult[];
  /** Files moved to Extras directory */
  extraFiles: string[];
}

export type FolderStatus =
  | 'pending'
  | 'scanning'
  | 'extracting'
  | 'matching'
  | 'renaming'
  | 'awaiting_detection_review'
  | 'awaiting_review'
  | 'completed'
  | 'failed';

export interface FolderResult {
  folderName: string;
  folderPath: string;
  status: FolderStatus;
  episodesFound: number;
  episodesRenamed: number;
  episodesPendingReview: number;
  error?: string;
}

export interface ProcessFolderInput {
  /** Absolute path to the anime folder (a disc directory in processing) */
  folderPath: string;
  /** Name of the folder (disc directory name, for display) */
  folderName: string;
  /** Absolute path to the series root in processing (parent of disc dirs) */
  seriesRootDir: string;
  /** Full series metadata with all seasons and episodes */
  seriesMetadata: SeriesMetadata;
  /** If true, log intended actions without making changes */
  dryRun?: boolean;
  /** Confidence threshold for auto-rename */
  confidenceThreshold: number;
}

export interface ProcessFolderResult {
  folderName: string;
  status: FolderStatus;
  episodesFound: number;
  episodesRenamed: number;
  episodesPendingReview: number;
  renamedFiles: RenamedFile[];
  /** Original absolute paths of files that were identified as episodes */
  episodeOriginalPaths: string[];
  /** Video files that were not matched to any episode */
  unprocessedFiles: string[];
  error?: string;
}

// ============================================
// Activity Types
// ============================================

/** Information about a file discovered during enumeration */
export interface SourceFileInfo {
  /** Absolute path */
  path: string;
  /** Path relative to the enumeration root */
  relativePath: string;
  /** File name (basename) */
  name: string;
  /** File size in bytes */
  size: number;
}

/** Result of file-size-clustering episode detection */
export interface EpisodeDetectionResult {
  /** Files identified as likely episodes */
  episodes: SourceFileInfo[];
  /** Files identified as non-episodes (extras, bonus content, etc.) */
  nonEpisodes: SourceFileInfo[];
  /** How confident the detection is */
  confidence: 'high' | 'medium' | 'low';
  /** Median file size of the episode cluster in bytes */
  clusterMedianSize: number;
  /** [min, max] file size range of the episode cluster in bytes */
  clusterSizeRange: [number, number];
}

export interface SubtitleTrack {
  /** Index of the subtitle track */
  index: number;
  /** Language code (e.g., 'eng', 'jpn') */
  language?: string;
  /** Track title if available */
  title?: string;
  /** Subtitle format (e.g., 'ass', 'srt', 'subrip') */
  format: string;
}

export interface ExtractedSubtitles {
  /** The media file this belongs to */
  filePath: string;
  fileName: string;
  /** Extracted subtitle text content */
  content: string;
  /** Source: 'embedded' or 'external' */
  source: 'embedded' | 'external';
  /** Language if known */
  language?: string;
}

export interface AnimeSearchResult {
  /** AniList ID */
  anilistId: number;
  /** Title in various formats */
  title: {
    romaji: string;
    english: string | null;
    native: string | null;
  };
  /** Number of episodes */
  episodes: number | null;
  /** Anime format (TV, OVA, etc.) */
  format: string;
  /** Airing status */
  status: string;
  /** Season number if applicable */
  season?: string;
  /** Year of first airing */
  seasonYear?: number;
}

export interface AnimeEpisode {
  /** Episode number */
  number: number;
  /** Episode title */
  title: string | null;
  /** Episode synopsis/description */
  description: string | null;
}

export interface AnimeMetadata {
  /** The matched anime */
  anime: AnimeSearchResult;
  /** Episode list */
  episodes: AnimeEpisode[];
}

export interface SeasonInfo {
  /** Our 1-indexed season number */
  seasonNumber: number;
  /** AniList media ID for this season */
  anilistId: number;
  /** Titles for this season entry */
  title: { romaji: string; english: string | null };
  /** Number of episodes in this season */
  episodeCount: number;
  /** Per-season episode list (numbers are 1-indexed within the season) */
  episodes: AnimeEpisode[];
}

/** Minimal season entry returned by the discoverAllSeasons activity */
export interface MinimalAnimeEntry {
  anilistId: number;
  title: { romaji: string; english: string | null };
  episodeCount: number;
  format: string;
}

export interface SeriesMetadata {
  /** Canonical series name (from the first season's English or romaji title) */
  seriesName: string;
  /** Ordered list of seasons discovered via AniList relation traversal */
  seasons: SeasonInfo[];
  /** Sum of all season episode counts */
  totalCoreEpisodes: number;
}

export interface EpisodeMatch {
  /** Original file name */
  fileName: string;
  /** Original file path */
  filePath: string;
  /** Matched season number (1-indexed) */
  seasonNumber: number;
  /** Matched episode number (1-indexed within the season) */
  episodeNumber: number;
  /** Matched episode title */
  episodeTitle: string;
  /** Confidence score 0-1 */
  confidence: number;
  /** LLM reasoning for the match */
  reasoning: string;
}

export interface MatchResult {
  matches: EpisodeMatch[];
}

export interface RenamedFile {
  /** Original file path */
  originalPath: string;
  /** Original path relative to the series root (for extras hierarchy) */
  originalRelativePath: string;
  /** New file path (in _episodes/ working dir) */
  newPath: string;
  /** New file name (Plex format) */
  newFileName: string;
  /** Season number */
  seasonNumber: number;
  /** Episode number */
  episodeNumber: number;
}

// ============================================
// Signal Payloads (HITL)
// ============================================

export interface ReviewItem {
  /** Unique ID for this review item */
  id: string;
  /** Original file name */
  fileName: string;
  /** Original file path */
  filePath: string;
  /** Subtitle snippet for context */
  subtitleSnippet: string;
  /** LLM's suggested season number */
  suggestedSeasonNumber: number;
  /** LLM's suggested episode number */
  suggestedEpisodeNumber: number;
  /** LLM's suggested episode title */
  suggestedEpisodeTitle: string;
  /** LLM's confidence score */
  confidence: number;
  /** LLM's reasoning */
  reasoning: string;
  /** Available episodes for manual selection (all seasons) */
  availableEpisodes: AnimeEpisode[];
  /** Season info for manual selection */
  availableSeasons: SeasonInfo[];
}

export interface ReviewDecision {
  /** The review item ID */
  reviewItemId: string;
  /** Whether the user approved the suggestion */
  approved: boolean;
  /** If not approved, the user's corrected season number */
  correctedSeasonNumber?: number;
  /** If not approved, the user's corrected episode number */
  correctedEpisodeNumber?: number;
}

/**
 * Signal for user to confirm or correct the detected episode list.
 * Sent when detection confidence is low or medium.
 */
export interface DetectionConfirmation {
  /** Whether the user accepts the detected episode list */
  confirmed: boolean;
  /** File paths the user wants to add to the episode list */
  addedPaths?: string[];
  /** File paths the user wants to remove from the episode list */
  removedPaths?: string[];
}

/**
 * Finalize signal payload.
 * Sent by the user to approve or reject the staged output.
 */
export interface FinalizeDecision {
  /** Whether to proceed with publishing to output */
  approved: boolean;
}

// ============================================
// Progress / Query Types
// ============================================

export type WorkflowStage =
  | 'copying'
  | 'fetching_metadata'
  | 'processing_folders'
  | 'structuring'
  | 'awaiting_finalize'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'canceled';

/** Progress for the file copy stage (copying to processing or staging) */
export interface CopyProgress {
  totalFiles: number;
  filesCopied: number;
  totalBytes: number;
  bytesCopied: number;
  /** Files currently being copied (up to 4 in parallel) */
  currentFiles: string[];
  /** Sizes of files currently being copied */
  currentFileSizes: number[];
}

/** Progress for the metadata fetching stage */
export interface MetadataSummary {
  status: 'searching' | 'found' | 'traversing' | 'fetching_episodes' | 'complete';
  seriesName?: string;
  seasonCount?: number;
  seasons?: Array<{ seasonNumber: number; title: string; episodeCount: number }>;
  totalEpisodes?: number;
}

/** Progress for the structuring stage (building Plex layout + copying to staging) */
export interface StructuringProgress {
  totalFiles: number;
  filesStructured: number;
  currentFile?: string;
}

/** Progress for the output copy stage (staging to output) */
export interface OutputProgress {
  totalFiles: number;
  filesCopied: number;
  /** Files currently being copied (up to 4 in parallel) */
  currentFiles: string[];
}

export interface OrganizeLibraryProgress {
  workflowStage: WorkflowStage;

  // ── Stage-specific sub-objects (populated when relevant) ──

  /** Stage 1: copying files to processing */
  copyProgress?: CopyProgress;
  /** Stage 2: fetching metadata from AniList */
  metadataSummary?: MetadataSummary;
  /** Stage 4: structuring in processing + copying to staging */
  structuringProgress?: StructuringProgress;
  /** Stage 6: copying from staging to output */
  outputProgress?: OutputProgress;

  // ── Folder processing (stage 3) ──

  totalFolders: number;
  foldersCompleted: number;
  foldersFailed: number;
  foldersInProgress: number;
  foldersPendingReview: number;
  folderStatuses: Record<string, FolderStatus>;
  expectedCoreEpisodeCount: number;
  resolvedCoreEpisodeCount: number;
  unresolvedCoreEpisodeCount: number;

  // ── Approval ──

  canFinalize: boolean;
  awaitingFinalApproval: boolean;
}

export interface ProcessFolderProgress {
  folderName: string;
  status: FolderStatus;

  // ── Episode detection ──
  totalVideoFiles?: number;
  detectedEpisodeCount?: number;
  detectionConfidence?: 'high' | 'medium' | 'low';

  // ── Subtitle extraction ──
  totalEpisodeFiles?: number;
  subtitlesExtracted?: number;
  currentFile?: string;

  // ── LLM matching ──
  matchesFound?: number;
  totalToMatch?: number;

  // ── Copy-rename ──
  episodesCopied?: number;
  totalEpisodesToCopy?: number;

  // ── HIL reviews ──
  pendingReviews: ReviewItem[];
}

// ============================================
// File Tree (for staging review)
// ============================================

export interface FileTreeNode {
  /** File or directory name */
  name: string;
  /** Node type */
  type: 'file' | 'directory';
  /** Relative path from the staging show root */
  relativePath: string;
  /** File size in bytes (only for files) */
  size?: number;
  /** Child nodes (only for directories) */
  children?: FileTreeNode[];
}
