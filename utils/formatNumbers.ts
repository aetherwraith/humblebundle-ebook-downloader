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

export function formatTime(seconds: number): string {
  if (!isFinite(seconds) || isNaN(seconds)) {
    return "--:--";
  }
  
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (h > 0) {
     return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}
