import { Queue } from "@henrygd/queue";

export interface Totals {
  bundles: number;
  checksums: number;
  checksumsLoaded: number;
  preFilteredDownloads: number;
  filteredDownloads: number;
  removedFiles: number;
  removedChecksums: number;
  downloads: number;
  doneDownloads: number;
}

export interface Options extends Record<string, unknown> {
  _?: string[];
  dedup: boolean;
  bundleFolders: boolean;
  productFolders: boolean;
  humanFileNames: boolean;
  parallel: number;
  format: string[];
  platform: string[];
  command?: string;
  authToken: string;
  downloadFolder: string;
}

export interface Queues {
  fileCheck: Queue;
  orderInfo: Queue;
  downloads: Queue;
}

export interface DownloadInfo {
  date: Date;
  bundle: string;
  name: string;
  fileName: string;
  downloadPath: string;
  filePath: string;
  url: URL;
  sha1?: string;
  md5?: string;
  machineName: string;
  structName: string;
  file_size?: number;
}
