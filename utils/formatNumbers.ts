import { format } from "@std/fmt/bytes";

export function formatPercentage(v: string) {
  return v.padStart(3);
}

export function formatFileSize(v: string, _options: unknown, variant: string) {
  switch (variant) {
    case "percentage":
      return formatPercentage(v);

    default:
      return format(parseInt(v, 10) || 0);
  }
}
