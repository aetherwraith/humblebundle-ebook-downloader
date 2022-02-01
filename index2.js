#!/usr/bin/env node

import PMap from 'p-map';
import PQueue from 'p-queue';
import http2 from 'http2';
import https from 'https';
import { program as commander } from 'commander';
import colors from 'colors';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import hasha from 'hasha';
import mkdirp from 'mkdirp';
import sanitizeFilename from 'sanitize-filename';
import path from 'path';
import { createWriteStream } from 'fs';
import cliProgress from 'cli-progress';

const packageInfo = JSON.parse(readFileSync('./package.json'));

const userAgent = `Humblebundle-Ebook-Downloader/${packageInfo.version}`;
const SUPPORTED_FORMATS = ['cbz', 'epub', 'pdf_hd', 'pdf', 'mobi'];

function myParseInt(value, dummyPrevious) {
  const parsedValue = parseInt(value, 10);
  if (isNaN(parsedValue)) {
    throw new commander.InvalidOptionArgumentError('Not a number.');
  }
  return parsedValue;
}

commander
  .version(packageInfo.version)
  .option(
    '-d, --download-folder <downloader_folder>',
    'Download folder',
    'download'
  )
  .option(
    '-l, --download-limit <download_limit>',
    'Parallel download limit',
    myParseInt,
    1
  )
  .option(
    '--auth-token <auth-token>',
    'You must specify your authentication cookie from your browser (_simpleauth_sess)'
  )
  .option(
    '-c, --checksums-update',
    'Update the checksums from all downloaded files'
  )
  .parse(process.argv);

const options = commander.opts();

console.log(colors.green('Starting...'));

const getRequestHeaders = {
  Accept: 'application/json',
  'Accept-Charset': 'utf-8',
  'User-Agent': userAgent,
  Cookie: `_simpleauth_sess="${options.authToken.replace(/^"|"$/g, '')}";`,
};

const client = http2.connect('https://www.humblebundle.com');
client.on('error', err => {
  client.close();
  console.error(err);
  process.exit(err);
});

let totalBundles = 0;
let doneBundles = 0;

let totalDownloads = 0;
let doneDownloads = 0;

const fileCheckQueue = new PQueue({ concurrency: options.downloadLimit });
const downloadQueue = new PQueue({ concurrency: options.downloadLimit });
const downloadPromises = [];

let countFileChecks = 0;
let countDownloads = 0;

fileCheckQueue.on('add', () => {
  countFileChecks++;
  const total = bars.checkq.total;
  bars.checkq.setTotal(total + 1);
});

fileCheckQueue.on('completed', () => {
  bars.checkq.increment();
});

downloadQueue.on('add', () => {
  countDownloads++;
  const total = bars.downloadq.total;
  bars.downloadq.setTotal(total + 1);
});

downloadQueue.on('completed', () => {
  bars.downloadq.increment();
});

// load cache file of checksums
const cacheFileName = 'checksums.json';
const cacheFilePath = path.resolve(
  options.downloadFolder,
  sanitizeFilename(cacheFileName)
);
var checksumCache = {};
if (!existsSync(cacheFilePath)) {
  mkdirp(options.downloadFolder);
  writeFileSync(cacheFilePath, JSON.stringify(checksumCache));
} else {
  checksumCache = JSON.parse(readFileSync(cacheFilePath));
}

process.on('SIGINT', () => {
  writeFileSync(cacheFilePath, JSON.stringify(checksumCache));
  progress.stop();
  process.exit();
});

let cacheHits = 0;

console.log(
  `${colors.green(Object.keys(checksumCache).length)} checksums loaded`
);

const progress = new cliProgress.MultiBar(
  {
    format:
      ' {bar} | {value}/{total} | {duration_formatted}/{eta_formatted} | "{file}" ',
    hideCursor: true,
    clearOnComplete: true,
    stopOnComplete: true,
  },
  cliProgress.Presets.shades_classic
);

const bars = {};

function normalizeFormat(format) {
  switch (format.toLowerCase()) {
    case '.cbz':
      return 'cbz';
    case 'pdf (hq)':
    case 'pdf (hd)':
      return 'pdf_hd';
    case 'download':
      return 'pdf';
    default:
      return format.toLowerCase();
  }
}

async function getAllOrderInfo(gameKeys) {
  console.log(`Fetching order information for ${gameKeys.length} bundles`);
  bars.bundles = progress.create(gameKeys.length, 0, { file: 'Bundles' });
  return PMap(gameKeys, getOrderInfo, { concurrency: options.downloadLimit });
}

