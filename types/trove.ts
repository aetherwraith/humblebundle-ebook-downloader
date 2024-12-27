export interface Trove {
  machine_name: string;
  "hero-marketing-blurb": null;
  "hero-background-image": null;
  image: string;
  "human-name": string;
  logo: null;
  "all-access": boolean;
  "trove-showcase-css": null;
  "youtube-link": null;
  "humble-original": boolean;
  developers: Developer[];
  "background-color": null;
  "marketing-blurb": string;
  publishers: Publisher[] | null;
  downloads: Downloads;
  "description-text": string;
  "date-added": number;
  "background-image": null;
  popularity: number;
  "hero-character-image": null;
  "hero-game-logo": null;
  "carousel-content": CarouselContent;
  "date-ended": number;
  trove_category: string;
  "is-client-hero": null;
}

export interface CarouselContent {
  thumbnail: string[];
  screenshot: string[];
  "youtube-link"?: string[];
}

export interface Developer {
  "developer-name": string;
  "developer-url": string;
}

export interface Downloads {
  windows: Download;
  mac?: Download;
  linux?: Download;
}

export interface Download {
  uploaded_at: number;
  name: string;
  url: URL;
  timestamp: number;
  machine_name: string;
  file_size: number;
  small: number;
  size: string;
  md5: string;
  builds?: Build[];
  build_version?: number;
  sha1?: string;
}

export interface Build {
  signature_file: string;
  filename: string;
  dependencies?: string[];
  download_file_size: number;
  build_version: number;
  installed_file_size: number;
  executable_path: string;
}

export interface URL {
  web: string;
  bittorrent: string;
}

export interface Publisher {
  "publisher-name": string;
  "publisher-url"?: string;
}

export enum TrovePlatform {
  Linux = "linux",
  MAC = "mac",
  Windows = "windows",
}
