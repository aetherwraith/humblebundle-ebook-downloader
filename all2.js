#!/usr/bin/env node

import PMap from 'p-map';
import PQueue from 'p-queue';
import http2 from 'http2';
import https from 'https';
import { program as commander } from 'commander';
import colors from 'colors';
import {
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  createReadStream,
  statSync,
} from 'fs';
import { createHash } from 'crypto';
import mkdirp from 'mkdirp';
import sanitizeFilename from 'sanitize-filename';
import path from 'path';
import { createWriteStream } from 'fs';
import cliProgress from 'cli-progress';

const packageInfo = JSON.parse(readFileSync('./package.json'));

const userAgent = `Humblebundle-Ebook-Downloader/${packageInfo.version}`;

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

console.log(
  `${colors.green(Object.keys(checksumCache).length)} checksums loaded`
);

const progress = new cliProgress.MultiBar(
  {
    format:
      ' {bar} | {percentage}% | {duration_formatted}/{eta_formatted} | {value}/{total} | "{file}" ',
    hideCursor: true,
    // clearOnComplete: true,
    // stopOnComplete: true,
    etaBuffer: 25000,
    etaAsynchronousUpdate: true,
    autopadding: true,
  },
  cliProgress.Presets.shades_classic
);

const bars = new Set();

process.on('SIGINT', () => {
  writeFileSync(cacheFilePath, JSON.stringify(checksumCache));
  progress.stop();
  process.exit();
});

async function getAllOrderInfo(gameKeys) {
  console.log(`Fetching order information for ${gameKeys.length} bundles`);
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
  console.log(
    `${colors.yellow(bundles.length)} bundles containing downloadable items`
  );
  let downloads = [];
  bundles.forEach(bundle => {
    bundle.subproducts.forEach(subproduct => {
      subproduct.downloads.forEach(download => {
        download.download_struct.forEach(struct => {
          if (struct.url) {
            const url = new URL(struct.url.web);
            const fileName = path.basename(url.pathname);
            const cacheKey = path.join(
              sanitizeFilename(bundle.product.human_name),
              sanitizeFilename(subproduct.human_name),
              sanitizeFilename(fileName)
            );
            const existing = downloads.find(elem => elem.cacheKey === cacheKey);
            if (!existing) {
              downloads.push({
                bundle: bundle.product.human_name,
                download: struct,
                name: subproduct.human_name,
                cacheKey,
              });
            }
          }
        });
      });
    });
  });
  return downloads;
}

// async function filterBundles(bundles) {
//   console.log(
//     `${colors.yellow(bundles.length)} bundles containing downloadable items`
//   );
//   let downloads = [];
//   bundles.forEach(bundle => {
//     bundle.subproducts.forEach(subproduct => {
//       subproduct.downloads.forEach(download => {
//         download.download_struct.forEach(struct => {
//           if (struct.url) {
//             const url = new URL(struct.url.web);
//             const fileName = path.basename(url.pathname);
//             const cacheKey = path.join(
//               sanitizeFilename(bundle.product.human_name),
//               sanitizeFilename(subproduct.human_name),
//               sanitizeFilename(fileName)
//             );
//             const existing = downloads.some(elem => {
//               const elemUrl = new URL(elem.download.url.web);
//               const elemFileName = path.basename(elemUrl.pathname);
//               return (
//                 elem.cacheKey === cacheKey ||
//                 (elemFileName === fileName &&
//                   elem.download.sha1 === struct.sha1 &&
//                   elem.download.md5 === struct.md5)
//               );
//             });
//             if (!existing) {
//               downloads.push({
//                 bundle: bundle.product.human_name,
//                 download: struct,
//                 name: subproduct.human_name,
//                 cacheKey,
//               });
//             } else {
//               const downloadPath = path.resolve(
//                 options.downloadFolder,
//                 sanitizeFilename(bundle.product.human_name),
//                 sanitizeFilename(subproduct.human_name)
//               );

//               const url = new URL(struct.url.web);
//               const fileName = path.basename(url.pathname);

//               const filePath = path.resolve(
//                 downloadPath,
//                 sanitizeFilename(fileName)
//               );
//               if (existsSync(filePath)) {
//                 unlinkSync(filePath);
//               }
//             }
//           }
//         });
//       });
//     });
//   });
//   return downloads;
// }

