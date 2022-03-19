#!/usr/bin/env node

import PMap from 'p-map';
import PQueue from 'p-queue';
import http2 from 'http2';
import { program } from 'commander';
import colors from 'colors';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import mkdirp from 'mkdirp';
import sanitizeFilename from 'sanitize-filename';
import path from 'path';
import cliProgress from 'cli-progress';
import { createHash } from 'crypto';
import https from 'https';

const packageInfo = JSON.parse(
  readFileSync('./package.json', { encoding: 'utf8' })
);
const userAgent = `HumbleBundle-Ebook-Downloader/${packageInfo.version}`;
const SUPPORTED_FORMATS = ['cbz', 'epub', 'pdf_hd', 'pdf', 'mobi'];

let authToken, fileCheckQueue, downloadQueue, checksumCache;
let totalDownloads = 0;
let doneDownloads = 0;
let countFileChecks = 0;
let countDownloads = 0;
let preFilteredDownloads = 0;

const progress = new cliProgress.MultiBar(
  {
    format:
      ' {bar} | {percentage}% | {duration_formatted}/{eta_formatted} | {value}/{total} | "{file}" ',
    hideCursor: true,
    etaBuffer: 25000,
    etaAsynchronousUpdate: true,
    autopadding: true,
  },
  cliProgress.Presets.shades_classic
);

const bars = new Set();

const bundlesBar = 'bundles';

function myParseInt(value, dummyPrevious) {
  const parsedValue = parseInt(value, 10);
  if (isNaN(parsedValue)) {
    throw new program.InvalidOptionArgumentError('Not a number.');
  }
  return parsedValue;
}

function loadChecksumCache(downloadFolder) {
  // load cache file of checksums
  const cacheFileName = 'checksums.json';
  const cacheFilePath = path.resolve(
    downloadFolder,
    sanitizeFilename(cacheFileName)
  );

  checksumCache = {};
  if (!existsSync(cacheFilePath)) {
    mkdirp(downloadFolder);
    writeFileSync(cacheFilePath, JSON.stringify(checksumCache));
  } else {
    checksumCache = JSON.parse(
      readFileSync(cacheFilePath, { encoding: 'utf8' })
    );
  }

  function exitHandler() {
    writeFileSync(cacheFilePath, JSON.stringify(checksumCache));
    progress.stop();
    process.exit();
  }

  process.on('SIGINT', exitHandler);

  process.on('exit', exitHandler);

  console.log(
    `${colors.green(Object.keys(checksumCache).length)} checksums loaded`
  );
  return checksumCache;
}

function getRequestHeaders() {
  return {
    Accept: 'application/json',
    'Accept-Charset': 'utf-8',
    'User-Agent': userAgent,
    Cookie: `_simpleauth_sess="${authToken.replace(/^"|"$/g, '')}";`,
  };
}

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

function getExtension(format) {
  switch (format.toLowerCase()) {
    case 'pdf_hd':
      return '.pdf';
    default:
      return `.${format}`;
  }
}

function createFileCheckQueue(concurrency) {
  fileCheckQueue = new PQueue({ concurrency });

  bars.checkq = progress.create(0, 0, { file: 'File Check Queue' });

  fileCheckQueue.on('add', () => {
    countFileChecks++;
    const total = bars.checkq.total;
    bars.checkq.setTotal(total + 1);
  });

  fileCheckQueue.on('completed', () => {
    bars.checkq.increment();
  });
}

function createDownloadQueue(concurrency) {
  downloadQueue = new PQueue({ concurrency });

  bars.downloadq = progress.create(0, 0, { file: 'Download Queue' });

  downloadQueue.on('add', () => {
    countDownloads++;
    const total = bars.downloadq.total;
    bars.downloadq.setTotal(total + 1);
  });

  downloadQueue.on('completed', () => {
    bars.downloadq.increment();
  });
}

/* Prepend the given path segment */
const prependPathSegment = pathSegment => location =>
  path.join(pathSegment, location);

/* fs.readdir but with relative paths */
const readdirPreserveRelativePath = location =>
  readdirSync(location).map(prependPathSegment(location));

/* Recursive fs.readdir but with relative paths */
const readdirRecursive = location =>
  readdirPreserveRelativePath(location).reduce(
    (result, currentValue) =>
      statSync(currentValue).isDirectory()
        ? result.concat(readdirRecursive(currentValue))
        : result.concat(currentValue),
    []
  );

const getExistingDownloads = downloadFolder =>
  readdirRecursive(downloadFolder)
    .filter(file => !file.includes('checksums.json'))
    .map(file => {
      let cacheKey = file.replace(downloadFolder, '');
      if (cacheKey.startsWith('/')) {
        cacheKey = cacheKey.substring(1);
      }
      return { filePath: file, cacheKey };
    });