async function getOrderInfo(gameKey) {
  const req = client.request({
    ...getRequestHeaders,
    ':path': `/api/v1/order/${gameKey.gamekey}?ajax=true`,
  });
  req.setEncoding('utf8');
  let data = '';
  req.on('data', chunk => {
    data += chunk;
  });
  req.end();

  req.on('error', err => {
    console.log(err);
    console.log(req);
    throw err;
  });

  await new Promise(resolve =>
    req.on('close', () => {
      resolve();
    })
  );

  bars.bundles.increment();

  if (!bars.bundles.isActive) {
    progress.remove(bars.bundles);
  }

  return JSON.parse(data);
}

async function fetchOrders() {
  console.log('Fetching bundles...');

  const req = client.request({
    ...getRequestHeaders,
    ':path': '/api/v1/user/order?ajax=true',
  });
  req.on('error', err => {
    req.close();
    client.close();
    console.error(err);
    process.exit(err);
  });
  req.setEncoding('utf8');
  let data = '';
  req.on('data', chunk => {
    if (chunk.includes('error')) {
      throw Error(chunk);
    }
    data += chunk;
  });
  req.end();

  await new Promise(resolve =>
    req.on('close', () => {
      resolve();
    })
  );
  return JSON.parse(data);
}

async function filterBundles(bundles) {
  return bundles.filter(bundle =>
    bundle.subproducts.find(subproduct =>
      subproduct.downloads.filter(
        download => download.platform.toLowerCase() === 'ebook'
      )
    )
  );
}

async function filterEbooks(ebookBundles) {
  // priority of format to download cbz -> epub -> pdf_hd -> pdf -> mobi
  console.log(
    `${colors.yellow(ebookBundles.length)} bundles containing ebooks`
  );
  let downloads = [];
  ebookBundles.forEach(bundle => {
    let date = new Date(bundle.created);
    bundle.subproducts.forEach(subproduct => {
      const filteredDownloads = subproduct.downloads.filter(
        download => download.platform.toLowerCase() === 'ebook'
      );
      SUPPORTED_FORMATS.forEach(format => {
        filteredDownloads.forEach(download =>
          download.download_struct.forEach(struct => {
            if (
              struct.name &&
              struct.url &&
              normalizeFormat(struct.name) === format
            ) {
              if (
                struct.name.toLowerCase().localeCompare('download') === 0 &&
                struct.url.web.toLowerCase().indexOf('.pdf') < 0
              ) {
                return;
              }
              const uploaded_at = new Date(struct.uploaded_at);
              if (uploaded_at > date) date = uploaded_at;
              const existing = downloads.some(
                elem => elem.name === subproduct.human_name
              );
              if (
                !existing ||
                (date > existing.date && struct.name === existing.download.name)
              ) {
                if (existing) {
                  const downloadPath = path.resolve(
                    options.downloadFolder,
                    sanitizeFilename(existing.bundle)
                  );
                  const fileName = `${existing.name.trim()}${getExtension(
                    normalizeFormat(existing.download.name)
                  )}`;
                  const filePath = path.resolve(
                    downloadPath,
                    sanitizeFilename(fileName)
                  );
                  if (
                    existsSync(filePath) &&
                    existing.bundle !== bundle.product.human_name
                  ) {
                    unlinkSync(filePath);
                  }
                  downloads = downloads.filter(
                    elem => elem.name !== existing.name
                  );
                }

                const fileName = `${subproduct.human_name.trim()}${getExtension(
                  normalizeFormat(struct.name)
                )}`;

                const cacheKey = path.join(
                  sanitizeFilename(bundle.product.human_name),
                  sanitizeFilename(fileName)
                );
                downloads.push({
                  bundle: bundle.product.human_name,
                  download: struct,
                  name: subproduct.human_name,
                  date,
                  cacheKey,
                });
              }
            }
          })
        );
      });
    });
  });
  return downloads;
}

function getExtension(format) {
  switch (format.toLowerCase()) {
    case 'pdf_hd':
      return '.pdf';
    default:
      return `.${format}`;
  }
}

async function checkSignatureMatch(
  filePath,
  download,
  cacheKey,
  downloaded = false
) {
  const algorithm = download.sha1 ? 'sha1' : 'md5';
  const hashToVerify = download[algorithm];
  var hash = '';
  if (
    checksumCache[cacheKey] &&
    checksumCache[cacheKey][algorithm] &&
    !downloaded
  ) {
    cacheHits++;
    hash = checksumCache[cacheKey][algorithm];
  } else {
    hash = await hasha.fromFile(filePath, { algorithm });
    if (downloaded) {
      if (!checksumCache[cacheKey]) {
        checksumCache[cacheKey] = {};
      }
      checksumCache[cacheKey][algorithm] = hash;
    }
  }
  const matched = hash === hashToVerify;
  return matched;
}

