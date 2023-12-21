import packageInfo from '../package.json' with { type: 'json' };

export const SUPPORTED_FORMATS = ['cbz', 'epub', 'pdf_hd', 'pdf', 'mobi'];
export const optionsFileName = 'options.json';
export const cacheFileName = 'checksums.json';
export const bundlesBar = 'bundles';

export const version = packageInfo.version;
export const userAgent = `HumbleBundle-Ebook-Downloader/${version}`;
