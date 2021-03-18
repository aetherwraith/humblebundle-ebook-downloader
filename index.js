#!/usr/bin/env node

const pMap = require('p-map');
const { default: pQueue } = require('p-queue');
const http2 = require('http2');
const https = require('https');
const commander = require('commander');
const packageInfo = require('./package.json');
const colors = require('colors');
const { existsSync } = require('fs');
const hasha = require('hasha');
const mkdirp = require('mkdirp');
const sanitizeFilename = require('sanitize-filename');
const path = require('path');
const { createWriteStream } = require('fs');
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
client.on('error', (err) => {
  client.close();
  console.error(err);
  process.exit(err);
});

let totalBundles = 0;
let doneBundles = 0;

let totalDownloads = 0;
let doneDownloads = 0;

const downloadQueue = new pQueue({ concurrency: options.downloadLimit });
const downloadPromises = [];

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
  return pMap(gameKeys, getOrderInfo, { concurrency: 5 });
}

async function getOrderInfo(gameKey) {
  const req = client.request({
    ...getRequestHeaders,
    ':path': `/api/v1/order/${gameKey.gamekey}?ajax=true`,
  });
  req.setEncoding('utf8');
  let data = '';
  req.on('data', (chunk) => {
    data += chunk;
  });
  req.end();

  await new Promise((resolve) =>
    req.on('close', () => {
      resolve();
    })
  );
  console.log(
    'Fetched bundle information... (%s/%s)',
    colors.yellow(++doneBundles),
    colors.yellow(totalBundles)
  );

  return JSON.parse(data);
}

async function fetchOrders() {
  console.log('Fetching bundles...');

  const req = client.request({
    ...getRequestHeaders,
    ':path': '/api/v1/user/order?ajax=true',
  });
  req.on('error', (err) => {
    req.close();
    client.close();
    console.error(err);
    process.exit(err);
  });
  req.setEncoding('utf8');
  let data = '';
  req.on('data', (chunk) => {
    data += chunk;
  });
  req.end();

  await new Promise((resolve) =>
    req.on('close', () => {
      resolve();
    })
  );

  return JSON.parse(data);
}

async function filterBundles(bundles) {
  return bundles.filter((bundle) =>
    bundle.subproducts.find((subproduct) =>
      subproduct.downloads.filter(
        (download) => download.platform.toLowerCase() === 'ebook'
      )
    )
  );
}

async function filterEbooks(ebookBundles) {
  // priority of format to download cbz -> epub -> pdf_hd -> pdf -> mobi
  console.log(
    `${colors.yellow(ebookBundles.length)} bundles containing ebooks`
  );
  const downloads = [];
  ebookBundles.forEach((bundle) => {
    let date = new Date(bundle.created);
    bundle.subproducts.forEach((subproduct) => {
      const filteredDownloads = subproduct.downloads.filter(
        (download) => download.platform.toLowerCase() === 'ebook'
      );
      SUPPORTED_FORMATS.forEach((format) => {
        filteredDownloads.forEach((download) =>
          download.download_struct.forEach((struct) => {
            if (
              struct.name &&
              struct.url &&
              normalizeFormat(struct.name) === format
            ) {
              const uploaded_at = new Date(struct.uploaded_at);
              if (uploaded_at > date) date = uploaded_at;
              const existing = downloads.find(
                (elem) => elem.name === subproduct.human_name
              );
              if (
                !existing ||
                (date > existing.date && struct.name === existing.download.name)
              ) {
                console.log(
                  `Adding: ${colors.yellow(
                    subproduct.human_name
                  )} in ${colors.yellow(normalizeFormat(struct.name))} ${
                    existing
                      ? `\n replacing ${existing.bundle}, ${existing.date} with ${bundle.product.human_name}, ${date}`
                      : ''
                  }`
                );
                downloads.push({
                  bundle: bundle.product.human_name,
                  download: struct,
                  name: subproduct.human_name,
                  date,
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

async function checkSignatureMatch(filePath, download) {
  if (existsSync(filePath)) {
    const algorithm = download.sha1 ? 'sha1' : 'md5';
    const hashToVerify = download[algorithm];
    const hash = await hasha.fromFile(filePath, { algorithm });
    return hash === hashToVerify;
  }
  return false;
}

async function doDownload(filePath, download) {
  console.log(
    'Downloading %s (%s) (%s)...',
    download.name,
    normalizeFormat(download.download.name),
    download.download.human_size
  );

  await new Promise((done) =>
    https.get(download.download.url.web, function (res) {
      res.pipe(createWriteStream(filePath));
      res.on('end', () => done());
    })
  );

  console.log(
    'Downloaded %s (%s) (%s)... (%s/%s)',
    download.name,
    normalizeFormat(download.download.name),
    download.download.human_size,
    colors.yellow(++doneDownloads),
    colors.yellow(totalDownloads)
  );
}

async function downloadEbook(download) {
  const downloadPath = path.resolve(
    options.downloadFolder,
    sanitizeFilename(normalizeFormat(download.download.name))
  );
  await mkdirp(downloadPath);

  const fileName = `${download.name.trim()}${getExtension(
    normalizeFormat(download.download.name)
  )}`;

  const filePath = path.resolve(downloadPath, sanitizeFilename(fileName));
  const fileExists = await checkSignatureMatch(filePath, download.download);

  if (!fileExists) {
    downloadPromises.push(
      downloadQueue.add(() => doDownload(filePath, download))
    );
  } else {
    console.log(
      'Skipped downloading of %s (%s) (%s) - already exists... (%s/%s)',
      download.name,
      normalizeFormat(download.download.name),
      download.download.human_size,
      colors.yellow(++doneDownloads),
      colors.yellow(totalDownloads)
    );
  }
}

async function downloadEbooks(downloads) {
  console.log(`Downloading ${downloads.length} ebooks`);
  return pMap(downloads, downloadEbook, { concurrency: 5 });
}

(async function () {
  const gameKeys = await fetchOrders();
  totalBundles = gameKeys.length;
  const bundles = await getAllOrderInfo(gameKeys);
  const ebookBundles = await filterBundles(bundles);
  const downloads = await filterEbooks(ebookBundles);
  downloads.sort((a, b) => a.name.localeCompare(b.name));
  totalDownloads = downloads.length;
  await downloadEbooks(downloads);
  await Promise.all(downloadPromises);
  console.log(colors.green('Done!'));
  await client.close();
})();
