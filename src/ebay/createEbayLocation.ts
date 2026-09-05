/**
 * createEbayLocation.ts — one-time setup script.
 *
 * eBay's Inventory API requires every offer to reference a
 * "merchant location" (essentially: where you ship from) that must exist
 * before you can call createOffer. This creates one. Run it once before
 * your first publishListing.ts call.
 *
 * Usage:
 *   npm run ebay-create-location -- --key=my-warehouse --line1="123 Main St" --city=Austin --state=TX --postal=78701 --country=US
 */
import "dotenv/config";
import { loadConfig, ConfigError } from "../config";
import { buildEbayClient } from "./ebayFactory";
import { EbayOAuthClient } from "./ebayAuth";

function parseArgs(argv: string[]) {
  const flags: Record<string, string> = {};
  for (const a of argv) {
    if (a.startsWith("--")) {
      const [key, value] = a.slice(2).split("=");
      flags[key] = value ?? "true";
    }
  }
  return flags;
}

async function run() {
  const flags = parseArgs(process.argv.slice(2));
  const required = ["key", "line1", "city", "postal", "country"];
  const missing = required.filter((k) => !flags[k]);
  if (missing.length > 0) {
    console.error(
      `Usage: npm run ebay-create-location -- --key=<locationKey> --line1="..." --city=... --state=... --postal=... --country=US\n` +
        `Missing: ${missing.join(", ")}`
    );
    process.exit(1);
  }

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`\n✗ ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  if (!config.ebayClientId || !config.ebayClientSecret || !config.ebayRefreshToken) {
    console.error("\n✗ eBay is not configured. Set EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_REFRESH_TOKEN in .env.\n");
    process.exit(1);
  }

  const auth = new EbayOAuthClient({
    clientId: config.ebayClientId,
    clientSecret: config.ebayClientSecret,
    refreshToken: config.ebayRefreshToken,
    environment: config.ebayEnvironment,
  });

  const baseUrl = config.ebayEnvironment === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
  const token = await auth.getAccessToken();

  const res = await fetch(`${baseUrl}/sell/inventory/v1/location/${encodeURIComponent(flags.key)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      location: {
        address: {
          addressLine1: flags.line1,
          city: flags.city,
          stateOrProvince: flags.state,
          postalCode: flags.postal,
          country: flags.country,
        },
      },
      locationTypes: ["WAREHOUSE"],
      name: flags.name || flags.key,
    }),
  });

  if (res.status === 204 || res.status === 201) {
    console.log(`\n✓ Location "${flags.key}" created (or already existed). Use this as --location in publishListing.ts.\n`);
  } else {
    const body = await res.text();
    console.error(`\n✗ Failed to create location (HTTP ${res.status}):\n${body}\n`);
    process.exit(1);
  }
}

run();
