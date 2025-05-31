import { assertEquals } from "@std/assert";
import { assertType } from "@std/testing/types";
import { Bundle, Currency, Category, Platform } from "../../types/bundle.ts";

Deno.test("Bundle type structure validation", () => {
  // Create a minimal valid Bundle object
  const bundle: Bundle = {
    amount_spent: 10.99,
    product: {
      category: Category.Bundle,
      machine_name: "test_bundle",
      empty_tpkds: {},
      post_purchase_text: "Thank you for your purchase",
      human_name: "Test Bundle",
      partial_gift_enabled: false,
    },
    gamekey: "abcdef123456",
    uid: "user123",
    created: "2023-01-01T12:00:00Z",
    missed_credit: null,
    subproducts: [],
    total_choices: 0,
    choices_remaining: 0,
    currency: Currency.Usd,
    is_giftee: false,
    claimed: true,
    total: 10.99,
    path_ids: ["path1", "path2"],
  };

  // Test that the object conforms to the Bundle type
  assertType<Bundle>(bundle);

  // Test enum values
  assertEquals(Currency.Usd, "USD");
  assertEquals(Currency.Gbp, "GBP");
  assertEquals(Category.Bundle, "bundle");
  assertEquals(Category.Storefront, "storefront");
  assertEquals(Platform.Windows, "windows");
  assertEquals(Platform.MAC, "mac");
});