async function fetchOrder(urlPath) {
  const client = http2.connect('https://www.humblebundle.com');

  const req = client.request({
    ...getRequestHeaders(),
    ':path': urlPath,
  });
  req.on('error', err => {
    req.close();
    client.close();
    client.destroy();
    console.error(err);
    process.exit(err);
  });
  req.setEncoding('utf8');
  let data = '';
  req.on('data', chunk => {
    data += chunk;
  });
  req.end();

  await new Promise(resolve =>
    req.on('close', () => {
      client.close();
      client.destroy();
      resolve();
    })
  );
  return JSON.parse(data);
}

async function getOrderList() {
  console.log('Fetching all purchased bundles');
  return fetchOrder('/api/v1/user/order?ajax=true');
}

async function getAllOrderInfo(gameKeys, concurrency) {
  console.log(`Fetching order information for ${gameKeys.length} bundles`);

  bars[bundlesBar] = progress.create(gameKeys.length, 0, { file: bundlesBar });
  return PMap(gameKeys, getOrderInfo, { concurrency }).then(
    async allBundles => {
      progress.remove(bars[bundlesBar]);
      bars.delete(bundlesBar);
      return allBundles.sort((a, b) =>
        a.product.human_name.localeCompare(b.product.human_name)
      );
    }
  );
}

async function getOrderInfo(gameKey) {
  return fetchOrder(`/api/v1/order/${gameKey.gamekey}?ajax=true`).then(
    orderInfo => {
      bars[bundlesBar].increment();
      return orderInfo;
    }
  );
}

async function fileHash(download) {
  return new Promise((resolve, reject) => {
    // Algorithm depends on availability of OpenSSL on platform
    // Another algorithms: 'sha1', 'md5', 'sha256', 'sha512' ...
    let shasum = createHash('sha1');
    let md5sum = createHash('md5');
    let size = statSync(download.filePath).size;
    bars[download.cacheKey] = progress.create(size, 0, {
      file: colors.yellow(`Hashing: ${download.cacheKey}`),
    });
    try {
      let s = createReadStream(download.filePath);
      s.on('data', function (data) {
        shasum.update(data);
        md5sum.update(data);
        bars[download.cacheKey].increment(Buffer.byteLength(data));
      });
      // making digest
      s.on('end', function () {
        const hash = { sha1: shasum.digest('hex'), md5: md5sum.digest('hex') };
        progress.remove(bars[download.cacheKey]);
        bars.delete(download.cacheKey);
        return resolve(hash);
      });
    } catch (error) {
      return reject('calc fail');
    }
  });
}

async function updateHash(download) {
  checksumCache[download.cacheKey] = await fileHash(download);
}

async function filterOrders(orders, downloadFolder) {
  console.log(
    `${colors.yellow(orders.length)} bundles containing downloadable items`
  );
  let downloads = [];
  orders.forEach(order => {
    order.subproducts.forEach(subproduct => {
      subproduct.downloads.forEach(download => {
        download.download_struct.forEach(struct => {
          if (struct.url) {
            preFilteredDownloads++;
            const url = new URL(struct.url.web);
            const fileName = sanitizeFilename(path.basename(url.pathname));
            const cacheKey = path.join(
              sanitizeFilename(order.product.human_name),
              sanitizeFilename(subproduct.human_name),
              fileName
            );
            const downloadPath = path.resolve(
              downloadFolder,
              sanitizeFilename(order.product.human_name),
              sanitizeFilename(subproduct.human_name)
            );
            const filePath = path.resolve(downloadPath, fileName);

            const existing = downloads.some(elem => {
              return (
                elem.cacheKey === cacheKey ||
                (struct.sha1 && struct.sha1 === elem.sha1) ||
                (struct.md5 && struct.md5 === elem.md5)
              );
            });
            if (!existing) {
              downloads.push({
                bundle: order.product.human_name,
                // download: struct,
                name: subproduct.human_name,
                cacheKey,
                fileName,
                downloadPath,
                filePath,
                url,
                sha1: struct.sha1,
                md5: struct.md5,
              });
            } else {
              // not doing this any more as it causes a lot of extra downloads with duplicate bundles
              // if (existsSync(filePath)) {
              //   unlinkSync(filePath);
              // }
            }
          }
        });
      });
    });
  });
  return downloads.sort((a, b) => a.name.localeCompare(b.name));
}

