import { Queue } from "@henrygd/queue";

export interface GameKey {
  gamekey: string;
}

export interface Checksums {
  sha1: string;
  md5: string;
}

export interface Bundle {
  amount_spent: number;
  product: Product;
  gamekey: string;
  uid: string;
  created: string;
  missed_credit: null;
  subproducts: SubProduct[];
  total_choices: number;
  choices_remaining: number;
  currency: Currency | null;
  is_giftee: boolean;
  claimed: boolean;
  total: number;
  path_ids: string[];
}

export enum Currency {
  Gbp = "GBP",
  Usd = "USD",
}

export interface Product {
  category: Category;
  machine_name: string;
  empty_tpkds: { [key: string]: string[] };
  post_purchase_text: string;
  human_name: string;
  partial_gift_enabled: boolean;
  choice_url?: string;
  is_subs_v2_product?: boolean;
  is_subs_v3_product?: boolean;
  subscription_credits?: number;
}

export enum Category {
  Bundle = "bundle",
  Storefront = "storefront",
  Subscriptioncontent = "subscriptioncontent",
  Subscriptionplan = "subscriptionplan",
  Widget = "widget",
}

export interface SubProduct {
  machine_name: string;
  url: string;
  downloads: Download[];
  library_family_name: null | string;
  payee: Payee;
  human_name: string;
  custom_download_page_box_css: null | string;
  custom_download_page_box_html: CustomDownloadPageBoxHTMLClass | null | string;
  icon: null | string;
  display_item?: DisplayItem;
}

// deno-lint-ignore no-empty-interface
export interface CustomDownloadPageBoxHTMLClass {}

export interface DisplayItem {
  publishers: Publisher[] | null;
  "description-text": null | string;
  developers: Developer[] | null;
  image: null | string;
  "carousel-content": CarouselContent | null;
}

export interface CarouselContent {
  "youtube-link"?: string[];
  thumbnail: string[];
  screenshot: string[];
  "asm-demo-machine-name"?: string[];
}

export interface Developer {
  "developer-name"?: string;
  "developer-url"?: string;
  "developer-logo"?: string;
}

export interface Publisher {
  "publisher-name": string;
  "publisher-url"?: string;
}

export interface Download {
  desktop_app_only: boolean;
  machine_name: string;
  download_struct: DownloadStruct[];
  options_dict: string[] | OptionsDictClass | null;
  download_identifier: null | string;
  platform: Platform;
  download_version_number: number | null;
}

export interface DownloadStruct {
  sha1?: string;
  name?: string;
  url?: URL;
  human_size: string;
  file_size?: number;
  small?: number | string;
  md5?: string;
  timestamp?: number;
  uploaded_at?: string;
  external_link?: string;
  build_version?: number | string;
  builds?: Build[];
  uses_kindle_sender?: boolean;
  kindle_friendly?: boolean;
  force_download?: boolean;
  arch?: string;
  hd_stream_url?: string;
  sd_stream_url?: string;
  asm_config?: ASMConfig;
  asm_manifest?: { [key: string]: string };
  timetstamp?: number;
}

export interface ASMConfig {
  display_item: string;
  warnCrash?: boolean;
  cloudMountPoint?: string;
  demoMode?: boolean;
  skipSetAspectRatio?: boolean;
  screenshotDisabled?: boolean;
}

export interface Build {
  signature_file: string;
  filename: string;
  download_file_size: number | string;
  build_version: number | string;
  installed_file_size: number | string;
  executable_path: string;
  dependencies?: string[];
}

export interface URL {
  web: string;
  bittorrent?: string;
}

export interface OptionsDictClass {
  is64bittoggle?: number;
  tablet?: boolean;
}

export enum Platform {
  Android = "android",
  Asmjs = "asmjs",
  Audio = "audio",
  Comedy = "comedy",
  Ebook = "ebook",
  Linux = "linux",
  MAC = "mac",
  Other = "other",
  Video = "video",
  Windows = "windows",
}

export interface Payee {
  human_name: string;
  machine_name: string;
}

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
  parallel: number;
  format: string[];
  platform: string[];
  command?: string;
  authToken: string;
  downloadFolder: string;
}

export type Queues = {
  fileCheck: Queue;
  orderInfo: Queue;
  downloads: Queue;
};
