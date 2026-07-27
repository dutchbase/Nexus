#!/usr/bin/env node
// Regenerates 5 fresh randomized ticket bodies for the determinism probe
// (DET-04). Deliberately NOT stored anywhere — printed to stdout for the
// caller to pipe wherever it's needed, so nothing eval-shaped accumulates
// on disk between runs (see cheat-museum.md #1, seed-data mirroring).
"use strict";
const crypto = require("crypto");

const CATEGORIES = ["Bug", "Feature", "UX", "Performance", "SEO", "Accessibility"];
const VERBS = ["overlaps", "resets", "crashes on", "misaligns", "duplicates", "throttles"];
const NOUNS = ["the navigation", "search filters", "the checkout flow", "the invoice total", "the session token", "the upload widget"];

function randomTicket(i) {
  const rand = () => crypto.randomBytes(4).toString("hex");
  const category = CATEGORIES[crypto.randomInt(CATEGORIES.length)];
  const verb = VERBS[crypto.randomInt(VERBS.length)];
  const noun = NOUNS[crypto.randomInt(NOUNS.length)];
  return {
    title: `[probe-${rand()}] ${noun} ${verb} unexpectedly`,
    description: `Regenerated determinism-probe ticket #${i}, marker ${rand()}. Category: ${category}. This body is generated fresh on every probe run and is never persisted between runs.`,
    category,
  };
}

const tickets = Array.from({ length: 5 }, (_, i) => randomTicket(i + 1));
process.stdout.write(JSON.stringify(tickets, null, 2) + "\n");
