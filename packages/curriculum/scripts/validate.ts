import { CurriculumValidationError, loadSeedCurriculum } from "../src/index";

try {
  const { curriculum, graph, warnings } = loadSeedCurriculum();
  console.log(`Curriculum v${curriculum.version}: ${curriculum.concepts.length} concepts`);
  for (const domain of [...curriculum.domains].sort((a, b) => a.order - b.order)) {
    console.log(`  ${domain.title.padEnd(34)} ${graph.conceptsInDomain(domain.id).length}`);
  }
  for (const warning of warnings) {
    console.warn(`warning [${warning.code}] ${warning.conceptId ?? ""} ${warning.message}`);
  }
  graph.topologicalOrder();
  console.log("OK: schema, references, and prerequisite graph are valid.");
} catch (error) {
  if (error instanceof CurriculumValidationError) {
    console.error(error.message);
  } else {
    console.error(error instanceof Error ? error.message : error);
  }
  process.exitCode = 1;
}