function fileHash(filename, cacheKey) {
  return new Promise((resolve, reject) => {
    // Algorithm depends on availability of OpenSSL on platform
    // Another algorithms: 'sha1', 'md5', 'sha256', 'sha512' ...
    let shasum = createHash('sha1');
    let md5sum = createHash('md5');
    let size = statSync(filename).size;
    bars[cacheKey] = progress.create(size, 0, {
      file: `Hashing: ${cacheKey}`,
    });
    try {
      let s = createReadStream(filename);
      s.on('data', function (data) {
        shasum.update(data);
        md5sum.update(data);
        bars[cacheKey].increment(Buffer.byteLength(data));
      });
      // making digest
      s.on('end', function () {
        const hash = { sha1: shasum.digest('hex'), md5: md5sum.digest('hex') };
        progress.remove(bars[cacheKey]);
        bars.delete(cacheKey);
        return resolve(hash);
      });
    } catch (error) {
      return reject('calc fail');
    }
  });
}

async function checkSignatureMatch(
  filePath,
  download,
  cacheKey,
  downloaded = false
) {
  var hash = '';
  if (checksumCache[cacheKey] && !downloaded) {
    hash = checksumCache[cacheKey];
  } else {
    hash = await fileHash(filePath, cacheKey);
    checksumCache[cacheKey] = hash;
  }
  const matched =
    (download.sha1 && download.sha1 === hash.sha1) ||
    (download.md5 && download.md5 === hash.md5);
  return matched;
}

async function doDownload(filePath, download, retries = 0) {
  await new Promise(done => {
    const req = https.get(
      download.download.url.web,
      { timeout: 60000 },
      async function (res) {
        const size = Number(res.headers['content-length']);
        let got = 0;
        bars[download.cacheKey] = progress.create(size, 0, {
          file: download.cacheKey,
        });
        res.on('data', data => {
          got += Buffer.byteLength(data);
          bars[download.cacheKey].increment(Buffer.byteLength(data));
        });
        res.pipe(createWriteStream(filePath));
        res.on('end', () => {
          progress.remove(bars[download.cacheKey]);
          bars.delete(download.cacheKey);
          done();
        });
        res.on('timeout', () => req.destroy());
      }
    );
  });
  fileCheckQueue.add(() =>
    checkSignatureMatch(filePath, download.download, download.cacheKey, true)
  );
  doneDownloads++;
  bars.downloads.increment();
}

async function downloadItem(download) {
  const downloadPath = path.resolve(
    options.downloadFolder,
    sanitizeFilename(download.bundle),
    sanitizeFilename(download.name)
  );

  await mkdirp(downloadPath);
  const url = new URL(download.download.url.web);
  const fileName = path.basename(url.pathname);

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

async function downloadItems(downloads) {
  console.log(`Downloading ${downloads.length} items`);
  downloads.forEach(download => downloadItem(download));
  await fileCheckQueue.onIdle();
  await downloadQueue.onIdle();
  return Promise.all(downloadPromises);
}

(async function () {
  try {
    const gameKeys = await fetchOrders();
    totalBundles = gameKeys.length;
    bars['bundles'] = progress.create(gameKeys.length, 0, { file: 'Bundles' });
    const bundles = await getAllOrderInfo(gameKeys);
    await client.close();
    bars['bundles'].stop();
    progress.remove(bars['bundles']);
    bars.delete('bundles');
    const downloads = await filterBundles(bundles);
    downloads.sort((a, b) => a.name.localeCompare(b.name));
    totalDownloads = downloads.length;
    if (options.checksumsUpdate) {
      console.log('Updating checksums');
      bars.checkq = progress.create(0, 0, { file: 'File Check Queue' });
      downloads.forEach(async download => {
        const downloadPath = path.resolve(
          options.downloadFolder,
          sanitizeFilename(download.bundle),
          sanitizeFilename(download.name)
        );

        const url = new URL(download.download.url.web);
        const fileName = path.basename(url.pathname);

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
      bars.checkq = progress.create(0, 0, { file: 'File Check Queue' });
      await downloadItems(downloads);
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
        )} Downloaded: ${countDownloads}, checked: ${countFileChecks}`
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
    await fileCheckQueue.onIdle();
    writeFileSync(cacheFilePath, JSON.stringify(checksumCache));
  }
  await fileCheckQueue.onIdle();
  writeFileSync(cacheFilePath, JSON.stringify(checksumCache));
})();
