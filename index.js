#!/usr/bin/env node

import { basename, join, resolve } from 'node:path';
import PMap from 'p-map';
import PQueue from 'p-queue';
import http2 from 'node:http2';
import colors from 'colors';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdirp, mkdirpSync } from 'mkdirp';
import sanitizeFilename from 'sanitize-filename';
import cliProgress from 'cli-progress';
import { createHash } from 'node:crypto';
import url from 'node:url';
import readline from 'node:readline';
import { Command } from 'commander';

const {
  HTTP2_HEADER_PATH,
  HTTP2_HEADER_STATUS,
} = http2.constants;

const program = new Command();

const packageInfo = JSON.parse(
  readFileSync('./package.json', { encoding: 'utf8' })
);
const userAgent = `HumbleBundle-Ebook-Downloader/${packageInfo.version}`;
const SUPPORTED_FORMATS = ['cbz', 'epub', 'pdf_hd', 'pdf', 'mobi'];
const formatsFileName = 'formats.json';
const dedupFileName = 'dedup.json';
const bundleFoldersFileName = 'bundleFolders.json';

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
    program.error(`${value} is not a number.`);
  }
  return parsedValue;
}

function myParseArray(value, dummyPrevious) {
  const parsedValue = value.split(',');
  if (!parsedValue.every(format => SUPPORTED_FORMATS.includes(format))) {
    program.error(
      `${value} contains one or more invalid formats. Supported formats are ${SUPPORTED_FORMATS.join(
        ','
      )}`
    );
  }
  return parsedValue;
}

function loadChecksumCache(downloadFolder) {
  // load cache file of checksums
  const cacheFileName = 'checksums.json';
  const cacheFilePath = resolve(
    downloadFolder,
    sanitizeFilename(cacheFileName)
  );
  checksumCache = {};
  if (!existsSync(cacheFilePath)) {
    mkdirpSync(downloadFolder);
    writeFileSync(cacheFilePath, JSON.stringify(checksumCache));
  } else {
    console.log('exists')
    checksumCache = JSON.parse(
      readFileSync(cacheFilePath, { encoding: 'utf8' })
    );
  }

  function exitHandler(bob) {
    console.log({bob});
    writeFileSync(cacheFilePath, JSON.stringify(checksumCache));
    progress.stop();
    program.error('Something bad happened');
  }

  process.on('SIGINT', exitHandler('sigint'));

  process.on('exit', exitHandler('exit'));

  console.log(
    `${colors.green(Object.keys(checksumCache).length)} checksums loaded`
  );
  return checksumCache;
}

function loadDedupStatus(options) {
  const dedupFilePath = resolve(
    options.downloadFolder,
    sanitizeFilename(dedupFileName)
  );
  if (!existsSync(dedupFilePath)) {
    writeFileSync(dedupFilePath, JSON.stringify(options.dedup));
    return options.dedup;
  } else {
    return JSON.parse(readFileSync(dedupFilePath, { encoding: 'utf8' }));
  }
}

function writeDedupFile(options) {
  const dedupFilePath = resolve(
    options.downloadFolder,
    sanitizeFilename(dedupFileName)
  );

  writeFileSync(dedupFilePath, JSON.stringify(options.dedup));
}

async function checkDedupStatus(options) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const prompt = query => new Promise(resolve => rl.question(query, resolve));

  const dedup = loadDedupStatus(options);
  if (options.dedup !== dedup) {
    console.log(`Dedup option differs from saved: ${options.dedup} | ${dedup}`);
    const useNewDedup = await prompt('Use new dedup setting (Y/N)?');
    if (useNewDedup.toLowerCase() === 'y') {
      writeDedupFile(options);
    } else {
      options.dedup = dedup;
    }
  }
  rl.close();
}

function loadbundleFoldersStatus(options) {
  const bundleFoldersFilePath = resolve(
    options.downloadFolder,
    sanitizeFilename(bundleFoldersFileName)
  );
  if (!existsSync(bundleFoldersFilePath)) {
    writeFileSync(bundleFoldersFilePath, JSON.stringify(options.bundleFolders));
    return options.bundleFolders;
  } else {
    return JSON.parse(
      readFileSync(bundleFoldersFilePath, { encoding: 'utf8' })
    );
  }
}

function writebundleFoldersFile(options) {
  const bundleFoldersFilePath = resolve(
    options.downloadFolder,
    sanitizeFilename(bundleFoldersFileName)
  );

  writeFileSync(bundleFoldersFilePath, JSON.stringify(options.bundleFolders));
}

