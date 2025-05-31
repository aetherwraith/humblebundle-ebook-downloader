import { assertType } from "@std/testing/types";
import { assertEquals } from "@std/assert";
import { Trove, TrovePlatform } from "../../types/trove.ts";

Deno.test("Trove type structure validation", () => {
  // Create a minimal valid Trove object
  const trove: Trove = {
    machine_name: "test_trove",
    "hero-marketing-blurb": null,
    "hero-background-image": null,
    image: "https://example.com/image.jpg",
    "human-name": "Test Trove",
    logo: null,
    "all-access": true,
    "trove-showcase-css": null,
    "youtube-link": null,
    "humble-original": false,
    developers: [
      {
        "developer-name": "Test Developer",
        "developer-url": "https://developer.example.com",
      },
    ],
    "background-color": null,
    "marketing-blurb": "Test marketing blurb",
    publishers: [
      {
        "publisher-name": "Test Publisher",
        "publisher-url": "https://publisher.example.com",
      },
    ],
    downloads: {
      windows: {
        uploaded_at: 1609459200,
        name: "Test Game",
        url: {
          web: "https://example.com/download",
          bittorrent: "magnet:?xt=urn:btih:test",
        },
        timestamp: 1609459200,
        machine_name: "test_game_windows",
        file_size: 1024000,
        small: 0,
        size: "1 MB",
        md5: "abcdef1234567890",
      },
    },
    "description-text": "Game description",
    "date-added": 1609459200,
    "background-image": null,
    popularity: 100,
    "hero-character-image": null,
    "hero-game-logo": null,
    "carousel-content": {
      thumbnail: ["https://example.com/thumbnail.jpg"],
      screenshot: ["https://example.com/screenshot.jpg"],
    },
    "date-ended": 1640995200,
    trove_category: "game",
    "is-client-hero": null,
  };

  // Test that the object conforms to the Trove type
  assertType<Trove>(trove);

  // Test TrovePlatform enum values
  assertEquals(TrovePlatform.Windows, "windows");
  assertEquals(TrovePlatform.MAC, "mac");
  assertEquals(TrovePlatform.Linux, "linux");
});
