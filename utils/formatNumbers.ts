import { format } from "@std/fmt/bytes";

export function formatPercentage(v: string) {
  return v.padStart(3);
}

export function formatBytes(v: number) {
  return format(v);
}
