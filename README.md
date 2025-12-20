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
$ humblebundle-ebook-downloader --help
```

Or using `deno run`:

```shell
$ deno run --allow-net --allow-read --allow-write --allow-env index.ts [command] [options]
```

### Commands

- `ebooks`: Download ebooks (default)
- `all`: Download all bundles
- `trove`: Download Humble Trove items
- `checksums`: Calculate checksums of existing files
- `cleanup`: Organize and clean up downloaded files

### Options

```
-d, --download-folder <dir>    Download folder (Required)
-t, --auth-token <token>       Authentication cookie from your browser (_simpleauth_sess) (Required for new sessions)
-l, --parallel <num>           Parallel download limit (default: 1)
-f, --format <format>          Format(s) to download (cbz, epub, mobi, pdf, pdf_hd) (Can be repeated)
-p, --platform <platform>      Platform(s) to download (ebook, video, audio) (Can be repeated)
-b, --bundle-folders           Arrange downloads in bundle folders (default: true)
--no-dedup                     Disable deduplication
--product-folders              Individual product folders (default: true)
--human-file-names             Use human readable file names (default: false)
-h, --help                     Output usage information
```

### Authentication

You need to get your auth token from the authentication cookie in your browser
after logging in to the humblebundle website (`_simpleauth_sess`). Pass this
token using the `--auth-token` argument.

## Contributors

- [J. Longman](https://github.com/jlongman)
- [Johannes Löthberg](https://github.com/kyrias)
- [jaycuse](https://github.com/jaycuse)

## License

See [LICENSE.md](LICENSE.md)
