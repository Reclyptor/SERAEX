import { readdir, stat } from 'fs/promises';
import { join } from 'path';

/**
 * List top-level series directories under MEDIA_INPUT_ROOT.
 * Called via the listSeriesRootsWorkflow so SERA doesn't need NFS access.
 */
export async function listSeriesRoots(): Promise<
  Array<{ name: string; path: string }>
> {
  const inputRoot = process.env.MEDIA_INPUT_ROOT ?? '/mnt/media/input';
  const entries = await readdir(inputRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: join(inputRoot, entry.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * List all subdirectories in the given source directory.
 * Returns an array of { name, path } for each subdirectory.
 */
export async function scanDirectory(
  sourceDir: string,
): Promise<Array<{ name: string; path: string }>> {
  const entries = await readdir(sourceDir, { withFileTypes: true });

  const directories: Array<{ name: string; path: string }> = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const fullPath = join(sourceDir, entry.name);
      directories.push({ name: entry.name, path: fullPath });
    }
  }

  // Sort alphabetically for deterministic ordering
  directories.sort((a, b) => a.name.localeCompare(b.name));

  return directories;
}

/**
 * List all files in a directory (non-recursive).
 * Returns absolute paths.
 */
export async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(directory, entry.name));
}

/**
 * List all files in a directory recursively.
 * Returns absolute paths.
 */
export async function listFilesRecursive(
  directory: string,
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      const subFiles = await listFilesRecursive(fullPath);
      files.push(...subFiles);
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}
