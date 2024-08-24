export function normalizeFormat(format:string) {
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
