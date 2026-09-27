import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import api from "@/lib/api";
import ChatPage from "@/pages/ChatPage";
import UploadPage from "@/pages/UploadPage";
import { ChatProvider } from "@/context/ChatContext";

Element.prototype.scrollTo = function scrollTo() {} as typeof Element.prototype.scrollTo;

const answer = {
  query: "minimum CRAR for SFBs",
  answer: "A small finance bank must keep a minimum total capital of 15 per cent of RWAs [1].",
  answer_mode: "llm",
  confidence: "high",
  relevant_rule_ids: ["7"],
  source_circulars: ["RBI/DOR/2025-26/182"],
  sources_used: 1,
  rules_matched: 1,
  fallback_used: false,
  sources: [
    {
      id: 1,
      clause_uri: "rbi://sfb/abc/para10",
      doc_id: "abc",
      doc_title: "Reserve Bank of India (Small Finance Banks – Prudential Norms on Capital Adequacy) Directions, 2025",
      rbi_ref: "RBI/DOR/2025-26/182",
      paragraph: "10",
      page: 7,
      clause_text: "(1) A bank shall maintain a minimum total capital (MTC) of 15 per cent of the risk weighted assets (RWAs).",
      snippet: "A bank shall maintain a minimum total capital (MTC) of 15 per cent",
      categories: [{ id: "small_finance_banks", label: "Small Finance Banks" }],
      rule_atoms: [],
    },
  ],
};

const Nav = () => {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate("/upload")}>go-upload</button>
      <button onClick={() => navigate("/")}>go-chat</button>
    </>
  );
};

beforeEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("chat", () => {
  it("keeps the conversation when navigating to another section and back", async () => {
    vi.spyOn(api, "post").mockResolvedValue({ data: answer });
    vi.spyOn(api, "get").mockResolvedValue({ data: { categories: [], topics: [], families: [] } });
    render(
      <ChatProvider>
        <MemoryRouter initialEntries={["/"]}>
          <Nav />
          <Routes>
            <Route path="/" element={<ChatPage />} />
            <Route path="/upload" element={<UploadPage />} />
          </Routes>
        </MemoryRouter>
      </ChatProvider>,
    );
    const box = screen.getByPlaceholderText(/ask about rbi circulars/i);
    fireEvent.change(box, { target: { value: "minimum CRAR for SFBs" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByText(/minimum total capital of 15 per cent/)).toBeInTheDocument();

    fireEvent.click(screen.getByText("go-upload"));
    expect(await screen.findByRole("heading", { name: "Upload Circular" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("go-chat"));
    expect(await screen.findByText(/minimum total capital of 15 per cent/)).toBeInTheDocument();
    expect(screen.getByText("minimum CRAR for SFBs")).toBeInTheDocument();
    // also persisted for a page reload
    expect(window.localStorage.getItem("urcc.chat.v1")).toContain("minimum CRAR for SFBs");
  });

  it("opens the source paragraph when a citation is clicked", async () => {
    vi.spyOn(api, "post").mockResolvedValue({ data: answer });
    const get = vi.spyOn(api, "get").mockImplementation(async (url: string) => {
      if (url.startsWith("/api/documents/clauses/by-uri/")) {
        return {
          data: {
            ...answer.sources[0], paragraph_number: "10", page_number: 7, page_end: 7, heading_path: "Chapter II > A. Capital",
            document: { doc_id: "abc", title: answer.sources[0].doc_title, rbi_ref: "RBI/DOR/2025-26/182", pdf_available: true, categories: [] },
            rule_atoms: [], cross_references: [], definitions: [], footnotes: [], previous: null, next: null,
          },
        };
      }
      return { data: { categories: [] } };
    });
    render(<ChatProvider><MemoryRouter><ChatPage /></MemoryRouter></ChatProvider>);
    const box = screen.getByPlaceholderText(/ask about rbi circulars/i);
    fireEvent.change(box, { target: { value: "minimum CRAR for SFBs" } });
    fireEvent.keyDown(box, { key: "Enter" });
    const citation = await screen.findByRole("button", { name: "[1]" });
    fireEvent.click(citation);
    expect(await screen.findByText("Paragraph 10")).toBeInTheDocument();
    await waitFor(() => expect(get).toHaveBeenCalledWith(`/api/documents/clauses/by-uri/${encodeURIComponent("rbi://sfb/abc/para10")}`));
    expect(screen.getByText(/Open the original PDF at page 7/)).toBeInTheDocument();
  });
});

describe("upload", () => {
  it("warns about a duplicate before uploading", async () => {
    vi.spyOn(api, "get").mockResolvedValue({ data: { categories: [] } });
    const post = vi.spyOn(api, "post").mockImplementation(async (url: string) => {
      if (url === "/upload/check") return { data: { duplicate: true, existing: { title: "KYC Directions", rbi_ref: "RBI/1" } } };
      throw new Error("upload must not be called");
    });
    // jsdom lacks File.arrayBuffer/crypto.subtle in some versions; provide both.
    const file = new File(["%PDF-1.4 test"], "kyc.pdf", { type: "application/pdf" });
    Object.defineProperty(file, "arrayBuffer", { value: async () => new TextEncoder().encode("%PDF-1.4 test").buffer });
    render(<MemoryRouter><UploadPage /></MemoryRouter>);
    fireEvent.change(screen.getByTestId("file-input"), { target: { files: [file] } });
    expect(await screen.findByText(/already in the knowledge base/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /upload & process/i })).toBeDisabled();
    expect(post).toHaveBeenCalledWith("/upload/check", expect.objectContaining({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }));
  });
});
