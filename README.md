# Humble Bundle Downloader

A Deno-based downloader for Humble Bundle purchases.

## Features

- Download all your Humble Bundle purchases
- Support for various content types (ebooks, games, etc.)
- Progress tracking
- Checksumming to verify downloads
- Flexible folder organization options

## Installation

### Prerequisites

- [Deno](https://deno.land/) installed on your system

### Clone and Run

```bash
# Clone the repository
git clone [repository-url]
cd humble-downloader

# Run the downloader
deno run --allow-read --allow-write --allow-net --allow-env index.ts all --download-folder "./downloads" --auth-token "your_auth_token"
```

## Authentication

You need to provide your Humble Bundle authentication token. To get this:

1. Log into HumbleBundle.com
2. Open your browser's developer tools
3. Go to the Storage/Application tab
4. Look for Cookies and find the `_simpleauth_sess` cookie
5. Copy the value and use it with `--auth-token`

## Usage

```
deno run --allow-read --allow-write --allow-net --allow-env index.ts [command] [options]
```

### Commands

- `all` - Download all content
- `ebooks` - Download only ebooks
- `trove` - Download Humble Trove content
- `checksums` - Calculate checksums for existing files
- `cleanup` - Remove files that are no longer in your bundles
- `cleanupebooks` - Remove ebooks that are no longer in your bundles

### Options

- `--download-folder` or `-d` - (Required) Folder to download files to
- `--auth-token` or `-t` - (Required) Authentication token from HumbleBundle
- `--parallel` or `-l` - Number of parallel downloads (default: 1)
- `--format` or `-f` - Format(s) to download (can specify multiple times)
- `--platform` or `-p` - Platform(s) to download (can specify multiple times)
- `--dedup` - Deduplicate downloads (default: true)
- `--no-dedup` - Disable deduplication
- `--bundle-folders` - Organize in bundle folders (default: true)
- `--no-bundle-folders` - Don't organize in bundle folders
- `--product-folders` - Organize in product folders (default: true)
- `--no-product-folders` - Don't organize in product folders
- `--human-file-names` - Use human-readable filenames (default: false)

## Examples

```bash
# Download all content
deno run --allow-read --allow-write --allow-net --allow-env index.ts all -d "./downloads" -t "your_auth_token"

# Download only ebooks in epub format
deno run --allow-read --allow-write --allow-net --allow-env index.ts ebooks -d "./downloads" -t "your_auth_token" -f epub

# Download with 4 parallel downloads and no bundle folders
deno run --allow-read --allow-write --allow-net --allow-env index.ts all -d "./downloads" -t "your_auth_token" -l 4 --no-bundle-folders
```

## Building an Executable

You can compile to a standalone executable with:

```bash
deno compile --allow-read --allow-write --allow-net --allow-env index.ts
```

Or use the included task:

```bash
deno task compile
```

## License

This project is licensed under the MIT License.
