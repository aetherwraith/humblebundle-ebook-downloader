#!/usr/bin/env node

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
  accept: 'application/json',
  'Accept-Charset': 'utf-8',
  'User-Agent': userAgent,
  cookie: `_simpleauth_sess="${options.authToken.replace(/^"|"$/g, '')}";`,
};

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

async function getAllTroveInfo() {
  const client = http2.connect('https://www.humblebundle.com');
  client.on('error', err => {
    client.close();
    console.error(err);
    process.exit(err);
  });
  var page = 0;
  var done = false;
  var troveData = [];
  while (!done) {
    const req = client.request({
      ...getRequestHeaders,
      ':path': `/api/v1/trove/chunk?property=start&direction=desc&index=${page}`,
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
  return troveData;
}

async function getTroveDownloadUrl(download) {
  const client = http2.connect('https://www.humblebundle.com');
  client.on('error', err => {
    client.close();
    console.error(err);
    process.exit(err);
  });

  const req = client.request({
    cookie: `_simpleauth_sess="${options.authToken.replace(/^"|"$/g, '')}";`,
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
  const parsed = JSON.parse(data);
  return parsed.signed_url;
}

async function filterTroves(troves) {
  console.log(
    `${colors.yellow(troves.length)} bundles containing downloadable items`
  );
  let downloads = [];
  troves.forEach(trove => {
    Object.values(trove.downloads).forEach(download => {
      if (download.url) {
        const fileName = path.basename(download.url.web);
        const cacheKey = path.join(
          sanitizeFilename(trove['human-name']),
          sanitizeFilename(fileName)
        );
        const existing = downloads.find(elem => elem.cacheKey === cacheKey);
        if (!existing) {
          downloads.push({
            download: download,
            name: trove['human-name'],
            cacheKey,
          });
        }
      }
    });
  });

  return downloads;
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
  const url = await getTroveDownloadUrl(download);
  await new Promise(done =>
    https.get(url, function (res) {
      const size = Number(res.headers['content-length']);
      var got = 0;
      bars[filePath] = progress.create(100, 0, {
        file: filePath,
      });
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

async function downloadItem(download) {
  const downloadPath = path.resolve(
    options.downloadFolder,
    sanitizeFilename(download.name)
  );

  await mkdirp(downloadPath);
  const fileName = path.basename(download.download.url.web);

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
    const trove = await getAllTroveInfo();
    const downloads = await filterTroves(trove);
    downloads.sort((a, b) => a.name.localeCompare(b.name));
    totalDownloads = downloads.length;
    bars.checkq = progress.create(0, 0, { file: 'File Check Queue' });
    if (options.checksumsUpdate) {
      console.log('Updating checksums');
      downloads.forEach(async download => {
        const downloadPath = path.resolve(
          options.downloadFolder,
          sanitizeFilename(download.name)
        );

        const fileName = path.basename(download.download.url.web);
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
  }
})();
