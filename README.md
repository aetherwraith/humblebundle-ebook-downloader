# Humble Bundle Ebook Downloader

An easy way to download ebooks from your Humble Bundle account.

## Installation

### Deno

This tool is built with [Deno](https://deno.com/). Ensure you have Deno
installed (v1.40+ recommended).

To run directly so you don't have to install it:

```shell
deno run --allow-net --allow-read --allow-write --allow-env index.ts --help
```

To install globally:

```shell
deno install --global --allow-net --allow-read --allow-write --allow-env -n humblebundle-ebook-downloader index.ts
```

## Usage

If installed globally:

```shell
humblebundle-ebook-downloader --help
```

Or using `deno run`:

```shell
deno run --allow-net --allow-read --allow-write --allow-env index.ts [command] [options]
```

### Commands

- `ebooks`: Download ebooks (default)
- `all`: Download all bundles
- `trove`: Download Humble Trove items
- `checksums`: Calculate checksums of existing files
- `cleanup`: Organize and clean up downloaded files

### Options

```text
-d, --download-folder <dir>    Download folder (Required)
-t, --auth-token <token>       Authentication cookie from your browser (_simpleauth_sess) (Optional if cookie.txt is present)
-l, --parallel <num>           Parallel download limit (default: 5)
-f, --format <format>          Format(s) to download (cbz, epub, mobi, pdf, pdf_hd) (Can be repeated)
-p, --platform <platform>      Platform(s) to download (ebook, video, audio) (Can be repeated)
-b, --bundle-folders           Arrange downloads in bundle folders (default: true)
--no-dedup                     Disable deduplication
--product-folders              Individual product folders (default: true)
--human-file-names             Use human readable file names (default: false)
-u, --update                   Force fetch bundle details instead of using local cache
-h, --help                     Output usage information
```

### Authentication

You need to authenticate to Humble Bundle to download your files. There are two ways to do this:

1. **Automatically (Recommended):** Export your Humble Bundle cookies using a browser extension (like "Get cookies.txt LOCALLY") and save the file as `cookie.txt` in the same folder as `index.ts`. The script will automatically detect and parse it.
2. **Manually:** Find the `_simpleauth_sess` cookie in your browser's developer tools after logging in. Pass this token manually using the `-t` or `--auth-token` argument.

## Contributors

- [J. Longman](https://github.com/jlongman)
- [Johannes Löthberg](https://github.com/kyrias)
- [jaycuse](https://github.com/jaycuse)

## License

See [LICENSE.md](LICENSE.md)
