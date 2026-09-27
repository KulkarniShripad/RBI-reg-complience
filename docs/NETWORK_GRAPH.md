# Network Topology Mapper (graph subsystem)

Subsystem 3 of URCC-EF. It checks the RBI rules that cannot be decided by
looking at one borrower at a time: the limits on exposure to a **group of
connected counterparties**, the prohibition on lending to the bank's
**directors, their relatives, promoters, major shareholders** and the
companies connected to them, and the **intra-group exposure** limits on the
bank's own subsidiaries, associates and parent entities.

> Evaluated on synthetic ownership data only. Real deployment needs the
> bank's own counterparty data and ownership registries (MCA / CERSAI /
> credit bureaus), which this study does not have.

## 1. Why a graph

A row-level rule engine sees "exposure to Apex Motors = 5.5% of Tier 1 (limit
20%)" and passes it. It cannot see that Apex Motors is controlled by Apex
Holdings, that a supplier sells most of its output to Apex Motors, and that
the supplier's parent depends on the supplier. RBI's Large Exposures
Framework says such entities are *one risk* and their exposures are added up
(Commercial Banks – Concentration Risk Management Directions, paragraphs
19–31). The same holds for director lending: "a company of which the
**subsidiary or holding company** has a bank director on its board" is a path
question (Credit Risk Management Directions, paragraph 14 / Section 20(1)(b)
of the BR Act).

## 2. Data model

Per bank (`migrations/004_graph_network.sql`); amounts in ₹ crore.

| Table | Holds |
|---|---|
| `graph_entities` | nodes: counterparties and the people / companies behind them. The bank itself is the reserved node `SELF`. `entity_type` (company, individual, firm, trust, bank, nbfc, insurer, government, ccp, fund, other), optional `group_relation` (subsidiary, associate, joint venture, promoter, …), `ite_class`, flags (gold-loan NBFC, Section 8 company, Government company, non-strategic investor, economic-interdependence assessed) |
| `graph_edges` | typed, directed edges with `status` = confirmed / flagged / rebutted and the evidence |
| `graph_exposures` | exposure per counterparty, kind and period: amount, sanctioned limit, credit risk mitigation and its provider, infrastructure flag, exemption, Board-approved excess, claimed Section 20 exception |
| `graph_capital` | capital bases per period: Tier 1, Tier 2, owned funds, paid-up capital + reserves |
| `graph_bank_profile` | NBFC layer (BL / ML / UL), IFC flag, NABARD rating (rural co-operative banks) |
| `graph_check_runs`, `graph_check_results` | frozen results of each check (linked to the compliance run when run from there) |

Edge types

