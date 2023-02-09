import {createRequire} from "node:module";
import http2 from "node:http2";

const require = createRequire(import.meta.url);
const { version } = require('./package.json');

const { HTTP2_HEADER_PATH, HTTP2_HEADER_STATUS, HTTP2_HEADER_METHOD, HTTP2_METHOD_GET } = http2.constants;
const userAgent = `HumbleBundle-Ebook-Downloader/${version}`;
const client = http2.connect('https://www.humblebundle.com');

export function getRequestHeaders(authToken) {
    return {
        Accept: 'application/json',
        'Accept-Charset': 'utf-8',
        'User-Agent': userAgent,
        Cookie: `_simpleauth_sess="${authToken.replace(/^"|"$/g, '')}";`,
    };
}

export async function fetch(urlPath, authToken, method= HTTP2_METHOD_GET) {
    return new Promise((resolve, reject) => {

        const req = client.request({
            ...getRequestHeaders(authToken),
            HTTP2_HEADER_PATH: urlPath,
            HTTP2_HEADER_METHOD: method,
        });
        req.on('response', headers => {
            console.log({headers});
            if (headers[HTTP2_HEADER_STATUS] !== 200)
                reject('Check your cookie!');

            let data = '';
            req.on('error', err => {
                req.close();
                reject(err);
            });
            req.setEncoding('utf8');
            req.on('data', chunk => {
                data += chunk;
            });
            req.on('close', () => {
                resolve(JSON.parse(data));
            });
        });
    });
}
