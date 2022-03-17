#!/usr/bin/env node

import PMap from 'p-map';
import PQueue from 'p-queue';
import http2 from 'http2';
import https from 'https';
import { program } from 'commander';
import colors from 'colors';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { createHash } from 'crypto';
import mkdirp from 'mkdirp';
import sanitizeFilename from 'sanitize-filename';
import path from 'path';
import cliProgress from 'cli-progress';

const packageInfo = JSON.parse(readFileSync('./package.json'));
const userAgent = `HumbleBundle-Ebook-Downloader/${packageInfo.version}`;

let authToken = '';

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

function myParseInt(value, dummyPrevious) {
  const parsedValue = parseInt(value, 10);
  if (isNaN(parsedValue)) {
    throw new commander.InvalidOptionArgumentError('Not a number.');
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
    checksumCache = JSON.parse(readFileSync(cacheFilePath));
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

async function getAllOrderInfo(gameKeys) {
  console.log(`Fetching order information for ${gameKeys.length} bundles`);
  return PMap(gameKeys, getOrderInfo, { concurrency: options.downloadLimit });
}

async function getOrderInfo(gameKey) {
  const client = http2.connect('https://www.humblebundle.com');

  const req = client.request({
    ...getRequestHeaders(),
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
      bars.bundles.increment();
      client.close();
      client.destroy();
      resolve();
    })
  );

  return JSON.parse(data);
}

async function fetchOrders() {
  console.log('Fetching bundles...');

  const client = http2.connect('https://www.humblebundle.com');

  const req = client.request({
    ...getRequestHeaders(authToken),
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
      client.close();
      client.destroy();
      resolve();
    })
  );
  return JSON.parse(data);
}

async function all() {
  console.log(program.opts());
  console.log('bob!');
}

async function trove() {
  console.log(program.opts());
  console.log('bob!');
}

async function ebooks() {
  console.log(program.opts());
  console.log('bob!');
}

async function cleanup() {
  console.log(program.opts());
  console.log('bob!');
}

async function checksums() {
  const options = program.opts();
  authToken = options.authToken;
  const checksumsCache = loadChecksumCache(options.downloadFolder);
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
    .option(
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