async function getAllTroveInfo() {
  const client = http2.connect('https://www.humblebundle.com');
  client.on('error', err => {
    client.close();
    client.destroy();
    console.error(err);
    process.exit(err);
  });
  let page = 0;
  let done = false;
  const troveData = [];
  while (!done) {
    const req = client.request({
      ...getRequestHeaders,
      ':path': `/client/catalog?index=${page}`,
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

    const results = JSON.parse(data);
    if (results.length) {
      results.forEach(result => troveData.push(result));
      page += 1;
    } else {
      done = true;
    }
  }
  await client.close();
  await client.destroy();
  return troveData;
}

async function getTroveDownloadUrl(download) {
  const client = http2.connect('https://www.humblebundle.com');
  client.on('error', err => {
    client.close();
    client.destroy();
    console.error(err);
    process.exit(err);
  });

  const req = client.request({
    cookie: `_simpleauth_sess="${authToken.replace(/^"|"$/g, '')}";`,
    ':path': `/api/v1/user/download/sign?machine_name=${download.download.machine_name}&filename=${download.download.url.web}`,
    ':method': 'POST',
  });

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

  await client.close();
  await client.destroy();
  const parsed = JSON.parse(data);
  return parsed.signed_url;
}

async function filterTroves(troves, downloadFolder) {
  console.log(
    `${colors.yellow(troves.length)} bundles containing downloadable items`
  );
  let downloads = [];
  troves.forEach(trovey => {
    Object.values(trovey.downloads).forEach(download => {
      if (download.url) {
        preFilteredDownloads++;
        const fileName = path.basename(download.url.web);
        const cacheKey = path.join(
          sanitizeFilename(trovey['human-name']),
          sanitizeFilename(fileName)
        );
        const downloadPath = path.resolve(
          downloadFolder,
          sanitizeFilename(trovey['human-name'])
        );
        const filePath = path.resolve(downloadPath, fileName);
        const existing = downloads.some(
          elem =>
            elem.cacheKey === cacheKey ||
            (download.sha1 && download.sha1 === elem.sha1) ||
            (download.md5 && download.md5 === elem.md5)
        );
        if (!existing) {
          downloads.push({
            download,
            name: trovey['human-name'],
            cacheKey,
            fileName,
            downloadPath,
            filePath,
            sha1: download.sha1,
            md5: download.md5,
          });
        }
      }
    });
  });

  return downloads.sort((a, b) => a.name.localeCompare(b.name));
}

async function filterEbooks(ebookBundles, downloadFolder) {
  // priority of format to download cbz -> epub -> pdf_hd -> pdf -> mobi
  console.log(
    `${colors.yellow(ebookBundles.length)} bundles containing ebooks`
  );
  let downloads = [];
  ebookBundles
    // .filter(bundle =>
    //   bundle.subproducts.find(subproduct =>
    //     subproduct.downloads.filter(
    //       download => download.platform.toLowerCase() === 'ebook'
    //     )
    //   )
    // )
    .forEach(bundle => {
      let date = new Date(bundle.created);
      bundle.subproducts.forEach(subproduct => {
        // const filteredDownloads = subproduct.downloads.filter(
        //   download => download.platform.toLowerCase() === 'ebook'
        // );
        const filteredDownloads = subproduct.downloads;
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
                // TODO: check hash matches too
                const existing = downloads.some(
                  elem => elem.name === subproduct.human_name
                );
                if (
                  !existing ||
                  (date > existing.date &&
                    struct.name === existing.download.name)
                ) {
                  if (existing) {
                    downloads = downloads.filter(
                      elem => elem.name !== existing.name
                    );
                  }
                  const downloadPath = path.resolve(
                    downloadFolder,
                    sanitizeFilename(bundle.product.human_name)
                  );
                  const fileName = `${subproduct.human_name.trim()}${getExtension(
                    normalizeFormat(struct.name)
                  )}`;
                  const filePath = path.resolve(
                    downloadPath,
                    sanitizeFilename(fileName)
                  );
                  const cacheKey = path.join(
                    sanitizeFilename(bundle.product.human_name),
                    sanitizeFilename(fileName)
                  );
                  const url = new URL(struct.url.web);
                  downloads.push({
                    bundle: bundle.product.human_name,
                    // download: struct,
                    name: subproduct.human_name,
                    cacheKey,
                    fileName,
                    downloadPath,
                    filePath,
                    url,
                    sha1: struct.sha1,
                    md5: struct.md5,
                  });
                }
              }
            })
          );
        });
      });
    });
  return downloads.sort((a, b) => a.name.localeCompare(b.name));
}

