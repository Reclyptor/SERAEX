import type {
  AnimeSearchResult,
  AnimeEpisode,
  MinimalAnimeEntry,
} from '../../../shared/types';

const ANILIST_API = 'https://graphql.anilist.co';

// ============================================
// Exported Activities (called individually by workflow for progress)
// ============================================

/**
 * Search AniList for an anime matching the given query.
 * The workflow calls this first, then updates progress with the result.
 */
export async function searchAnimeByName(
  query: string,
): Promise<AnimeSearchResult | null> {
  const cleaned = cleanFolderName(query);
  return searchAnime(cleaned);
}

/**
 * Starting from an AniList ID, walk the prequel/sequel chain to discover
 * all TV seasons in order. Returns minimal entries for each season.
 * The workflow calls this after searchAnimeByName to get the full season list.
 */
export async function discoverAllSeasons(
  initialAniListId: number,
): Promise<MinimalAnimeEntry[]> {
  const firstSeasonId = await walkToFirstSeason(initialAniListId);
  return collectAllSeasons(firstSeasonId);
}

/**
 * Fetch the episode list for a single season by AniList ID.
 * The workflow calls this once per season for granular progress updates.
 */
export async function fetchSeasonEpisodes(
  anilistId: number,
  expectedCount: number,
): Promise<AnimeEpisode[]> {
  return fetchEpisodes(anilistId, expectedCount);
}

// ============================================
// Internal Helpers
// ============================================