| Edge | Meaning | Used for |
|---|---|---|
| `OWNS` (pct) | shareholding / voting rights | > 50% = control (automatic, para 21); ≥ 20% = significant influence (bank's group, promoter entities); ≥ 10% into `SELF` = major shareholder |
| `CONTROLS` (basis) | control by voting agreement, board appointment, management influence, accounting standard | groups |
| `COMMON_MANAGEMENT` | same shareholders / managers, no single controller (horizontal group, para 23; UCB "common partners") | groups |
| `ECONOMIC_DEPENDENCE` (criterion 1–7, two-way flag) | *from* depends on *to* — the seven criteria of para 25 | groups (contagion) |
| `DIRECTOR_OF` | person → company, or → `SELF` (a director of the bank) | Section 20 |
| `INTERESTED_IN` (role) | partner, manager, employee, guarantor, managing agent, substantial interest | Section 20 |
| `RELATIVE_OF` (relation) | spouse, minor / dependent child, other | Section 20 relatives, promoters' relatives |
| `PROMOTER_OF` | → `SELF` | promoters (para 42H), bank's group |

Status: **confirmed** links are facts the bank asserts. **Flagged** links are
suspected (e.g. a relationship manager's note): anything that depends on one
is reported as `POTENTIAL_BREACH` / `NEEDS_REVIEW`, never as a breach — RBI
itself expects false positives here. **Rebutted** links are ignored: the bank
has demonstrated to RBI that the link does not create a single risk (paras 24
and 27, e.g. a ring-fenced SPV).

## 3. Algorithms (`urcc-ef-backend/src/services/graph/graphEngine.js`)

All pure functions, no database — unit-tested on RBI's own examples.

1. **Control groups.** Control edges = `CONTROLS` + `OWNS > 50%`. For every
   ultimate controller, the group is it plus everything it controls directly
   or indirectly (DFS). Edges from a sovereign are skipped (entities
   controlled by the Government are not connected through it, para 9).
   Anything touching the bank itself is excluded.
2. **Horizontal groups.** `COMMON_MANAGEMENT` merges the groups of both ends.
3. **Economic interdependence (contagion).** For `D depends on P`, `D` and —
   by **downstream contagion** — everything `D` controls join every group
   that contains `P` (a group of one is opened for a standalone `P`).
   **Upstream contagion** falls out of the same rule: a controller of `D`
   joins only if it is itself recorded as dependent on `D` (para 30(2)(ii)).
   Two-way dependence applies both ways. Iterated to a fixpoint, so chains of
   dependence propagate. One entity can sit in several groups (para 26(2)),
   which is not double counting.
4. Groups wholly contained in a larger group are dropped (the larger
   aggregate binds); overlapping groups are kept.
5. **Exposure aggregation.** Net exposure per counterparty; eligible credit
   risk mitigation reduces it and is recognised as exposure to the protection
   provider (para 46); exempt exposures (sovereign, RBI, GoI-guaranteed,
   food credit, …) are kept apart — not limited, still reportable; UCBs use
   sanctioned limit or outstanding, whichever is higher.
6. **Bank's own group.** Entities the bank marks, entities it owns ≥ 20% of
   or controls, its parents / promoters (≥ 20%, control, `PROMOTER_OF`), and
   entities those parents own ≥ 20% of or control.
7. **Related parties.** From each director of the bank: the director; firms
   they are partner / manager / employee / guarantor of; companies they are
   director / manager / employee / guarantor / managing agent of or hold
   substantial interest in, **plus the subsidiary or holding company of such a
   company**; individuals they are partner or guarantor for — excluding the
   bank's own subsidiaries, Section 8 and Government companies. Spouse and
   minor / dependent children of directors. Promoters, their relatives,
   shareholders with ≥ 10% (unless a financial institution holding it as a
   non-strategic investment), and entities any of them control or hold ≥ 20%
   of. Every hit carries the path that proves it.

## 4. Rules checked

Every rule is tied to the paragraph it comes from
(`src/services/graph/graphRules.js`). At run time the paragraph is looked up
in the extracted corpus and must still contain the number; otherwise the
rule is **not applied** and its results are `NEEDS_REVIEW` (so a changed
direction can never be checked against a stale limit). On the current corpus
all 53 rules resolve.

| Category | Rules (limit, base, source paragraph) |
|---|---|
| Commercial banks | single counterparty 20% of Tier 1, +5% with Board approval (CRM ¶15); group of connected counterparties 25% (¶16); interbank 25% (¶62); single NBFC 20% (¶79); gold-loan NBFC 7.5% of Tier 1+2, 12.5% if on-lent to infrastructure (¶80); group with NBFCs 25% (¶81); large exposure ≥ 10% reported (¶14); economic-interdependence assessment above 5% (¶28); control > 50% (¶21); intra-group 5% / 10% single, 10% / 20% aggregate (¶116); Section 20 (Credit Risk Mgmt ¶14), directors' spouse / children (¶42G), promoters and ≥ 10% shareholders (¶42H). Intra-group exposures are excluded from the LEF limits (¶8(7)). |
| Small finance banks | single / group obligor 10% / 15% of capital funds (¶10); NBFC 10% / 15% (¶14); intra-group 5% / 10% / 10% / 20% of paid-up capital and reserves (¶48); Section 20 (Credit Risk Mgmt ¶14); promoters (¶42H) |
| Local area banks | single / group borrower 15% / 40% of capital funds (¶7); NBFC 10% / 15% (¶10); Section 20 (¶7); promoters (¶16H) |
| Regional rural banks | 15% / 40% of owned funds (¶7); Section 20 (Credit Risk Mgmt ¶7) |
| Urban co-operative banks | individual 15%, group 25% of Tier-I, limit-or-outstanding (¶6); Section 20 read with Section 56 (Credit Risk Mgmt ¶7A) |
| NBFCs | BL: Board-approved limits only (¶8); ML: 25% single / 40% group of Tier 1, +5% / +10% infrastructure (¶13); IFC 30% / 50% (¶14); UL: 20% single (+5% Board or infrastructure, cap 25%; IFC 25% cap 30%) (¶33–34), 25% group (+10% infrastructure; IFC 35%) (¶35); large exposures ≥ 10% (Annex I) |
| All-India FIs | single 20% (+5% Board, +5% infrastructure) (¶11); group 25% (+10% infrastructure) (¶12); control > 50% (¶15); directors (Credit Risk Mgmt ¶17B) |
| Rural co-operative banks | unit-wise exposure by NABARD rating: A 60%, B / B+ 50%, C 45%, D 40% of capital fund (¶14) |
| Payments banks, ARCs, CICs, PPI issuers, primary dealers | no counterparty-concentration rule in their directions — the check says so |

Statuses: `PASS`, `PASS_WITH_CONDITIONS` (within Board-approved or
infrastructure headroom), `BREACH`, `POTENTIAL_BREACH` (only through flagged
links), `PROHIBITED` (related party), `NEEDS_REVIEW` (capital missing, rule
not verified, exception claimed, related only through a flagged link),
`ASSESSMENT_REQUIRED` (> 5% exposure and no economic-interdependence
assessment recorded), `REPORTABLE` (large exposure), `INFO`.

## 5. How it fits with the rest

- **Compliance run** (`POST /api/compliance/:bankId/run`): when the bank has
  exposures for the period, the network check runs with the quantitative and
  qualitative checks; the report gets `network_*` counts and
  `network_findings`, the response `graph_results`, and History keeps it.
- **Adaptive router** (`run-routed`): the `GRAPH` route is live. A clause the
  network check decides (the resolved source paragraphs above) goes to the
  graph whenever the bank has network data for the period — ahead of the rule
  engine, because "exposure to a group of connected counterparties" is an
  aggregate over the graph, not a number a bank types in.
- **Quantitative form**: rule atoms from those paragraphs are marked
  "Computed by network check".
- **Corpus rebuilds** carry the graph tables over like the other bank data.

## 6. Dashboard

Compliance Checker → **Network** tab (also "Exposure Network" in the sidebar),
for the selected bank and period:

- capital base and profile (NBFC layer, NABARD rating) for the period;
- **Graph**: force-directed drawing (node size = exposure, colour = worst
  finding, dashed = flagged, faded = rebutted, dashed ring = bank's own
  group); click a node for its relationships and findings, click a group to
  highlight its members;
- **Findings**: issues first; each group lists its members and *why* each is
  in it, related parties show the path, every row opens its RBI paragraph
  (text, page, original PDF);
- **Counterparties / Relationships / Exposures**: add, edit, delete;
  relationships can be confirmed, flagged or rebutted with a note;
- **Import / export**: CSV templates per table, JSON bundle, all-or-nothing
  validation with row-level errors;
- **Rules checked**: the rules for the bank's category with their source
  paragraphs;
- **Sample networks**: six synthetic scenarios, opened as demo banks.

## 7. API (`/api/graph`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/vocabulary` | allowed entity / edge / exposure values |
| GET | `/rules?category=` | rule catalog with resolved source paragraphs |
| GET | `/scenarios` · POST `/scenarios/:id/load` | synthetic samples `{period_label, bank_id?, force?}` |
| GET | `/:bankId?period_label=` | entities, edges, exposures, capital, profile |
| POST · DELETE | `/:bankId/entities` · `/:bankId/entities/:entityId` | upsert (list or one) / delete with its edges and exposures |
| POST · PATCH · DELETE | `/:bankId/edges` · `/:bankId/edges/:edgeId` | upsert / review `{status, review_note}` / delete |
| POST · DELETE | `/:bankId/exposures` · `/:bankId/exposures/:exposureId` | `{period_label, exposures}` |
| PUT | `/:bankId/capital` · `/:bankId/profile` | capital bases per period / bank profile |
| POST · GET | `/:bankId/import` · `/:bankId/export` | whole network, validated first, optional replace |
| POST | `/:bankId/check` | `{period_label, include_flagged=true, persist=false}` → results, groups, graph |
| GET | `/:bankId/runs` · `/runs/:graphRunId` | saved checks |

Invalid input returns `400 {code: "invalid_network_data", details: [{table, row, field, message}]}` and writes nothing.

## 8. Evaluation (proof of concept)

`npm run eval:graph` runs six **synthetic** scenarios
(`urcc-ef-backend/eval/graph_scenarios.json`) with the rules resolved against
the real corpus. They reproduce RBI's own grouping illustration (one-way
dependence, downstream and upstream contagion), director / relative /
promoter / shareholder lending, sovereign exemption, a rebutted SPV, a
flagged dependence, credit protection substitution, intra-group limits, an
NBFC-UL with Board and infrastructure headroom, and a UCB with sanctioned
limits and common partners.

Result: **40 of 40 expected outcomes hold** (the expected outcomes were
written from the directions' text; one expectation was corrected during
development because the rule is "exceeds five per cent" and the scenario had
exactly 5%). `npm test` runs the same scenarios plus 12 engine tests on
RBI's examples and 6 API tests on a corpus built from the two real
commercial-bank directions.

Speed: evaluating a random synthetic network of 5,000 counterparties and
~3,700 edges takes ≈ 0.3 s; the graph view draws at most 300 parties (those
with findings, the largest exposures and the selected group) and says so.

## 9. Limits

- **Synthetic data only.** No real ownership / directorship data was
  available; the scenarios test that the rules are implemented as written,
  not that real networks are complete. Real use needs registry integration
  (MCA for shareholding and directorships) and the bank's own knowledge of
  economic dependence, which no registry holds.
- Economic interdependence is recorded, not inferred: the check aggregates
  what the bank records, and flags large exposures with no recorded
  assessment.
- Exposure measurement (CCF conversion, SFT / derivative exposure values,
  look-through for funds, trading-book offsetting) is taken as entered, not
  computed.
- "Substantial interest", "relative" and "significant influence" follow the
  simple thresholds above (≥ 20% for significant influence); edge cases in the
  Companies Act / Ind AS definitions need the bank's judgement.
- Not covered: country / sector limits, capital-market exposure ceilings,
  G-SIB-to-G-SIB limits, the UCB "small value loans" portfolio test.
