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
  /** Minimum episode duration in minutes (default: 20) */
  minDurationMinutes?: number;
  /** Confidence threshold for auto-rename (default: 0.85) */
  confidenceThreshold?: number;
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
  | 'awaiting_review'
  | 'moving'
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
  /** Full series metadata with all seasons and episodes */
  seriesMetadata: SeriesMetadata;
  /** If true, log intended actions without making changes */
  dryRun?: boolean;
  /** Minimum episode duration in minutes */
  minDurationMinutes: number;
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
  /** Video files that were not matched to any episode */
  unprocessedFiles: string[];
  error?: string;
}

// ============================================
// Activity Types
// ============================================

export interface MediaFile {
  /** Absolute path to the file */
  path: string;
  /** File name (without directory) */
  fileName: string;
  /** File extension (e.g., '.mkv') */
  extension: string;
  /** Duration in seconds */
  durationSeconds: number;
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
  /** New file path */
  newPath: string;
  /** New file name */
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
 * Finalize signal payload.
 * Sent by the user after all reviews are resolved to approve the final output.
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
  | 'detecting'
  | 'extracting'
  | 'matching'
  | 'awaiting_review'
  | 'renaming'
  | 'structuring'
  | 'awaiting_finalize'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'canceled';

export interface OrganizeLibraryProgress {
  totalFolders: number;
  foldersCompleted: number;
  foldersFailed: number;
  foldersInProgress: number;
  foldersPendingReview: number;
  folderStatuses: Record<string, FolderStatus>;
  workflowStage: WorkflowStage;
  expectedCoreEpisodeCount: number;
  resolvedCoreEpisodeCount: number;
  unresolvedCoreEpisodeCount: number;
  canFinalize: boolean;
  awaitingFinalApproval: boolean;
}

export interface ProcessFolderProgress {
  folderName: string;
  status: FolderStatus;
  totalFiles: number;
  filesProcessed: number;
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
