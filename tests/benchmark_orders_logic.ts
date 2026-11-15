import {
  Bundle,
  Download as BundleDownload,
  SubProduct,
} from "../types/bundle.ts";

const MOCK_BUNDLE_COUNT = 100;
const SUBPRODUCTS_PER_BUNDLE = 5;
const DOWNLOADS_PER_SUBPRODUCT = 3;

interface MockDownloadEntry {
  fileName: string;
  sha1: string;
  md5: string;
}

// Generate mock data
const bundles: Bundle[] = [];
for (let i = 0; i < MOCK_BUNDLE_COUNT; i++) {
  const subproducts: SubProduct[] = [];
  for (let j = 0; j < SUBPRODUCTS_PER_BUNDLE; j++) {
    const downloads: BundleDownload[] = [];
    for (let k = 0; k < DOWNLOADS_PER_SUBPRODUCT; k++) {
      downloads.push({
        desktop_app_only: false,
        machine_name: `dl_${i}_${j}_${k}`,
        options_dict: null,
        download_identifier: null,
        download_version_number: null,
        platform: "ebook" as BundleDownload["platform"],
        download_struct: [{
          url: { web: "http://example.com/file.epub", bittorrent: "" },
          sha1: `sha${i}-${j}-${k}`,
          md5: `md5${i}-${j}-${k}`,
          name: "epub",
          human_size: "1 KB",
          file_size: 1000,
        }],
      });
    }
    subproducts.push({
      machine_name: `p_${i}_${j}`,
      human_name: `Product ${i} ${j}`,
      downloads: downloads,
      payee: { human_name: "payee", machine_name: "payee" },
    } as unknown as SubProduct);
  }
  bundles.push({
    gamekey: `key_${i}`,
    created: new Date().toISOString(),
    product: { human_name: `Bundle ${i}`, machine_name: `bundle_${i}` },
    subproducts: subproducts,
  } as unknown as Bundle);
}

console.log(`Benchmarking filterBundles with ${MOCK_BUNDLE_COUNT} bundles.`);

// OLD ALG SIMULATION
const startOld = performance.now();
const downloadsOld: MockDownloadEntry[] = [];
let checksOld = 0;

for (const b of bundles) {
  for (const sp of b.subproducts) {
    for (const _dl of sp.downloads) {
      const mockDL: MockDownloadEntry = {
        fileName: `file_${b.gamekey}_${sp.machine_name}.epub`,
        sha1: "abc",
        md5: "def",
      };

      const isDuplicate = downloadsOld.some((elem) =>
        elem.fileName === mockDL.fileName ||
        (elem.sha1 === mockDL.sha1 && elem.md5 === mockDL.md5)
      );
      checksOld++;

      if (!isDuplicate) {
        downloadsOld.push(mockDL);
      }
    }
  }
}
const endOld = performance.now();
console.log(
  `Old Logic Simulation: ${
    (endOld - startOld).toFixed(2)
  }ms, ${downloadsOld.length} total items (${checksOld} checks).`,
);

// NEW ALG SIMULATION
const startNew = performance.now();
const downloadsNew: MockDownloadEntry[] = [];
const seenFileNames = new Set<string>();
const seenHashes = new Set<string>();

for (const b of bundles) {
  for (const sp of b.subproducts) {
    for (const _dl of sp.downloads) {
      const mockDL: MockDownloadEntry = {
        fileName: `file_${b.gamekey}_${sp.machine_name}.epub`,
        sha1: "abc",
        md5: "def",
      };

      const hashKey = `${mockDL.sha1}|${mockDL.md5}`;
      let isDuplicate = false;

      if (seenFileNames.has(mockDL.fileName) || seenHashes.has(hashKey)) {
        isDuplicate = true;
      }

      if (!isDuplicate) {
        downloadsNew.push(mockDL);
        seenFileNames.add(mockDL.fileName);
        seenHashes.add(hashKey);
      }
    }
  }
}
const endNew = performance.now();
console.log(
  `New Logic Simulation: ${
    (endNew - startNew).toFixed(2)
  }ms, ${downloadsNew.length} total items.`,
);
