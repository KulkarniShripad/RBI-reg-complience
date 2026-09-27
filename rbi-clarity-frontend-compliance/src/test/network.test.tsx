import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { parseCsv, toCsv } from "@/lib/csv";
import { NetworkResults } from "@/components/network/NetworkResults";
import { NetworkGraph } from "@/components/network/NetworkGraph";
import type { NetworkCheck } from "@/lib/network";

describe("csv", () => {
  it("parses quoted fields, escaped quotes, CRLF and a BOM", () => {
    const rows = parseCsv('﻿entity_id,name,evidence\r\nA,"Apex, Ltd","said ""yes"""\r\n\r\nB,Beta,\n');
    expect(rows).toEqual([
      { entity_id: "A", name: "Apex, Ltd", evidence: 'said "yes"' },
      { entity_id: "B", name: "Beta", evidence: "" },
    ]);
  });

  it("round-trips through toCsv", () => {
    const text = toCsv(["a", "b"], [{ a: "x,y", b: 'q"q' }]);
    expect(parseCsv(text)).toEqual([{ a: "x,y", b: 'q"q' }]);
  });
});

const check: Pick<NetworkCheck, "results" | "groups" | "summary" | "notes"> & { has_data: boolean } = {
  has_data: true,
  notes: [],
  summary: {
    counterparties: 3,
    groups: 1,
    provisional_groups: 0,
    bank_group_entities: 0,
    total_exposure: 500,
    status_counts: { BREACH: 1, PASS: 1 },
    overall: "BREACH",
    largest_exposures: [],
  },
  groups: [
    { group_id: "G1", name: "Apex group", basis: ["control"], provisional: false, members: [{ id: "A", name: "Apex" }, { id: "B", name: "Beta" }], links: [] },
  ],
  results: [
    {
      id: "R1",
      rule_key: "cb_single",
      rule_label: "Single counterparty: 20% of eligible capital base",
      kind: "single_limit",
      status: "PASS",
      clause_uri: "rbi://cb/x/para15",
      source: { verified: true, clause_uri: "rbi://cb/x/para15", paragraph: "15", page_number: 11, rbi_ref: "RBI/DOR/2025-26/158" },
      subject: { type: "counterparty", id: "C", name: "Coastal", entity_type: "company" },
      exposure: 100,
      exposure_pct: 10,
      limit_pct: 20,
      reasons: [],
    },
    {
      id: "R2",
      rule_key: "cb_group",
      rule_label: "Group of connected counterparties: 25% of eligible capital base",
      kind: "group_limit",
      status: "BREACH",
      clause_uri: "rbi://cb/x/para16",
      source: { verified: true, clause_uri: "rbi://cb/x/para16", paragraph: "16", page_number: 11, rbi_ref: "RBI/DOR/2025-26/158", excerpt: "shall not be higher than 25 percent" },
      subject: {
        type: "group",
        id: "G1",
        name: "Apex group",
        members: [
          { id: "A", name: "Apex", exposure: 200, reason: "anchor" },
          { id: "B", name: "Beta", exposure: 100, reason: "controlled: Apex owns 60% of Beta" },
        ],
      },
      exposure: 300,
      exposure_pct: 30,
      limit_pct: 25,
      links: [{ label: "Apex owns 60% of Beta (>50% of voting rights: control)", status: "confirmed", edge_type: "OWNS" }],
      reasons: [],
    },
  ],
};

describe("NetworkResults", () => {
  it("shows issues first with the group members, why they are grouped, and the source paragraph", () => {
    render(<NetworkResults check={check} />);
    expect(screen.getByText("Issues (1)")).toBeInTheDocument();
    expect(screen.getAllByText("Apex group").length).toBeGreaterThan(0);
    expect(screen.getByText("controlled: Apex owns 60% of Beta")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /para 16, p\. 11/ })).toBeInTheDocument();
    // the passing single-counterparty row appears only under "All checks"
    expect(screen.queryByText("Coastal")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("All checks (2)"));
    expect(screen.getByText("Coastal")).toBeInTheDocument();
  });

  it("explains what to enter when there is no network data", () => {
    render(<NetworkResults check={{ results: [], groups: [], summary: null, notes: [], has_data: false, message: "No exposures entered for Q1." }} />);
    expect(screen.getByText("No exposures entered for Q1.")).toBeInTheDocument();
  });
});

describe("NetworkGraph", () => {
  it("draws every linked node and hides the bank node when nothing links to it", () => {
    const nodes = [
      { id: "SELF", name: "Bank", entity_type: "self", exposure: 0, exempt: 0, exposure_pct: null, status: null, group_ids: [], bank_group: null },
      { id: "A", name: "Apex", entity_type: "company", exposure: 200, exempt: 0, exposure_pct: 20, status: "BREACH", group_ids: ["G1"], bank_group: null },
      { id: "B", name: "Beta", entity_type: "company", exposure: 100, exempt: 0, exposure_pct: 10, status: "PASS", group_ids: ["G1"], bank_group: null },
    ];
    const { container } = render(
      <NetworkGraph nodes={nodes} links={[{ id: 1, source: "A", target: "B", edge_type: "OWNS", status: "confirmed", label: "Apex owns 60% of Beta (>50% of voting rights: control)" }]} />,
    );
    expect(container.querySelectorAll("[data-node]").length).toBe(2);
    expect(screen.getByText("Apex")).toBeInTheDocument();
    expect(container.querySelector("line title")?.textContent).toMatch(/owns 60%/);
  });
});
