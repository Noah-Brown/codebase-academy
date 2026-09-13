/**
 * Milestone 1 demo: rank the fixture PR's mapped concepts for a starting level
 * and explain the recommendation.  Usage: npm run demo:select -- --level novice
 */
import { getCurriculum } from "@academy/curriculum";
import { paymentRetryFixture } from "../src/fixtures";
import {
  MASTERY_LABEL_TEXT,
  STARTING_LEVELS,
  createLearnerView,
  selectLesson,
  type StartingLevel,
} from "../src/index";

const flag = process.argv.indexOf("--level");
const level = (flag >= 0 ? process.argv[flag + 1] : "intermediate") as StartingLevel;
if (!STARTING_LEVELS.includes(level)) {
  console.error(`--level must be one of: ${STARTING_LEVELS.join(", ")}`);
  process.exit(1);
}

const { graph } = getCurriculum();
const result = selectLesson({
  graph,
  learner: createLearnerView(level, graph, []),
  now: new Date(),
  mappings: paymentRetryFixture.mappings,
});

console.log(`\n${paymentRetryFixture.title}  (learner: ${level}, no assessed evidence yet)\n`);
console.log(
  ["priority", "concept".padEnd(34), "status".padEnd(10), "depth".padEnd(9), "penalties"].join(
    "  ",
  ),
);
for (const candidate of result.ranked) {
  console.log(
    [
      candidate.breakdown.priority.toFixed(3).padStart(8),
      candidate.concept.title.padEnd(34),
      MASTERY_LABEL_TEXT[candidate.status.label].padEnd(10),
      candidate.depth.padEnd(9),
      candidate.breakdown.penalties.map((p) => `${p.code} −${p.amount}`).join(", ") || "—",
    ].join("  "),
  );
}

if (!result.selected) {
  console.log(`\nNo lesson recommended (${result.noSelectionReason}).`);
} else {
  const { concept, breakdown, reasons, mapping } = result.selected;
  console.log(`\nRecommended: ${concept.title} — ${result.selected.depth} lesson`);
  console.log(`Using ${mapping.evidence[0]?.path}\n`);
  for (const reason of reasons) console.log(`  • ${reason}`);
  console.log("\nScore breakdown:");
  for (const [term, value] of Object.entries(breakdown.weighted)) {
    const raw = breakdown.components[term as keyof typeof breakdown.components];
    console.log(`  ${term.padEnd(24)} ${raw.toFixed(3)} → ${value.toFixed(3)}`);
  }
}