async function doDownload(filePath, download) {
  await new Promise(done =>
    https.get(download.download.url.web, function (res) {
      const size = Number(res.headers['content-length']);
      var got = 0;
      bars[filePath] = progress.create(100, 0, { file: filePath });
      res.on('data', data => {
        got += Buffer.byteLength(data);
        bars[filePath].update(Math.round((got / size) * 100));
      });
      res.pipe(createWriteStream(filePath));
      res.on('end', () => {
        progress.remove(bars[filePath]);
        done();
      });
    })
  );
  fileCheckQueue.add(() =>
    checkSignatureMatch(filePath, download.download, download.cacheKey, true)
  );
  doneDownloads++;
  bars.downloads.increment();
}

async function downloadEbook(download) {
  const downloadPath = path.resolve(
    options.downloadFolder,
    sanitizeFilename(download.bundle)
  );

  await mkdirp(downloadPath);

  const fileName = `${download.name.trim()}${getExtension(
    normalizeFormat(download.download.name)
  )}`;

  const filePath = path.resolve(downloadPath, sanitizeFilename(fileName));

  if (
    existsSync(filePath) &&
    (await fileCheckQueue.add(() =>
      checkSignatureMatch(filePath, download.download, download.cacheKey)
    ))
  ) {
    doneDownloads++;
    bars.downloads.increment();
  } else {
    downloadPromises.push(
      downloadQueue.add(() => doDownload(filePath, download))
    );
  }
}

async function downloadEbooks(downloads) {
  console.log(`Downloading ${downloads.length} ebooks`);
  downloads.forEach(download => downloadEbook(download));
  await fileCheckQueue.onIdle();
  await downloadQueue.onIdle();
  return Promise.all(downloadPromises);
}

(async function () {
  try {
    const gameKeys = await fetchOrders();
    totalBundles = gameKeys.length;
    const bundles = await getAllOrderInfo(gameKeys);
    await client.close();
    const ebookBundles = await filterBundles(bundles);
    const downloads = await filterEbooks(ebookBundles);
    downloads.sort((a, b) => a.name.localeCompare(b.name));
    if (
      downloads.some(
        (item, index) =>
          downloads.findIndex(elem => elem.name === item.name) !== index
      )
    ) {
      process.exit('Something went wrong and I found some duplicates');
    }
    totalDownloads = downloads.length;
    bars.checkq = progress.create(0, 0, { file: 'File Check Queue' });
    if (options.checksumsUpdate) {
      console.log('Updating checksums');
      downloads.forEach(async download => {
        const downloadPath = path.resolve(
          options.downloadFolder,
          sanitizeFilename(download.bundle)
        );

        const fileName = `${download.name.trim()}${getExtension(
          normalizeFormat(download.download.name)
        )}`;

        const filePath = path.resolve(downloadPath, sanitizeFilename(fileName));
        if (existsSync(filePath)) {
          fileCheckQueue.add(() =>
            checkSignatureMatch(
              filePath,
              download.download,
              download.cacheKey,
              true
            )
          );
        }
      });
      await fileCheckQueue.onIdle();
      progress.stop();
      console.log(
        `${colors.green('Checked:')} ${colors.blue(countFileChecks)}`
      );
    } else {
      bars.downloads = progress.create(totalDownloads, 0, {
        file: 'Downloads',
      });
      bars.downloadq = progress.create(0, 0, { file: 'Download Queue' });
      await downloadEbooks(downloads);
      while (doneDownloads < totalDownloads) {
        await new Promise(resolve => {
          setTimeout(() => resolve(), 1000);
        });
        await fileCheckQueue.onIdle();
        await downloadQueue.onIdle();
        await Promise.all(downloadPromises);
      }
      progress.stop();
      console.log(
        `${colors.green(
          'Done!'
        )} Downloaded: ${countDownloads}, checked: ${countFileChecks}, cache hits: ${cacheHits}`
      );
    }
    await fileCheckQueue.onIdle();
    writeFileSync(cacheFilePath, JSON.stringify(checksumCache));
  } catch (err) {
    console.log(
      `${colors.red(
        'Something bad happened!'
      )} Downloaded: ${countDownloads}, checked: ${countFileChecks}`
    );
    console.log(err);
  }
})();
