import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import api from "@/lib/api";
import ChatPage from "@/pages/ChatPage";

// jsdom does not implement element scrolling, which ChatPage uses for auto-scroll.
Element.prototype.scrollTo = function scrollTo() {} as typeof Element.prototype.scrollTo;

describe("existing comprehension flow", () => {
  it("ChatPage still calls GET /ask with the query", async () => {
    const get = vi.spyOn(api, "get").mockResolvedValue({
      data: {
        query: "tell me about kyc", answer: "KYC answer", relevant_rule_ids: [], source_circulars: [],
        confidence: "high", sources_used: 3, rules_matched: 1, fallback_used: false,
      },
    });
    render(<MemoryRouter><ChatPage /></MemoryRouter>);
    const box = screen.getByPlaceholderText(/ask about rbi circulars/i);
    fireEvent.change(box, { target: { value: "tell me about kyc" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(get).toHaveBeenCalledWith("/ask", { params: { query: "tell me about kyc" } }));
    expect(await screen.findByText("KYC answer")).toBeInTheDocument();
    get.mockRestore();
  });
});

describe("existing pages still render", () => {
  it.each([
    ["RulesPage", () => import("@/pages/RulesPage"), "Compliance Rules"],
    ["CircularsPage", () => import("@/pages/CircularsPage"), "Browse Circulars & Topics"],
    ["UploadPage", () => import("@/pages/UploadPage"), "Upload Circular"],
  ])("%s", async (_name, load, heading) => {
    const get = vi.spyOn(api, "get").mockResolvedValue({ data: { topics: [], total: 0, rules: [], page: 1, per_page: 20, pages: 0 } });
    const { default: Page } = await load();
    render(<MemoryRouter><Page /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
    get.mockRestore();
  });
});