async function searchAnime(query: string): Promise<AnimeSearchResult | null> {
  const graphqlQuery = `
    query ($search: String) {
      Media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
        id
        title {
          romaji
          english
          native
        }
        episodes
        format
        status
        season
        seasonYear
      }
    }
  `;

  const response = await fetch(ANILIST_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: graphqlQuery,
      variables: { search: query },
    }),
  });

  if (!response.ok) {
    throw new Error(
      `AniList API error: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as {
    data?: { Media?: Record<string, unknown> };
    errors?: Array<{ message: string }>;
  };

  if (data.errors?.length) {
    if (data.errors.some((e) => e.message.includes('Not Found'))) {
      return null;
    }
    throw new Error(`AniList query error: ${data.errors[0].message}`);
  }

  const media = data.data?.Media;
  if (!media) return null;

  return {
    anilistId: media.id as number,
    title: media.title as AnimeSearchResult['title'],
    episodes: media.episodes as number | null,
    format: media.format as string,
    status: media.status as string,
    season: media.season as string | undefined,
    seasonYear: media.seasonYear as number | undefined,
  };
}

async function walkToFirstSeason(startId: number): Promise<number> {
  let currentId = startId;
  const visited = new Set<number>();

  while (!visited.has(currentId)) {
    visited.add(currentId);
    const relations = await fetchRelations(currentId);
    const prequel = relations.find(
      (r) => r.relationType === 'PREQUEL' && r.format === 'TV',
    );
    if (!prequel) break;
    currentId = prequel.anilistId;
  }

  return currentId;
}

async function collectAllSeasons(
  firstSeasonId: number,
): Promise<MinimalAnimeEntry[]> {
  const seasons: MinimalAnimeEntry[] = [];
  let currentId: number | null = firstSeasonId;
  const visited = new Set<number>();

  while (currentId !== null && !visited.has(currentId)) {
    visited.add(currentId);
    const entry = await fetchMinimalEntry(currentId);
    if (!entry) break;

    if (entry.format === 'TV') {
      seasons.push(entry);
    }

    const relations = await fetchRelations(currentId);
    const sequel = relations.find(
      (r) => r.relationType === 'SEQUEL' && r.format === 'TV',
    );
    currentId = sequel?.anilistId ?? null;
  }

  return seasons;
}

interface RelationEdge {
  relationType: string;
  anilistId: number;
  format: string;
}

async function fetchRelations(mediaId: number): Promise<RelationEdge[]> {
  const graphqlQuery = `
    query ($id: Int) {
      Media(id: $id) {
        relations {
          edges {
            relationType
            node {
              id
              format
            }
          }
        }
      }
    }
  `;

  const response = await fetch(ANILIST_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: graphqlQuery,
      variables: { id: mediaId },
    }),
  });

  if (!response.ok) return [];

  const data = (await response.json()) as {
    data?: {
      Media?: {
        relations?: {
          edges: Array<{
            relationType: string;
            node: { id: number; format: string };
          }>;
        };
      };
    };
  };

  const edges = data.data?.Media?.relations?.edges ?? [];
  return edges.map((edge) => ({
    relationType: edge.relationType,
    anilistId: edge.node.id,
    format: edge.node.format,
  }));
}

async function fetchMinimalEntry(
  mediaId: number,
): Promise<MinimalAnimeEntry | null> {
  const graphqlQuery = `
    query ($id: Int) {
      Media(id: $id) {
        id
        title {
          romaji
          english
        }
        episodes
        format
      }
    }
  `;

  const response = await fetch(ANILIST_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: graphqlQuery,
      variables: { id: mediaId },
    }),
  });

  if (!response.ok) return null;

  const data = (await response.json()) as {
    data?: {
      Media?: {
        id: number;
        title: { romaji: string; english: string | null };
        episodes: number | null;
        format: string;
      };
    };
  };

  const media = data.data?.Media;
  if (!media) return null;

  return {
    anilistId: media.id,
    title: { romaji: media.title.romaji, english: media.title.english },
    episodeCount: media.episodes ?? 0,
    format: media.format,
  };
}

async function fetchEpisodes(
  anilistId: number,
  expectedCount: number,
): Promise<AnimeEpisode[]> {
  const graphqlQuery = `
    query ($mediaId: Int) {
      Media(id: $mediaId) {
        episodes
        streamingEpisodes {
          title
          thumbnail
        }
        airingSchedule(notYetAired: false, perPage: 50) {
          nodes {
            episode
            airingAt
          }
        }
      }
    }
  `;

  const response = await fetch(ANILIST_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: graphqlQuery,
      variables: { mediaId: anilistId },
    }),
  });

  if (!response.ok) {
    throw new Error(
      `AniList API error: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as {
    data?: {
      Media?: {
        episodes: number | null;
        streamingEpisodes: Array<{ title: string; thumbnail: string }>;
        airingSchedule: {
          nodes: Array<{ episode: number; airingAt: number }>;
        };
      };
    };
  };

  const media = data.data?.Media;
  if (!media) return [];

  const episodes: AnimeEpisode[] = [];
  const episodeCount =
    expectedCount ||
    media.episodes ||
    media.airingSchedule.nodes.length ||
    0;

  if (media.streamingEpisodes.length > 0) {
    for (let i = 0; i < media.streamingEpisodes.length; i++) {
      const streamEp = media.streamingEpisodes[i];
      const title = parseStreamingEpisodeTitle(streamEp.title);
      episodes.push({
        number: title.number ?? i + 1,
        title: title.cleanTitle,
        description: null,
      });
    }
  } else {
    for (let i = 1; i <= episodeCount; i++) {
      episodes.push({
        number: i,
        title: null,
        description: null,
      });
    }
  }

  episodes.sort((a, b) => a.number - b.number);
  return episodes;
}

function parseStreamingEpisodeTitle(
  title: string,
): { number: number | null; cleanTitle: string } {
  const patterns = [
    /^(?:Episode|EP|Ep\.?)\s*(\d+)\s*[-:．.]\s*(.+)$/i,
    /^(\d+)\s*[-:．.]\s*(.+)$/,
    /^(?:Episode|EP|Ep\.?)\s*(\d+)$/i,
  ];

  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (match) {
      return {
        number: parseInt(match[1], 10),
        cleanTitle: match[2]?.trim() ?? title.trim(),
      };
    }
  }

  return { number: null, cleanTitle: title.trim() };
}

/**
 * Clean a folder name for anime search.
 */
export function cleanFolderName(name: string): string {
  let cleaned = name;

  cleaned = cleaned.replace(/\[[^\]]*\]/g, '');
  cleaned = cleaned.replace(/\([^)]*\)/g, '');
  cleaned = cleaned.replace(
    /\b(1080p|720p|480p|2160p|4K|x264|x265|HEVC|AVC|FLAC|AAC|BD|BluRay|BDRip|WEB-DL|WEBRip)\b/gi,
    '',
  );
  cleaned = cleaned.replace(/\bS(\d+)\b/gi, 'Season $1');
  cleaned = cleaned.replace(/[_.-]+/g, ' ');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned;
}