async function checkbundleFoldersStatus(options) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const prompt = query => new Promise(resolve => rl.question(query, resolve));

  const bundleFoldersStatus = loadbundleFoldersStatus(options);
  if (options.bundleFolders !== bundleFoldersStatus) {
    console.log(
      `Bundle folder option differs from saved: ${options.bundleFolders} | ${bundleFoldersStatus}`
    );
    const useNewbundleFolders = await prompt(
      'Use new bundle folder setting (Y/N)?'
    );
    if (useNewbundleFolders.toLowerCase() === 'y') {
      writebundleFoldersFile(options);
    } else {
      options.bundleFolders = bundleFoldersStatus;
    }
  }
  rl.close();
}

function loadFormats(options, formats) {
  const formatsFilePath = resolve(
    options.downloadFolder,
    sanitizeFilename(formatsFileName)
  );

  if (!existsSync(formatsFilePath)) {
    if (!formats) {
      formats = SUPPORTED_FORMATS;
    }
    writeFileSync(formatsFilePath, JSON.stringify(formats));
  } else {
    formats = JSON.parse(readFileSync(formatsFilePath, { encoding: 'utf8' }));
  }
  return formats;
}

function writeFormatsFile(options, formats) {
  const formatsFilePath = resolve(
    options.downloadFolder,
    sanitizeFilename(formatsFileName)
  );
  writeFileSync(formatsFilePath, JSON.stringify(formats));
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
      return '.hd.pdf';
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
  join(pathSegment, location);

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
    .filter(file => !file.includes('.json'))
    .map(file => {
      let cacheKey = file.replace(downloadFolder, '');
      if (cacheKey.startsWith('/')) {
        cacheKey = cacheKey.substring(1);
      }
      return { filePath: file, cacheKey };
    });

async function fetchOrder(urlPath) {
  return new Promise((resolve, reject) =>{
  const client = http2.connect('https://www.humblebundle.com');

  const req = client.request({
    ...getRequestHeaders(),
    ':path': urlPath,
  });
  req.on('response', headers => {
    console.log({ headers });
    console.log(headers[HTTP2_HEADER_STATUS]);
    if (headers[HTTP2_HEADER_STATUS] !== 200) program.error('Check your cookie!');

    let data = '';
    req.on('error', err => {
      req.close();
      client.close();
      client.destroy();
      program.error(err);
    });
    req.setEncoding('utf8');
    req.on('data', chunk => {
      data += chunk;
    });
    req.on('close', () => {
      client.close();
      client.destroy();
      resolve(JSON.parse(data));
    })

  });
  })
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

async function filterOrders(orders, downloadFolder, dedup, bundleFolders) {
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
            const fileName = sanitizeFilename(basename(url.pathname));
            const cacheKey = join(
              sanitizeFilename(order.product.human_name),
              sanitizeFilename(subproduct.human_name),
              fileName
            );
            const downloadPath = resolve(
              downloadFolder,
              bundleFolders ? sanitizeFilename(order.product.human_name) : '',
              sanitizeFilename(subproduct.human_name)
            );
            const filePath = resolve(downloadPath, fileName);

            let existing = false;
            if (dedup) {
              existing = downloads.some(elem => {
                return (
                  elem.cacheKey === cacheKey ||
                  (struct.sha1 && struct.sha1 === elem.sha1) ||
                  (struct.md5 && struct.md5 === elem.md5)
                );
              });
            }
            if (!existing) {
              if (!downloads.some(elem => elem.filePath === filePath)) {
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
                console.log(`Potential duplicate purchase ${cacheKey}`);
              }
            } else {
              console.log(`Potential duplicate purchase ${cacheKey}`);
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
    program.error(err);
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
      program.error(err);
    });

    await new Promise(resolve =>
      req.on('close', () => {
        resolve();
      })
    );
    if (data.includes('Unauthorized')) program.error('Check your cookie');
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
    program.error(err);
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
    program.error(err);
  });

  await new Promise(resolve =>
    req.on('close', () => {
      resolve();
    })
  );

  await client.close();
  await client.destroy();
  if (data.includes('Unauthorized')) program.error('Check your cookie');
  const parsed = JSON.parse(data);
  return parsed.signed_url;
}

async function filterTroves(troves, downloadFolder, dedup) {
  console.log(
    `${colors.yellow(troves.length)} bundles containing downloadable items`
  );
  let downloads = [];
  troves.forEach(trovey => {
    Object.values(trovey.downloads).forEach(download => {
      if (download.url) {
        preFilteredDownloads++;
        const fileName = basename(download.url.web);
        const cacheKey = join(
          sanitizeFilename(trovey['human-name']),
          sanitizeFilename(fileName)
        );
        const downloadPath = resolve(
          downloadFolder,
          sanitizeFilename(trovey['human-name'])
        );
        const filePath = resolve(downloadPath, fileName);
        let existing = false;
        if (dedup) {
          existing = downloads.some(
            elem =>
              elem.cacheKey === cacheKey ||
              (download.sha1 && download.sha1 === elem.sha1) ||
              (download.md5 && download.md5 === elem.md5)
          );
        }
        if (!existing) {
          if (!downloads.some(elem => elem.filePath === filePath)) {
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
          } else {
            console.log(`Potential duplicate purchase ${cacheKey}`);
          }
        } else {
          console.log(`Potential duplicate purchase ${cacheKey}`);
        }
      }
    });
  });

  return downloads.sort((a, b) => a.name.localeCompare(b.name));
}

