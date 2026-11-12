import { format } from "@std/fmt/bytes";

/**
 * Formats percentage number to right-padded 3-character string.
 */
export function formatPercentage(v: string): string {
  return v.padStart(3);
}

/**
 * Formats a file size string in bytes into a human-readable size or percentage string.
 */
export function formatFileSize(
  v: string,
  _options: unknown,
  variant: string,
): string {
  switch (variant) {
    case "percentage":
      return formatPercentage(v);

    default:
      return format(parseInt(v, 10) || 0);
  }
}

/**
 * Formats seconds into HH:MM:SS or MM:SS format. Returns '--:--' for invalid values.
 */
export function formatTime(seconds: number): string {
  if (!isFinite(seconds) || isNaN(seconds)) {
    return "--:--";
  }

  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${
      s.toString().padStart(2, "0")
    }`;
  }
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}
