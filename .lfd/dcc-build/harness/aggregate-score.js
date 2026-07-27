#!/usr/bin/env node
// Combines eval-cases.json + a {file: "pass"|"fail"} map into a weighted
// scorecard. Called by score.sh; not meant to be run standalone (but safe
// to: `node aggregate-score.js eval-cases.json file-status.json out.json`).
"use strict";
const fs = require("fs");

const [, , casesPath, fileStatusPath, outPath] = process.argv;
const manifest = JSON.parse(fs.readFileSync(casesPath, "utf8"));
const fileStatus = JSON.parse(fs.readFileSync(fileStatusPath, "utf8"));

const categories = manifest._meta.categories;
const perCategory = {};
for (const key of Object.keys(categories)) {
  perCategory[key] = { total: 0, applicable: 0, passed: 0, weight: categories[key].weight };
}

const caseResults = [];
let hardFailTriggered = false;

for (const c of manifest.cases) {
  const fileRef = c.test_ref.split("::")[0].trim();
  const isStaticSpecFile = fileRef.startsWith("harness/tests/");
  let result; // "pass" | "fail" | "not_applicable_dev"
  if (!isStaticSpecFile) {
    // e.g. DET-04's test_ref is harness/probe.sh — scored only under --holdout.
    result = "not_applicable_dev";
  } else if (fileStatus[fileRef] === "pass") {
    result = "pass";
  } else {
    // covers both "fail" and "file never ran" (treated as fail — nothing
    // built yet is exactly nothing passing yet)
    result = "fail";
  }

  perCategory[c.category].total += 1;
  if (result !== "not_applicable_dev") {
    perCategory[c.category].applicable += 1;
    if (result === "pass") perCategory[c.category].passed += 1;
  }
  if (result === "fail" && c.hard_fail) hardFailTriggered = true;

  caseResults.push({ id: c.id, category: c.category, hard_fail: c.hard_fail, result, file: fileRef });
}

let weightedScore = 0;
const categoryScores = {};
for (const [key, v] of Object.entries(perCategory)) {
  const score = v.applicable > 0 ? v.passed / v.applicable : 0;
  categoryScores[key] = {
    passed: v.passed,
    applicable: v.applicable,
    total: v.total,
    score: Number(score.toFixed(4)),
    weight: v.weight,
  };
  weightedScore += score * v.weight;
}
weightedScore = Number(weightedScore.toFixed(4));

const noCategoryBelow085 = Object.values(categoryScores).every((c) => c.score >= 0.85);
const passBarMet = weightedScore >= 0.95 && noCategoryBelow085 && !hardFailTriggered;

const scorecard = {
  weighted_score: weightedScore,
  pass_bar_met: passBarMet,
  hard_fail_triggered: hardFailTriggered,
  categories: categoryScores,
  cases: caseResults,
  generated_note:
    "Case-level granularity is per-spec-file (a file passes only if every test in it passes); a case is 'fail' if its file failed OR never ran. DET-04 is excluded from dev scoring (not_applicable_dev) — it is a dynamic probe, see probe.sh, scored only under --holdout.",
};

fs.writeFileSync(outPath, JSON.stringify(scorecard, null, 2));
