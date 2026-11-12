import { Queue } from "@henrygd/queue";

export interface FailedDownload {
  fileName: string;
  bundle: string;
  error: string;
}

/**
 * Statistics and summary counts for a download run.
 */
export interface Totals {
  bundles: number;
  checksums: number;
  checksumsLoaded: number;
  hashErrors: number;
  movedFiles?: number;
  linkedFiles?: number;
  preFilteredDownloads: number;
  filteredDownloads: number;
  removedFiles: number;
  removedChecksums: number;
  downloads: number;
  doneDownloads: number;
  failedDownloads?: FailedDownload[];
}

/**
 * Configuration options controlling downloader behavior and CLI parameters.
 */
export interface Options extends Record<string, unknown> {
  _?: string[];
  dedup: boolean;
  bundleFolders: boolean;
  productFolders: boolean;
  humanFileNames: boolean;
  parallel: number;
  format: string[];
  audioFormat?: string[];
  platform: string[];
  videoQuality: string[];
  bundleKey?: string[];
  filter?: string;
  exclude?: string;
  since?: string;
  before?: string;
  maxSize?: string;
  minSize?: string;
  rateLimit?: string;
  outputTemplate?: string;
  preserveMtime?: boolean;
  linkDuplicates?: boolean;
  deep?: boolean;
  webhook?: string;
  opf?: boolean;
  covers?: boolean;
  torrent?: boolean;
  extract?: boolean;
  playlists?: boolean;
  json?: boolean;
  verbose?: boolean;
  logFile?: string;
  command?: string;
  authToken: string;
  downloadFolder: string;
  update?: boolean;
  dryRun?: boolean;
}

/**
 * Concurrency queues used for parallel file inspection, order querying, and downloading.
 */
export interface Queues {
  fileCheck: Queue;
  orderInfo: Queue;
  downloads: Queue;
}

/**
 * Metadata for a resolved downloadable item.
 */
export interface DownloadInfo {
  date: Date;
  bundle: string;
  gameKey: string;
  name: string;
  publisher?: string;
  icon?: string | null;
  productUrl?: string;
  fileName: string;
  downloadPath: string;
  filePath: string;
  url: URL;
  webFilename?: string;
  subProductId?: string;
  entitlementId?: string;
  downloadKey?: string;
  sha1?: string;
  md5?: string;
  machineName: string;
  structName: string;
  file_size?: number;
}
