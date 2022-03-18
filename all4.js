#!/usr/bin/env node

import PMap from 'p-map';
import PQueue from 'p-queue';
import http2 from 'http2';
import { program } from 'commander';
import colors from 'colors';
import {
  createReadStream,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'fs';
import mkdirp from 'mkdirp';
import sanitizeFilename from 'sanitize-filename';
import path from 'path';
import cliProgress from 'cli-progress';
import { createHash } from 'crypto';

const packageInfo = JSON.parse(
  readFileSync('./package.json', { encoding: 'utf8' })
);
const userAgent = `HumbleBundle-Ebook-Downloader/${packageInfo.version}`;

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

  let checksumCache = {};
  if (!existsSync(cacheFilePath)) {
    mkdirp(downloadFolder);
    writeFileSync(cacheFilePath, JSON.stringify(checksumCache));
  } else {
    checksumCache = JSON.parse(
      readFileSync(cacheFilePath, { encoding: 'utf8' })
    );
  }

  process.on('SIGINT', () => {
    writeFileSync(cacheFilePath, JSON.stringify(checksumCache));
  });

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

function createFileCheckQueue(concurrency) {
  fileCheckQueue = new PQueue({ concurrency });

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
    if (chunk.includes('error')) {
      throw Error(chunk);
    }
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
      bars[bundlesBar].stop();
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

async function all() {
  console.log(program.opts());
  console.log('all!');
}

async function trove() {
  console.log(program.opts());
  console.log('trove!');
}

async function ebooks() {
  console.log(program.opts());
  console.log('ebooks!');
}

async function cleanup() {
  console.log(program.opts());
  console.log('cleanup!');
}

async function checksums() {
  const options = program.opts();
  authToken = options.authToken;
  checksumCache = loadChecksumCache(options.downloadFolder);
  createFileCheckQueue(options.downloadLimit);
  console.log(readdirRecursive(options.downloadFolder));
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
    .command('checksums')
    .description('Update checksums')
    .action(checksums);

  console.log(colors.green('Starting...'));

  await program.parseAsync();
})();
