# Humble Bundle Ebook Downloader

A fast, concurrent CLI tool built with [Deno](https://deno.com/) to download and synchronize ebooks, comics, audiobooks/soundtracks, videos, games, and Humble Vault (Trove) items from your Humble Bundle account.

## Features

- **Concurrent Downloads & Hashing**: Configurable parallel worker queues for fast Next.js RSC Flight metadata fetching, checksum verification, and file downloads.
- **Smart Deduplication & Format Prioritization**:
  - **Ebooks & Comics (`ebooks`)**: Prioritizes preferred formats (`cb?` (`cbz` → `cbr`) → `epub` → `pdf_hd` → `pdf` → `mobi`) and deduplicates across bundles, keeping the newest edition.
  - **Audio (`audio`)**: Prioritizes lossless and preferred audio codecs (`flac` → `alac` → `wav` → `aiff` → `m4b` → `m4a` → `aac` → `ogg` → `opus` → `mp3`) across soundtracks, audiobooks, and comedy albums.
  - **Videos (`videos`)**: Prioritizes preferred video resolutions (`best`, `1080p`, `4k`, etc.) across video courses and stand-up comedy specials while preserving subtitle/supplement archives and multi-part downloads.
- **Incremental & Migration-Safe Caching**: Caches bundle metadata (`bundles.json`), preserves unmigrated legacy bundles (`bundles.legacy.json`) and retired Vault items (`troves.archive.json`), and caches file hashes (`checksums.json`).
- **Automatic Resume & Signed URL Refresh**: Mints fresh signed CDN URLs via Humble's Next.js Server Actions and resumes interrupted `.part` downloads seamlessly.
- **Flexible Naming & Media Server Sidecars**: Organize by Bundle/Product folders, custom `--output-template`, or `--human-file-names`, with optional `.opf` metadata, cover art, `.m3u8` playlists, and archive extraction.
- **Humble Vault (Trove) Support**: Download DRM-free games and items from the Humble Choice Vault catalog.

---

## Installation

Ensure you have [Deno](https://deno.com/) installed (v1.40+ or v2.x).

### Run Directly

```shell
deno run --allow-net --allow-read --allow-write --allow-env index.ts --help
```

### Install Globally

```shell
deno install --global --allow-net --allow-read --allow-write --allow-env -n humblebundle-ebook-downloader index.ts
```

---

## Usage

```shell
humblebundle-ebook-downloader [command] [options]
# or via Deno:
deno run --allow-net --allow-read --allow-write --allow-env index.ts [command] [options]
```

### Commands

| Command | Description |
| :--- | :--- |
| `ebooks` | Download ebooks and comics with format prioritization (Default) |
| `audio` | Download soundtracks, audiobooks, and comedy albums with audio format prioritization |
| `videos` (or `video`) | Download videos, courses, and comedy specials with video quality prioritization |
| `all` | Download all items matching selected platforms |
| `trove` | Download Humble Vault (Trove) catalog items |
| `verify` | Re-hash all matching local files from disk to verify integrity against Humble Bundle hashes |
| `repair` | Verify all matching local files from disk and automatically re-download missing or corrupted files |
| `stats` / `list` | Display library breakdown, format statistics, top publishers, and local download status |
| `bundles` | List all purchased bundles with purchase date, key/UUID, matched items, completion status, and size |
| `unclaimed` | List unclaimed Humble Choice picks, unredeemed third-party keys, and external-link-only items |
| `export` | Export searchable `catalog.json` and `catalog.csv` of your library |
| `checksums` | Calculate and cache checksums of all existing files in the download folder |
| `cleanup` | Organize files and delete items that are no longer part of your bundles |
| `cleanupaudio` | Clean up audio downloads specifically |
| `cleanupebooks` | Clean up ebook downloads specifically |
| `cleanuptrove` | Clean up Trove downloads |
| `cleanupvideos` | Clean up video downloads specifically |
| `completions [shell]` | Print shell tab-completion script (`bash`, `zsh`, or `fish`) |

### Options

| Flag | Alias | Description | Default |
| :--- | :--- | :--- | :--- |
| `--download-folder <dir>` | `-d` | Target download directory (**Required**) | — |
| `--auth-token <cookie>` | `-t` | Path to Netscape `cookie.txt` file, `Cookie` header string, or `ory_session_*` cookie | Auto-detected from `cookie.txt` |
| `--parallel <num>` | `-l` | Maximum concurrent downloads | `5` |
| `--bundle-key <key>` | `-k` | Only process specific bundle UUID(s), `group/<uuid>`, legacy gamekey(s), or `/home/library/...` URLs. Repeatable. | — |
| `--format <format>` | `-f` | Ebook/comic format priority (`cb?` for `cbz`/`cbr`, or explicit `cbz`, `cbr`, `epub`, `pdf_hd`, `pdf`, `mobi`). Repeatable. | `cb?, epub, pdf_hd, pdf, mobi` |
| `--audio-format <fmt>` | `-a` | Audio codec priority (`flac`, `alac`, `wav`, `aiff`, `m4b`, `m4a`, `aac`, `ogg`, `opus`, `mp3`). Repeatable. | `flac, alac, wav, aiff, m4b, m4a, aac, ogg, opus, mp3` |
| `--platform <platform>` | `-p` | Platform (`ebook`, `audio`, `video`, `comedy`, `windows`, `mac`, `linux`, `android`, `asmjs`, `other`). Repeatable. | All platforms |
| `--video-quality <quality>` | `-q` | Video quality priority (`best`, `worst`, `4k`/`2160p`, `1440p`, `1080p`, `720p`, `480p`, `360p`, `hd`, `sd`). Repeatable (e.g. `-q 1080p -q best`). | `best` |
| `--filter <pattern>` | `-s` | Case-insensitive substring or regex to filter bundle or item names | — |
| `--exclude <pattern>` | `-x` | Case-insensitive substring or regex to exclude bundle or item names | — |
| `--since <date>` | — | Only include bundles/items created or updated on or after `<date>` (e.g. `2025-01-01`) | — |
| `--before <date>` | — | Only include bundles/items created or updated on or before `<date>` (e.g. `2025-12-31`) | — |
| `--max-size <size>` | `-m` | Skip files larger than `<size>` (e.g. `500MB`, `2GB`) | — |
| `--min-size <size>` | — | Skip files smaller than `<size>` (e.g. `1MB`, `50KB`) | — |
| `--rate-limit <speed>` | `-r` | Cap total download bandwidth speed across all workers (e.g. `5MB`, `500KB`) | — |
| `--output-template <tpl>` | — | Custom path template using `{bundle}`, `{publisher}`, `{product}`, `{format}`, `{ext}`, `{year}`, `{filename}` | — |
| `--preserve-mtime` | — | Set downloaded file modification timestamps to their Humble Bundle publication/upload date | `false` |
| `--extract` | — | Automatically extract downloaded `.zip` and `.tar.gz`/`.tgz` archives into subdirectories | `false` |
| `--playlists` | — | Generate `.m3u8` playlists in folders containing downloaded audio tracks | `false` |
| `--opf` | — | Generate Calibre / Komga / Kavita `.opf` metadata sidecars alongside downloads | `false` |
| `--covers` | — | Download cover art images (`.jpg`/`.png`) alongside items | `false` |
| `--torrent` | — | Download `.torrent` files instead of direct web downloads when available | `false` |
| `--bundle-folders` / `--no-bundle-folders` | `-b` | Organize downloads into bundle folders | `true` |
| `--product-folders` / `--no-product-folders` | — | Organize downloads into subproduct folders | `true` |
| `--human-file-names` | — | Rename files using human-readable item titles | `false` |
| `--dedup` / `--no-dedup` | — | Deduplicate downloads across bundles | `true` |
| `--link-duplicates` | — | Hardlink (or copy) already-verified identical local files instead of re-downloading under `--no-dedup` | `false` |
| `--deep` | — | Validate binary headers/trailers (`.pdf`, `.epub`, `.cbz`, `.cbr`, `.zip`, `.mobi`, etc.) during `verify` and `repair` | `false` |
| `--webhook <url>` | — | POST a JSON run summary to `<url>` upon sync/repair completion | — |
| `--update` | `-u` | Force refresh bundle metadata from API (bypasses `bundles.json` cache) | `false` |
| `--dry-run` | `-n` | Preview downloads and cleanups without modifying files on disk | `false` |
| `--json` | `-j` | Output command results and run summary as machine-readable JSON | `false` |
| `--verbose` | `-v` | Show detailed debug and diagnostic logs in the terminal | `false` |
| `--log-file <path>` | — | Custom file path for detailed logs | `<downloadFolder>/humblebundle.log` |
| `--help` | `-h` | Output usage information | — |

---

## Configuration & Environment Variables

In addition to CLI flags, default options can be configured via `.humblerc.json` in your working directory or `HUMBLE_*` environment variables (`HUMBLE_DOWNLOAD_FOLDER`, `HUMBLE_AUTH_TOKEN`, `HUMBLE_PARALLEL`, `HUMBLE_FORMAT`, `HUMBLE_AUDIO_FORMAT`, `HUMBLE_PLATFORM`, `HUMBLE_VIDEO_QUALITY`, `HUMBLE_OPF`, `HUMBLE_COVERS`, `HUMBLE_VERBOSE`, etc.). Priority order is:

`CLI flags > HUMBLE_* environment variables > .humblerc.json > saved options.json > defaults`

---

## Authentication

Authentication is required to access your Humble Bundle library:

1. **Cookie File Export (Recommended)**:
   - Log in to [humblebundle.com/home/library](https://www.humblebundle.com/home/library) in your browser.
   - Export your `humblebundle.com` cookies using an extension like *Get cookies.txt LOCALLY* (or copy the `Cookie:` request header from DevTools → Network on `/home/library`).
   - Save the file as `cookie.txt` in the project directory (or pass `-t /path/to/cookie.txt`). All `.humblebundle.com` session cookies (`ory_session_*`, etc.) are parsed automatically.
2. **Inline Cookie / Token**:
   - Open Developer Tools (`F12` or `Ctrl+Shift+I`) on `https://www.humblebundle.com/home/library`.
   - Under Application / Storage → Cookies, copy `ory_session_<id>=<value>` (or the full `Cookie` header) and pass it via `-t` / `--auth-token`.

---

## Caching Architecture

The downloader stores cache and configuration files inside your `--download-folder`:

- `options.json`: Saves CLI settings so subsequent runs retain your preferences.
- `bundles.json`: Cached bundle purchase metadata from Humble Bundle (`RSC: 1` Flight streams + `filterUserLibrary`), updated incrementally during syncs. Use `--update` (`-u`) to force a fresh fetch.
- `bundles.legacy.json`: Automatic archive of pre-migration legacy `bundles.json` metadata so historical purchase dates, cover icons, and any not-yet-migrated bundles are preserved.
- `troves.json` / `troves.archive.json`: Active Humble Vault catalog metadata and automatic archive of retired Vault items.
- `checksums.json`: Precomputed SHA-1 and MD5 hashes of local files for instantaneous verification.
- `filteredBundles.json`: List of resolved items prepared for downloading.

---

## Development & Testing

Run tests and type checks with Deno tasks:

```shell
# Run all unit tests
deno task test

# Run TypeScript type check
deno task check
```

---

## License

See [LICENSE.md](LICENSE.md).
