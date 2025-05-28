/**
 * Normalize format string to a standard value
 */
export function normalizeFormat(format: string): string {
  switch (format.toLowerCase()) {
    case ".cbz":
      return "cbz";
    case "pdf (hq)":
    case "pdf (hd)":
      return "pdf_hd";
    case "download":
      return "pdf";
    default:
      return format.toLowerCase();
  }
}

/**
 * Get file extension based on format
 */
export function getExtension(format: string): string {
  switch (format.toLowerCase()) {
    case "pdf_hd":
      return ".hd.pdf";
    default:
      return `.${format}`;
  }
}
