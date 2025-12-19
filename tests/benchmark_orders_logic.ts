
import { DownloadInfo, Options } from "../types/general.ts";
import { Bundle, SubProduct, DownloadStruct } from "../types/bundle.ts";

const MOCK_BUNDLE_COUNT = 100;
const SUBPRODUCTS_PER_BUNDLE = 5;
const DOWNLOADS_PER_SUBPRODUCT = 3;

// Generate mock data
const bundles: Bundle[] = [];
for (let i = 0; i < MOCK_BUNDLE_COUNT; i++) {
    const subproducts: SubProduct[] = [];
    for (let j = 0; j < SUBPRODUCTS_PER_BUNDLE; j++) {
        const downloads: any[] = [];
        for (let k = 0; k < DOWNLOADS_PER_SUBPRODUCT; k++) {
            downloads.push({
                platform: "ebook",
                download_struct: [{
                    url: { web: "http://example.com/file.epub" },
                    sha1: `sha${i}-${j}-${k}`,
                    md5: `md5${i}-${j}-${k}`,
                    name: "epub",
                    file_size: 1000
                }]
            });
        }
        subproducts.push({
            machine_name: `p_${i}_${j}`,
            human_name: `Product ${i} ${j}`,
            downloads: downloads,
            payee: { human_name: "payee", machine_name: "payee" }
        } as unknown as SubProduct);
    }
    bundles.push({
        gamekey: `key_${i}`,
        created: new Date().toISOString(),
        product: { human_name: `Bundle ${i}`, machine_name: `bundle_${i}` },
        subproducts: subproducts
    } as unknown as Bundle);
}

const options: Options = {
    platform: ["ebook"],
    format: ["epub"],
    dedup: true,
    downloadFolder: "downloads",
    // other required options mocked
} as Options;

console.log(`Benchmarking filterBundles with ${MOCK_BUNDLE_COUNT} bundles.`);

// Simulate the heavy part of filterBundles: duplicate checking
const generatedDownloads: DownloadInfo[] = []; // This grows
// We'll simulate just the loop and duplicate check

// OLD ALG SIMULATION
// Ideally we would import `filterBundles` but we want to isolate the loop logic for clear comparison
// or just run the actual function if we can.
// Since `filterBundles` has side effects (logging, totals), let's simulate the core logic bottleneck.

const startOld = performance.now();
const downloadsOld: any[] = [];
let checksOld = 0;

for (const b of bundles) {
    for (const sp of b.subproducts) {
        for (const dl of sp.downloads) {
             // ... creation logic ...
             const mockDL = { fileName: `file_${b.gamekey}_${sp.machine_name}.epub`, sha1: "abc", md5: "def" };
             
             // The bottleneck:
             const isDuplicate = downloadsOld.some(elem => 
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
console.log(`Old Logic Simulation: ${(endOld - startOld).toFixed(2)}ms, ${downloadsOld.length} total items.`);


// NEW ALG SIMULATION
const startNew = performance.now();
const downloadsNew: any[] = [];
// Use sets for fast lookup
const seenFileNames = new Set<string>();
const seenHashes = new Set<string>(); 

for (const b of bundles) {
    for (const sp of b.subproducts) {
        for (const dl of sp.downloads) {
             const mockDL = { fileName: `file_${b.gamekey}_${sp.machine_name}.epub`, sha1: "abc", md5: "def" };
             
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
console.log(`New Logic Simulation: ${(endNew - startNew).toFixed(2)}ms, ${downloadsNew.length} total items.`);