async function filterEbooks(
  ebookBundles,
  downloadFolder,
  formats,
  dedup,
  bundleFolders
) {
  // priority of format to download cbz -> epub -> pdf_hd -> pdf -> mobi
  console.log(
    `${colors.yellow(ebookBundles.length)} bundles containing ebooks`
  );
  let downloads = [];
  ebookBundles.forEach(bundle => {
    let date = new Date(bundle.created);
    bundle.subproducts.forEach(subproduct => {
      const filteredDownloads = subproduct.downloads;
      formats.forEach(format => {
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
              preFilteredDownloads++;
              const uploaded_at = new Date(struct.uploaded_at);
              if (uploaded_at > date) date = uploaded_at;
              // TODO: check hash matches too
              let existing;
              if (dedup) {
                existing = downloads.find(
                  elem => elem.machineName === subproduct.machine_name
                );
              }
              if (
                !existing ||
                (date > existing.date && struct.name === existing.structName)
              ) {
                if (existing) {
                  downloads = downloads.filter(
                    elem => elem.machineName !== existing.machineName
                  );
                }
                const downloadPath = resolve(
                  downloadFolder,
                  bundleFolders
                    ? sanitizeFilename(bundle.product.human_name)
                    : '',
                  sanitizeFilename(subproduct.human_name)
                );
                const url = new URL(struct.url.web);
                const fileName = `${subproduct.machine_name}${getExtension(
                  normalizeFormat(struct.name)
                )}`;
                const filePath = resolve(
                  downloadPath,
                  sanitizeFilename(fileName)
                );
                const cacheKey = join(
                  sanitizeFilename(bundle.product.human_name),
                  sanitizeFilename(fileName)
                );
                if (!downloads.some(elem => elem.filePath === filePath)) {
                  // in case we have duplicate purchases check the cacheKey for uniqueness
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
                    machineName: subproduct.machine_name,
                    structName: struct.name,
                  });
                } else {
                  console.log(`Potential duplicate purchase ${cacheKey}`);
                }
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

    console.log({ url: download.url });

    const client = http2.connect(download.url);

    const req = client.request({
      ':path': `${download.url.pathname}${download.url.search}`,
    });

    req.on('response', headers => {
      console.log({ headers });
      console.log(headers[HTTP2_HEADER_STATUS]);
      const size = Number(headers['content-length']);
      let got = 0;
      let shasum = createHash('sha1');
      let md5sum = createHash('md5');
      bars[download.cacheKey] = progress.create(size, 0, {
        file: colors.green(download.cacheKey),
      });
      req.on('data', data => {
        shasum.update(data);
        md5sum.update(data);
        got += Buffer.byteLength(data);
        bars[download.cacheKey].increment(Buffer.byteLength(data));
      });
      req.pipe(createWriteStream(download.filePath));
      req.on('end', () => {
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
      req.on('error', () => handleDownloadError(req));
    });
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
  let removedFiles = 0;
  existingDownloads.forEach(existingDownload => {
    if (
      !downloads.some(
        download => existingDownload.filePath === download.filePath
      )
    ) {
      console.log(`Deleting extra file: ${existingDownload.cacheKey}`);
      removedFiles += 1;
      unlinkSync(existingDownload.filePath);
    }
  });
  console.log('Removing empty folders');
  cleanupEmptyFolders(options.downloadFolder);
  console.log('Removing checksums from cache');
  let removedChecksums = 0;
  Object.keys(checksumCache).forEach(cacheKey => {
    if (!downloads.some(download => cacheKey === download.cacheKey)) {
      console.log(`Removing checksum from cache: ${cacheKey}`);
      removedChecksums += 1;
      delete checksumCache[cacheKey];
    }
  });
  console.log(
    `Removed ${colors.yellow(removedFiles)} files and ${colors.yellow(
      removedChecksums
    )} checksums`
  );
}

async function all() {
  const options = program.opts();
  console.log({options});
  await checkDedupStatus(options);
  await checkbundleFoldersStatus(options);
  authToken = options.authToken;
  checksumCache = loadChecksumCache(options.downloadFolder);
  console.log(2);
  const orderList = await getOrderList();
  const orderInfo = await getAllOrderInfo(orderList, options.concurrency);
  const downloads = await filterOrders(
    orderInfo,
    options.downloadFolder,
    options.dedup,
    options.bundleFolders
  );
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
  await checkDedupStatus(options);
  authToken = options.authToken;
  checksumCache = loadChecksumCache(options.downloadFolder);
  const troves = await getAllTroveInfo();
  const downloads = await filterTroves(
    troves,
    options.downloadFolder,
    options.dedup
  );
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

async function ebooks(formats) {
  const options = program.opts();
  authToken = options.authToken;
  checksumCache = loadChecksumCache(options.downloadFolder);

  await checkDedupStatus(options);

  await checkbundleFoldersStatus(options);

  const loadedFormats = loadFormats(options, formats);
  if (
    (formats &&
      formats.length !== loadedFormats.length &&
      !formats.every(v => loadedFormats.includes(v))) ||
    (!formats &&
      loadedFormats.length !== SUPPORTED_FORMATS.length &&
      !loadedFormats.every(v => SUPPORTED_FORMATS.includes(v)))
  ) {
    console.log(
      `Loaded formats differ from saved: ${formats} | ${loadedFormats}`
    );
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const prompt = query => new Promise(resolve => rl.question(query, resolve));
    const useNewFormats = await prompt('Use new formats (Y/N)?');
    rl.close();
    if (useNewFormats.toLowerCase() === 'y') {
      writeFormatsFile(options, formats);
    }
  } else {
    formats = loadedFormats;
  }

  const orderList = await getOrderList();
  const orderInfo = await getAllOrderInfo(orderList, options.concurrency);
  const downloads = await filterEbooks(
    orderInfo,
    options.downloadFolder,
    formats,
    options.dedup,
    options.bundleFolders
  );
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
  const dedup = loadDedupStatus(options);
  const bundleFolders = loadbundleFoldersStatus(options);

  const orderList = await getOrderList();
  const orderInfo = await getAllOrderInfo(orderList, options.concurrency);
  const downloads = await filterOrders(
    orderInfo,
    options.downloadFolder,
    dedup,
    bundleFolders
  );
  console.log(
    `original: ${preFilteredDownloads} filtered: ${downloads.length}`
  );
  await clean(options, downloads);
  progress.stop();
}

async function cleanupEbooks() {
  const options = program.opts();
  const dedup = loadDedupStatus(options);
  const bundleFolders = loadbundleFoldersStatus(options);

  const formatsFilePath = resolve(
    options.downloadFolder,
    sanitizeFilename(formatsFileName)
  );
  let formats;
  if (!existsSync(formatsFilePath)) {
    writeFileSync(formatsFilePath, JSON.stringify(SUPPORTED_FORMATS));
    formats = SUPPORTED_FORMATS;
  } else {
    formats = JSON.parse(readFileSync(formatsFilePath, { encoding: 'utf8' }));
  }

  authToken = options.authToken;
  checksumCache = loadChecksumCache(options.downloadFolder);
  const orderList = await getOrderList();
  const orderInfo = await getAllOrderInfo(orderList, options.concurrency);
  const downloads = await filterEbooks(
    orderInfo,
    options.downloadFolder,
    formats,
    dedup,
    bundleFolders
  );
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
  const dedup = loadDedupStatus(options);

  const troves = await getAllTroveInfo();
  const downloads = await filterTroves(troves, options.downloadFolder, dedup);
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

export const cleanupEmptyFolders = (folder, exclude = ['node_modules']) => {
  if (!statSync(folder).isDirectory()) return;

  const folderName = basename(folder);
  if (exclude && exclude.includes(folderName)) {
    console.log(`skipping: ${folderName}`);
    return;
  }

  let files = readdirSync(folder);

  if (files.length > 0) {
    files.forEach(file => cleanupEmptyFolders(join(folder, file), exclude));
    // Re-evaluate files; after deleting sub-folders we may have an empty parent folder now.
    files = readdirSync(folder);
  }

  if (files.length === 0) {
    console.log(`removing: ${folder}`);
    rmdirSync(folder);
  }
};

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
    )
    .option('--no-dedup', 'Do not dedup the downloads')
    .option(
      '--no-bundle-folders',
      'Do not arrange downloads in bundle folders'
    );

  program
    .command('all')
    .description('Download all available items')
    .action(all);
  program.command('trove').description('Download trove items').action(trove);
  program
    .command('ebooks')
    .description('Download ebooks')
    .argument(
      '[formats]',
      'Format(s) to download separated by ",". Will prioritise in the order given, i.e. if you say "cbz,pdf" will download cbz format or pdf if cbz does not exist, unless --no-dedup is specified.',
      myParseArray
    )
    .action(ebooks);
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
