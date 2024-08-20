import { format } from "@std/fmt/bytes";

export function formatPercentage(v: string) {
  return v.padStart(3);
}

export function formatBytes(v: number) {
  return format(v);
}

export function formatFileSize(v: string, _options: unknown, variant: string) {
  switch (variant) {
    case "percentage":
      return formatPercentage(v);

    default:
      return formatBytes(parseInt(v, 10) || 0);
  }
}
