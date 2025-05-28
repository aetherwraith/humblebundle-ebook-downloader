import { format } from "@std/fmt/bytes";

/**
 * Format a percentage value by padding it to 3 characters
 */
export function formatPercentage(v: string): string {
  return v.padStart(3);
}

/**
 * Format a file size in bytes to a human-readable string
 */
export function formatBytes(bytes: number): string {
  return format(bytes);
}

/**
 * Format value based on variant
 */
export function formatFileSize(
  v: string,
  _options?: unknown,
  variant?: string,
): string {
  const numVal = parseInt(v, 10) || 0;

  switch (variant) {
    case "percentage":
      return formatPercentage(v);

    default:
      return formatBytes(numVal);
  }
}
