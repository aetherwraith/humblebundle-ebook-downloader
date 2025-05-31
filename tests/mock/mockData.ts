import { Bundle, Currency, Category, Platform } from "../../types/bundle.ts";
import { Trove } from "../../types/trove.ts";
import { Options, Totals, DownloadInfo } from "../../types/general.ts";

export const mockBundle: Bundle = {
  amount_spent: 15.99,
  product: {
    category: Category.Bundle,
    machine_name: "humble_test_bundle",
    empty_tpkds: {},
    post_purchase_text: "Thank you for your purchase",
    human_name: "Humble Test Bundle",
    partial_gift_enabled: false,
  },
  gamekey: "test123456789",
  uid: "user123456",
  created: "2023-01-01T12:00:00Z",
  missed_credit: null,
  subproducts: [
    {
      machine_name: "test_game",
      url: "https://www.humblebundle.com/downloads?key=test123456789",
      downloads: [
        {
          platform: Platform.Windows,
          download_struct: [
            {
              name: "Test Game Windows",
              url: { web: "https://example.com/test_game_windows.exe" },
              human_size: "500 MB",
              file_size: 524288000,
              md5: "abcdef1234567890",
              sha1: "1234567890abcdef",
            },
          ],
          options_dict: [],
          download_identifier: "test_game_windows",
          download_version_number: 1,
          machine_name: "windows",
          desktop_app_only: false,
        },
        {
          platform: Platform.Linux,
          download_struct: [
            {
              name: "Test Game Linux",
              url: { web: "https://example.com/test_game_linux.tar.gz" },
              human_size: "500 MB",
              file_size: 524288000,
              md5: "abcdef1234567891",
              sha1: "1234567890abcdef1",
            },
          ],
          options_dict: [],
          download_identifier: "test_game_linux",
          download_version_number: 1,
          machine_name: "linux",
          desktop_app_only: false,
        },
      ],
      human_name: "Test Game",
      custom_download_page_box_css: null,
      custom_download_page_box_html: null,
      icon: null,
      payee: {
        machine_name: "test_developer",
        human_name: "Test Developer",
      },
      library_family_name: null,
    },
    {
      machine_name: "test_ebook",
      url: "https://www.humblebundle.com/downloads?key=test123456789",
      downloads: [
        {
          platform: Platform.Ebook,
          download_struct: [
            {
              name: "Test Ebook PDF",
              url: { web: "https://example.com/test_ebook.pdf" },
              human_size: "5 MB",
              file_size: 5242880,
              md5: "abcdef1234567892",
              sha1: "1234567890abcdef2",
            },
          ],
          options_dict: [],
          download_identifier: "test_ebook_pdf",
          download_version_number: 1,
          machine_name: "pdf",
          desktop_app_only: false,
        },
        {
          platform: Platform.Ebook,
          download_struct: [
            {
              name: "Test Ebook EPUB",
              url: { web: "https://example.com/test_ebook.epub" },
              human_size: "3 MB",
              file_size: 3145728,
              md5: "abcdef1234567893",
              sha1: "1234567890abcdef3",
            },
          ],
          options_dict: [],
          download_identifier: "test_ebook_epub",
          download_version_number: 1,
          machine_name: "epub",
          desktop_app_only: false,
        },
      ],
      human_name: "Test Ebook",
      custom_download_page_box_css: null,
      custom_download_page_box_html: null,
      icon: null,
      payee: {
        machine_name: "test_publisher",
        human_name: "Test Publisher",
      },
      library_family_name: null,
    },
  ],
  total_choices: 0,
  choices_remaining: 0,
  currency: Currency.Usd,
  is_giftee: false,
  claimed: true,
  total: 15.99,
  path_ids: ["path1", "path2"],
};

export const mockTrove: Trove = {
  machine_name: "test_trove",
  "hero-marketing-blurb": null,
  "hero-background-image": null,
  image: "https://example.com/trove.jpg",
  "human-name": "Test Trove Game",
  logo: null,
  "all-access": true,
  "trove-showcase-css": null,
  "youtube-link": null,
  "humble-original": true,
  developers: [
    {
      "developer-name": "Test Developer",
      "developer-url": "https://developer.example.com",
    },
  ],
  "background-color": null,
  "marketing-blurb": "A great game for testing",
  publishers: [
    {
      "publisher-name": "Test Publisher",
      "publisher-url": "https://publisher.example.com",
    },
  ],
  downloads: {
    windows: {
      uploaded_at: 1609459200,
      name: "Test Trove Game Windows",
      url: {
        web: "https://example.com/test_trove_windows.exe",
        bittorrent: "magnet:?xt=urn:btih:test",
      },
      timestamp: 1609459200,
      machine_name: "test_trove_windows",
      file_size: 1048576000,
      small: 0,
      size: "1 GB",
      md5: "abcdef1234567894",
      sha1: "1234567890abcdef4",
    },
    mac: {
      uploaded_at: 1609459200,
      name: "Test Trove Game Mac",
      url: {
        web: "https://example.com/test_trove_mac.dmg",
        bittorrent: "magnet:?xt=urn:btih:test2",
      },
      timestamp: 1609459200,
      machine_name: "test_trove_mac",
      file_size: 1048576000,
      small: 0,
      size: "1 GB",
      md5: "abcdef1234567895",
      sha1: "1234567890abcdef5",
    },
  },
  "description-text": "A great game for testing purposes",
  "date-added": 1609459200,
  "background-image": null,
  popularity: 80,
  "hero-character-image": null,
  "hero-game-logo": null,
  "carousel-content": {
    thumbnail: ["https://example.com/thumbnail.jpg"],
    screenshot: ["https://example.com/screenshot.jpg"],
    "youtube-link": ["https://www.youtube.com/watch?v=example"],
  },
  "date-ended": 1640995200,
  trove_category: "game",
  "is-client-hero": null,
};

export const mockOptions: Options = {
  _: ["all"],
  dedup: true,
  bundleFolders: true,
  productFolders: true,
  humanFileNames: false,
  parallel: 2,
  format: ["pdf", "epub"],
  platform: ["windows", "mac"],
  command: "all",
  authToken: "test_auth_token",
  downloadFolder: "/tmp/test-downloads",
};

export const mockTotals: Totals = {
  bundles: 2,
  checksums: 10,
  checksumsLoaded: 5,
  preFilteredDownloads: 20,
  filteredDownloads: 15,
  removedFiles: 2,
  removedChecksums: 2,
  downloads: 13,
  doneDownloads: 13,
};

export const mockDownloadInfo: DownloadInfo = {
  date: new Date("2023-01-01"),
  bundle: "humble_test_bundle",
  name: "Test Game",
  fileName: "test_game_windows.exe",
  downloadPath: "/tmp/test-downloads/humble_test_bundle",
  filePath: "/tmp/test-downloads/humble_test_bundle/test_game_windows.exe",
  url: new URL("https://example.com/test_game_windows.exe"),
  sha1: "1234567890abcdef",
  md5: "abcdef1234567890",
  machineName: "test_game",
  structName: "windows",
  file_size: 524288000,
};
