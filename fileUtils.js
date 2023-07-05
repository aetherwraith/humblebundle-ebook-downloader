import path from "node:path";
import sanitizeFilename from "sanitize-filename";
import {readFile} from "node:fs/promises";

export async function readJsonFile(folder, file, ignoreError = true) {
    const filePath = path.resolve(folder, sanitizeFilename(file));

    return JSON.parse(await readFile(filePath, {encoding: 'utf8'}).catch((err) => {
        if (!ignoreError) console.log(`Error reading file ${err}`)
    }));

}