async function doDownload(download, retries = 0) {
  return new Promise((done, reject) => {
    const handleDownloadError = request => {
      request.destroy();
      progress.remove(bars[download.cacheKey]);
      bars.delete(download.cacheKey);
      if (retries < 300) {
        downloadQueue.add(() => doDownload(download, retries + 1));
        done();
      } else {
        reject(`${download.cacheKey}: Download failed ${retries} times`);
      }
    };

    const req = https.get(
      download.url,
      { timeout: 60000 },
      async function (res) {
        const size = Number(res.headers['content-length']);
        let got = 0;
        let shasum = createHash('sha1');
        let md5sum = createHash('md5');
        bars[download.cacheKey] = progress.create(size, 0, {
          file: colors.green(download.cacheKey),
        });
        res.on('data', data => {
          shasum.update(data);
          md5sum.update(data);
          got += Buffer.byteLength(data);
          bars[download.cacheKey].increment(Buffer.byteLength(data));
        });
        res.pipe(createWriteStream(download.filePath));
        res.on('end', () => {
          checksumCache[download.cacheKey] = {
            sha1: shasum.digest('hex'),
            md5: md5sum.digest('hex'),
          };
          progress.remove(bars[download.cacheKey]);
          bars.delete(download.cacheKey);
          doneDownloads++;
          bars.downloads.increment();
          done();
        });
        res.on('error', () => handleDownloadError(req));
      }
    );
    req.on('error', () => handleDownloadError(req));
  });
}

async function checkSignatureMatch(download, downloaded = false) {
  let verified = false;
  if (existsSync(download.filePath)) {
    let hash;
    if (checksumCache[download.cacheKey] && !downloaded) {
      hash = checksumCache[download.cacheKey];
    } else {
      hash = await fileHash(download);
      checksumCache[download.cacheKey] = hash;
    }
    verified =
      (download.sha1 && download.sha1 === hash.sha1) ||
      (download.md5 && download.md5 === hash.md5);
    // assume remote checksum is bad
    // if (!checked) {
    //   const newhash = await fileHash(download);
    //   checked = newhash.sha1 === hash.sha1 || newhash.md5 === hash.md5;
    // }
  }
  return verified;
}

async function downloadItem(download) {
  await mkdirp(download.downloadPath);

  if (await fileCheckQueue.add(() => checkSignatureMatch(download))) {
    doneDownloads++;
    bars.downloads.increment();
  } else {
    return downloadQueue.add(() => doDownload(download));
  }
}

async function downloadTroveItem(download) {
  await mkdirp(download.downloadPath);

  if (await fileCheckQueue.add(() => checkSignatureMatch(download))) {
    doneDownloads++;
    bars.downloads.increment();
  } else {
    const url = await getTroveDownloadUrl(download);
    return downloadQueue.add(() => doDownload({ url, ...download }));
  }
}

async function clean(options, downloads) {
  const existingDownloads = getExistingDownloads(options.downloadFolder);
  console.log('Removing files');
  existingDownloads.forEach(existingDownload => {
    if (
      !downloads.some(
        download => existingDownload.cacheKey === download.cacheKey
      )
    ) {
      console.log(`Deleting extra file: ${existingDownload.cacheKey}`);
      unlinkSync(existingDownload.filePath);
    }
  });
  console.log('Removing checksums from cache');
  Object.keys(checksumCache).forEach(cacheKey => {
    if (!downloads.some(download => cacheKey === download.cacheKey)) {
      console.log(`Removing checksum from cache: ${cacheKey}`);
      delete checksumCache[cacheKey];
    }
  });
}

async function all() {
  const options = program.opts();
  authToken = options.authToken;
  checksumCache = loadChecksumCache(options.downloadFolder);
  const orderList = await getOrderList();
  const orderInfo = await getAllOrderInfo(orderList, options.concurrency);
  const downloads = await filterOrders(orderInfo, options.downloadFolder);
  console.log(
    `original: ${preFilteredDownloads} filtered: ${downloads.length}`
  );
  totalDownloads = downloads.length;
  bars.downloads = progress.create(downloads.length, 0, {
    file: 'Downloads',
  });
  createDownloadQueue(options.downloadLimit);
  createFileCheckQueue(options.downloadLimit);
  await Promise.all(downloads.map(download => downloadItem(download)));

  await fileCheckQueue.onIdle();
  await downloadQueue.onIdle();

  progress.stop();
  await clean(options, downloads);
  console.log(
    `${colors.green(
      'Done!'
    )} Downloaded: ${countDownloads}, checked: ${countFileChecks}`
  );
}

