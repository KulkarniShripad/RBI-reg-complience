#!/usr/bin/env node
/**
 * Writes every report / journal figure as SVG into docs/figures/.
 *
 *   node scripts/figures/make_figures.js      (npm run figures)
 *
 * Architecture figures are black and white; evaluation figures are grayscale
 * (shade + hatching + marker shape) and are drawn from eval/results/*.json,
 * so re-running an evaluation and then this script updates them.
 */
const fs = require("fs");
const path = require("path");
const A = require("./architecture");
const C = require("./charts");

const OUT = path.join(__dirname, "..", "..", "..", "docs", "figures");

const FIGURES = [
  ["fig01_system_architecture.svg", A.systemOverview],
  ["fig02_rule_extraction_pipeline.svg", A.extractionPipeline],
  ["fig03_comprehension_subsystem.svg", A.comprehension],
  ["fig04_compliance_checking_subsystem.svg", A.complianceChecking],
  ["fig05_adaptive_router.svg", A.router],
  ["fig06_graph_subsystem.svg", A.graphSubsystem],
  ["fig07_benchmark_and_evaluation_protocol.svg", A.methodology],
  ["fig08_requirement_taxonomy.svg", C.taxonomyDistribution],
  ["fig09_benchmark_composition.svg", C.benchmarkComposition],
  ["fig10_system_accuracy.svg", C.systemAccuracy],
  ["fig11_accuracy_cost_frontier.svg", C.accuracyCost],
  ["fig12_accuracy_by_case_type.svg", C.accuracyByCaseType],
  ["fig13_accuracy_by_category.svg", C.accuracyByCategory],
  ["fig14_ablations.svg", C.ablations],
  ["fig15_significance.svg", C.significance],
  ["fig16_confusion_matrices.svg", C.confusion],
  ["fig17_route_mix.svg", C.routeMix],
  ["fig18_extraction_recall.svg", C.extraction],
  ["fig19_retrieval_chunking.svg", C.retrieval],
  ["fig20_simplification.svg", C.simplification],
];

fs.mkdirSync(OUT, { recursive: true });
for (const [file, make] of FIGURES) {
  fs.writeFileSync(path.join(OUT, file), make());
  console.log(`wrote docs/figures/${file}`);
}
// the repository's architecture diagram is Fig. 1
fs.writeFileSync(path.join(__dirname, "..", "..", "urcc-architecture-v3.svg"), A.systemOverview());
console.log("wrote urcc-ef-backend/urcc-architecture-v3.svg (= Fig. 1)");
