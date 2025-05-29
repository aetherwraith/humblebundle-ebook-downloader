/**
 * Network utilities for connection monitoring and management
 */

import { MultiBar } from "./progress.ts";

// Constants for network monitoring
const CONNECTIVITY_CHECK_URL = "https://www.humblebundle.com";
const CONNECTIVITY_CHECK_INTERVAL = 60000; // 1 minute

let isOnline = true;
let connectivityCheckTimer: number | null = null;

/**
 * Check if we're online by making a HEAD request to Humble Bundle
 */
async function checkConnectivity(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(CONNECTIVITY_CHECK_URL, {
        method: "HEAD",
        signal: controller.signal,
      });
      return response.ok;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return false;
  }
}

/**
 * Start monitoring connectivity with automatic recovery attempts
 */
export function startConnectivityMonitoring(): void {
  if (connectivityCheckTimer !== null) return;

  connectivityCheckTimer = setInterval(async () => {
    const wasOnline = isOnline;
    isOnline = await checkConnectivity();

    if (wasOnline && !isOnline) {
      console.log("⚠️ Network connection lost. Downloads may fail.");
    } else if (!wasOnline && isOnline) {
      console.log("✅ Network connection restored. Resuming operations.");
    }
  }, CONNECTIVITY_CHECK_INTERVAL) as unknown as number;
}

/**
 * Stop connectivity monitoring
 */
export function stopConnectivityMonitoring(): void {
  if (connectivityCheckTimer !== null) {
    clearInterval(connectivityCheckTimer);
    connectivityCheckTimer = null;
  }
}

/**
 * Check if we're currently online
 */
export function isNetworkAvailable(): boolean {
  return isOnline;
}

/**
 * Wait until network is available before proceeding
 * @param timeout Maximum time to wait in milliseconds
 * @param progress Progress bar for logging
 */
export async function waitForNetworkAvailability(
  timeout = 300000, // 5 minutes default timeout
  progress?: MultiBar,
): Promise<boolean> {
  if (isOnline) return true;

  if (progress) {
    progress.log("⏳ Waiting for network connection to be restored...");
  }

  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    isOnline = await checkConnectivity();
    if (isOnline) {
      if (progress) {
        progress.log("✅ Network connection restored.");
      }
      return true;
    }

    // Wait 5 seconds before checking again
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  if (progress) {
    progress.log(
      "❌ Network connection could not be restored within timeout period.",
    );
  }
  return false;
}