async function trove() {
  const options = program.opts();
  authToken = options.authToken;
  checksumCache = loadChecksumCache(options.downloadFolder);
  const troves = await getAllTroveInfo();
  const downloads = await filterTroves(troves, options.downloadFolder);
  console.log(
    `original: ${preFilteredDownloads} filtered: ${downloads.length}`
  );
  totalDownloads = downloads.length;
  bars.downloads = progress.create(downloads.length, 0, {
    file: 'Downloads',
  });
  createDownloadQueue(options.downloadLimit);
  createFileCheckQueue(options.downloadLimit);
  await Promise.all(downloads.map(download => downloadTroveItem(download)));

  await fileCheckQueue.onIdle();
  await downloadQueue.onIdle();

  progress.stop();
  await clean(options, downloads);
  console.log(
    `${colors.green(
      'Done!'
    )} Downloaded: ${countDownloads}, checked: ${countFileChecks}`
  );
}

async function ebooks() {
  const options = program.opts();
  authToken = options.authToken;
  checksumCache = loadChecksumCache(options.downloadFolder);
  const orderList = await getOrderList();
  const orderInfo = await getAllOrderInfo(orderList, options.concurrency);
  const downloads = await filterEbooks(orderInfo, options.downloadFolder);
  console.log(
      `original: ${preFilteredDownloads} filtered: ${downloads.length}`
  );
  totalDownloads = downloads.length;
  bars.downloads = progress.create(downloads.length, 0, {
    file: 'Downloads',
  });
  createDownloadQueue(options.downloadLimit);
  createFileCheckQueue(options.downloadLimit);
  await Promise.all(downloads.map(download => downloadItem(download)));

  await fileCheckQueue.onIdle();
  await downloadQueue.onIdle();

  progress.stop();
  await clean(options, downloads);
  console.log(
      `${colors.green(
          'Done!'
      )} Downloaded: ${countDownloads}, checked: ${countFileChecks}`
  );
}

async function cleanup() {
  const options = program.opts();
  authToken = options.authToken;
  checksumCache = loadChecksumCache(options.downloadFolder);
  const orderList = await getOrderList();
  const orderInfo = await getAllOrderInfo(orderList, options.concurrency);
  const downloads = await filterOrders(orderInfo, options.downloadFolder);
  console.log(
    `original: ${preFilteredDownloads} filtered: ${downloads.length}`
  );
  await clean(options, downloads);
  progress.stop();
}

async function cleanupEbooks() {
  const options = program.opts();
  authToken = options.authToken;
  checksumCache = loadChecksumCache(options.downloadFolder);
  const orderList = await getOrderList();
  const orderInfo = await getAllOrderInfo(orderList, options.concurrency);
  const downloads = await filterEbooks(orderInfo, options.downloadFolder);
  console.log(
    `original: ${preFilteredDownloads} filtered: ${downloads.length}`
  );
  await clean(options, downloads);
  progress.stop();
}

async function cleanupTrove() {
  const options = program.opts();
  authToken = options.authToken;
  checksumCache = loadChecksumCache(options.downloadFolder);
  const troves = await getAllTroveInfo();
  const downloads = await filterTroves(troves, options.downloadFolder);
  console.log(
    `original: ${preFilteredDownloads} filtered: ${downloads.length}`
  );
  await clean(options, downloads);
  progress.stop();
}

async function checksums() {
  const options = program.opts();
  authToken = options.authToken;
  checksumCache = loadChecksumCache(options.downloadFolder);
  createFileCheckQueue(options.downloadLimit);
  getExistingDownloads(options.downloadFolder).forEach(download => {
    fileCheckQueue.add(() => updateHash(download));
  });
  await fileCheckQueue.onIdle();
  progress.stop();
  console.log(`${colors.green('Updated:')} ${colors.blue(countFileChecks)}`);
}

(async function () {
  program
    .version(packageInfo.version)
    .requiredOption(
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
    .requiredOption(
      '-t, --auth-token <auth-token>',
      'You must specify your authentication cookie from your browser (_simpleauth_sess)'
    );

  program
    .command('all')
    .description('Download all available items')
    .action(all);
  program.command('trove').description('Download trove items').action(trove);
  program.command('ebooks').description('Download ebooks').action(ebooks);
  program.command('cleanup').description('Cleanup old files').action(cleanup);
  program
    .command('cleanuptrove')
    .description('Cleanup old files from trove')
    .action(cleanupTrove);
  program
    .command('cleanupebooks')
    .description('Cleanup old files from ebooks')
    .action(cleanupEbooks);
  program
    .command('checksums')
    .description('Update checksums')
    .action(checksums);

  console.log(colors.green('Starting...'));

  await program.parseAsync();
})();
