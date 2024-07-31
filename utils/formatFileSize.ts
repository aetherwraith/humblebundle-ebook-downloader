import prettyBytes from "pretty-bytes";

export function formatFileSize(v, options, type) {
  switch (type) {
    case "percentage":
      return v.padStart(3, options.autopaddingChar);

    default:
      return prettyBytes(v * 1 || 0, { minimumFractionDigits: 3 });
  }
}
