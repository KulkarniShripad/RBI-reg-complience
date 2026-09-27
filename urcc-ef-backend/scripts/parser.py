"""
Structure-aware parser for RBI Master Directions / Circulars (stage 1).

Input: clean visual lines from pdf_text.py (font size, bold flag and x
position per line; page numbers, running headers and footnote markers
already removed). Output: a ParsedDocument with preamble, numbered
paragraphs (clause units), annexes and footnotes. No LLM is involved.

Why this was rewritten (measured with audit_extraction.py against the 266
real PDFs, see README): the previous single-pass parser had terminal states
that silently discarded the rest of a document -
  * a TOC entry like "Chapter XIA" was read as roman "XI", so the TOC was
    mistaken for the body start and the TOC line "Annex I ....... 50"
    switched the parser into annex mode; every later paragraph was dropped
    (16 documents came out with zero clauses);
  * a sentence wrapped so that a line began "Annex IX, sworn before ..." or
    "Chapter-VII of these Directions ..." was taken as a heading;
  * sub-section headings ("B.2 Policy and SOP", "C.3.1 Zero Liability")
    were appended to the previous clause, and page numbers were glued to
    clause ends;
  * table / form rows numbered "1.", "2." became paragraphs ("-dupN").
Mean word coverage of the old database was 70.5%, with 65 documents under
50%.

Design of this version:
  * Every line is always kept somewhere (preamble, a paragraph, an annex, or
    a footnote) - there is no "skip the rest" state. The audit script checks
    this by measuring word coverage per document.
  * Headings need layout evidence (bold, left margin, short line, no
    lowercase continuation) - not just a regex match at line start.
  * Paragraph numbers must continue the sequence (n = last+1 .. last+6).
    A number that does not fit is treated as a list item inside the current
    paragraph, which is what stops table rows becoming clauses.
  * Numbering that restarts at 1 right after a chapter/section heading
    (Guidelines and 2016-era documents do this) opens a new numbering scope,
    so paragraph keys stay unique: "II.3" = paragraph 3 of Chapter II.
  * An annex can only start after the operative body has begun, and only
    if the next line is not another TOC-style heading.
"""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field

import pdf_text

# ---------------------------------------------------------------------------
# Patterns (built from the observed corpus)
# ---------------------------------------------------------------------------
RE_RBI_REF = re.compile(r"RBI/(?:[\w\-]+/)?\d{4}-\d{2}/\d+")
RE_DATE = re.compile(
    r"\b((?:January|February|March|April|May|June|July|August|September|October|November|December)"
    r"\s+\d{1,2},\s*\d{4})\b")
RE_UPDATED = re.compile(r"\(\s*Updated\s+as\s+on\s+([^)]+)\)", re.I)
RE_DEPT_CODE = re.compile(r"\b((?:[A-Z][A-Za-z]{1,6}\.){1,4}[A-Za-z0-9().\- /]*?/\d{2}[.\-]\d{2}[.\-]\d{3}/\d{4}-\d{2})")
RE_TOC_HEADER = re.compile(r"^\s*(table\s+of\s+contents|contents|index)\s*$", re.I)
RE_DOTTED_LEADER = re.compile(r"(?:\.\s?){5,}|…{2,}|_{5,}")

ROMAN = r"[IVXLC]+"
RE_CHAPTER = re.compile(
    rf"^\s*(?:CHAPTER|Chapter|Chatper|CHATPER)\s*[-–—:]?\s*({ROMAN}[A-Z]?|\d{{1,2}}[A-Z]?)\b\.?\s*[-–—:.]?\s*(.*)$")
# 2016-18 letters use "Section I / Section II" (and some use "Part A") as the
# top level instead of chapters; they are treated exactly like chapters.
RE_SECTION_ROMAN = re.compile(rf"^\s*(?:SECTION|Section|PART|Part)\s*[-–—:]?\s*({ROMAN}|[A-H])\b\s*[-–—:.]?\s*(.*)$")
RE_ANNEX = re.compile(
    rf"^\s*(Annex(?:ure)?|ANNEX(?:URE)?|Appendix|APPENDIX|Schedule|SCHEDULE)\s*[-–—:]?\s*"
    rf"({ROMAN}|\d{{1,2}}|[A-Z])?\b\s*[-–—:.)]?\s*(.*)$")
# "A. Title" or "B.2 Title" / "C.3.1 Title". The period after a lone letter is
# required - otherwise a sentence such as "A CDS creates a notional ..." is
# taken for section "A".
RE_SECTION = re.compile(r"^\s*([A-Z])(?:((?:\.\d{1,2}){1,3})\.?|\.)\s+(\S.*)$")
RE_FLAT_PARA = re.compile(r"^\s*\[?\s*(\d{1,3})([A-Z]{1,2})?\s*\.\s*(\S.*)?$")
RE_FLAT_PARA_NODOT = re.compile(r"^\s*\[?\s*(\d{1,3})\s+([A-Z(\[‘'\"].*)$")   # "1 These Directions ...", "1 Short Title."
RE_DECIMAL_PARA = re.compile(r"^\s*\[?\s*(\d{1,2}(?:\.\d{1,3}){1,3})\.?\s+(\S.*)$")
RE_LIST_MARKER = re.compile(
    r"^\s*\[?\s*(?:\((?:\d{1,2}|[ivxlc]{1,6}[a-z]?|[a-z]{1,2})\)|(?:[a-z]|[ivx]{1,4})\)|\d{1,2}\)|[•●▪■◦\-–]\s)")
LOWER_START = re.compile(r"^[a-z(,;]")
RE_PROSE_START = re.compile(r"^(In exercise of|Accordingly|Whereas|The Reserve Bank|These Directions|Reserve Bank of India, having)", re.I)
CONTINUATION_WORDS = re.compile(
    r"^(of|to|in|and|or|shall|relating|pertaining|read|as|under|with|for|which|that|the|these|this|is|are)\b")


@dataclass
class Paragraph:
    key: str                       # unique within the document: "12", "12A", "II.3", "3.1.2"
    text: str
    page: int
    chapter_roman: str
    chapter_title: str
    section_letter: str
    section_title: str
    heading_path: list = field(default_factory=list)   # [chapter, section, sub-heading] for display/context
    subclauses: list = field(default_factory=list)     # [(marker, text)] top-level "(1)" style parts
    page_end: int = 0


@dataclass
class Annex:
    key: str                       # "I", "II", "A", "1"
    title: str
    page: int
    text: str
    page_end: int = 0


@dataclass
class ParsedDocument:
    doc_id: str
    file_path: str
    pdf_sha256: str
    rbi_ref: str
    dept_code: str
    date: str
    title: str
    last_updated_label: str
    template_variant: str
    preamble: str
    preamble_page: int
    paragraphs: list
    annexes: list
    footnotes: list               # [(page, text)]
    page_count: int
    first_page_text: str


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 16), b""):
            h.update(block)
    return h.hexdigest()


def doc_id_for(sha256_hex: str) -> str:
    """Content-addressed: the same PDF always gets the same doc_id, on any
    machine and under any file name. (The old id was sha1(file_path), which
    is how the same circular ended up in the database twice.)"""
    return sha256_hex[:16]


# ---------------------------------------------------------------------------
# Header parsing
# ---------------------------------------------------------------------------
TITLE_HINT = re.compile(r"\b(Directions?|Guidelines|Master\s+Circular|Framework|Scheme|Circular)\b", re.I)


def parse_header(lines: list, first_page_text: str) -> dict:
    head = [ln for ln in lines if ln.page <= 2][:60]
    blob = first_page_text
    ref_m = RE_RBI_REF.search(blob)
    date_m = RE_DATE.search(blob)
    dept_m = RE_DEPT_CODE.search(blob)

    # Title: the first run of bold lines on the cover that reads like a
    # document title (skipping the banner, department address and refs).
    title = ""
    run = []
    for ln in head:
        t = RE_UPDATED.sub("", ln.text).strip()
        if not t:
            continue
        # Reference / department-code / date-only lines are often bold too
        # ("Master Direction FIDD.CO.FSD.BC No.9/05.10.001/2018-19 October 17, 2018").
        ref_line = re.fullmatch(rf"\s*(?:dated\s+)?{RE_DATE.pattern}\s*", t) \
            or re.search(r"\b[A-Za-z]{2,6}\.\s?[A-Z]{2,}.*?/\d{4}-\d{2}\b", t)
        banner = (t.upper() == t and len(t) < 60 and "DIRECTION" not in t.upper()) or RE_RBI_REF.search(t) \
            or RE_TOC_HEADER.match(t) or RE_DOTTED_LEADER.search(t) or ref_line
        title_complete = run and re.search(r"(Directions?|Guidelines|Circular)[,]?\s*(\d{4})?\s*(–\s*\w+)?\s*$", " ".join(run))
        heading = RE_SECTION.match(t) or RE_CHAPTER.match(t)
        if ln.bold and not banner and not heading and not title_complete:
            run.append(t)
            continue
        if run:
            cand = " ".join(run)
            if TITLE_HINT.search(cand) and len(cand) > 15:
                title = cand
                break
            run = []
    if not title and run and TITLE_HINT.search(" ".join(run)):
        title = " ".join(run)
    if not title:
        m = re.search(r"issues?\s+(?:the\s+)?(.{10,200}?Directions?,?\s*\d{4})", " ".join(l.text for l in head))
        title = m.group(1) if m else ""
    title = re.sub(r"^\s*Master\s+Directions?\s*[-–—]?\s*(?=Reserve Bank of India\s*\()", "", title)
    updated = RE_UPDATED.search(title) or RE_UPDATED.search(blob)
    title = RE_UPDATED.sub("", title)
    title = re.sub(r"\s+", " ", title).strip(" -–—,")
    return {
        "rbi_ref": ref_m.group(0) if ref_m else "",
        "date": date_m.group(1) if date_m else "",
        "dept_code": dept_m.group(1).strip() if dept_m else "",
        "title": title,
        "last_updated_label": updated.group(1).strip() if updated else "",
    }


# ---------------------------------------------------------------------------
# Body segmentation
# ---------------------------------------------------------------------------
def _looks_like_heading_text(title: str) -> bool:
    t = title.strip()
    if not t:
        return True
    if LOWER_START.match(t) or CONTINUATION_WORDS.match(t):
        return False
    return len(t) <= 140


def _is_short(ln, limit=110):
    return len(ln.text) <= limit


def _decimal_tuple(s: str):
    return tuple(int(p) for p in s.split("."))


class _Builder:
    """Accumulates lines into the current open container."""

    def __init__(self, doc_lines, left_margin, body_size=12.0):
        self.lines = doc_lines
        self.margin = left_margin
        self.body_size = body_size
        self.preamble: list = []
        self.preamble_page = 0
        self.paragraphs: list[Paragraph] = []
        self.annexes: list[Annex] = []
        self.cur_para: Paragraph | None = None
        self.cur_annex: Annex | None = None
        self.chapter_roman = ""
        self.chapter_word = "Chapter"
        self.chapter_title = ""
        self.section_letter = ""
        self.section_title = ""
        self.subheading = ""
        self.heading_since_para = False
        self.chapter_since_para = False
        self.pending_chapter_title = False
        self.pending_annex_title = False
        self.scheme = None             # 'flat' | 'decimal'
        self.last_flat = None          # (scope, n)
        self.last_decimal = None
        self.scope = ""
        self.used_keys: dict[str, int] = {}
        self.body_started = False
        self.unnumbered = 0
        self.last_numbered_key = ""

    def cur_key_base(self):
        return f"{self.last_numbered_key}." if self.last_numbered_key else ""

    # -- containers --------------------------------------------------------
    def _append_text(self, target_text: str, ln) -> str:
        t = ln.text.strip()
        if not target_text:
            return t
        if RE_LIST_MARKER.match(t) or ln.is_table_row:
            return target_text + "\n" + t
        if target_text.endswith("-") and t[:1].islower():
            return target_text + t
        return target_text + " " + t

    def add_text(self, ln):
        if self.cur_annex is not None:
            self.cur_annex.text = self._append_text(self.cur_annex.text, ln)
            self.cur_annex.page_end = ln.page
        elif self.cur_para is not None:
            self.cur_para.text = self._append_text(self.cur_para.text, ln)
            self.cur_para.page_end = ln.page
        elif self.body_started:
            # Text after a heading but before the next numbered paragraph
            # (chapter introductions, notes, tables) becomes an unnumbered
            # block rather than being lost or dumped into the preamble.
            self.unnumbered += 1
            key = f"{self.cur_key_base()}u{self.unnumbered}"
            self.open_para(key, ln.text.strip(), ln, numbered=False)
        else:
            if not self.preamble:
                self.preamble_page = ln.page
            self.preamble.append(ln.text.strip())

    def _unique_key(self, key: str) -> str:
        if key not in self.used_keys:
            self.used_keys[key] = 0
            return key
        self.used_keys[key] += 1
        return f"{key}-{self.used_keys[key] + 1}"

    def open_para(self, key: str, text: str, ln, numbered: bool = True):
        self.close_para()
        self.body_started = True
        path = [p for p in (
            f"{self.chapter_word} {self.chapter_roman}: {self.chapter_title}".strip(": ") if self.chapter_roman else "",
            f"{self.section_letter}. {self.section_title}".strip(". ") if self.section_letter else "",
            self.subheading,
        ) if p]
        self.cur_para = Paragraph(
            key=self._unique_key(key), text=text.strip(), page=ln.page, page_end=ln.page,
            chapter_roman=self.chapter_roman, chapter_title=self.chapter_title,
            section_letter=self.section_letter, section_title=self.section_title,
            heading_path=path,
        )
        if numbered:
            self.heading_since_para = False
            self.chapter_since_para = False
            self.last_numbered_key = self.cur_para.key

    def close_para(self):
        if self.cur_para is not None:
            self.paragraphs.append(self.cur_para)
            self.cur_para = None

    def open_annex(self, key, title, ln):
        self.close_para()
        self.cur_annex = Annex(key=key or str(len(self.annexes) + 1), title=title.strip(), page=ln.page,
                               text="", page_end=ln.page)
        self.annexes.append(self.cur_annex)
        self.pending_annex_title = not title.strip()

    # -- classification ------------------------------------------------------
    def next_is_heading(self, i):
        for ln in self.lines[i + 1:i + 3]:
            t = ln.text.strip()
            if not t:
                continue
            return bool(RE_ANNEX.match(t) or RE_CHAPTER.match(t) or RE_DOTTED_LEADER.search(t))
        return False

    def _hanging_indent_follows(self, i, ln) -> bool:
        for nxt in self.lines[i + 1:i + 2]:
            return nxt.page == ln.page and nxt.x0 >= ln.x0 + 12 and nxt.size >= self.body_size - 0.6
        return False

    def _expected_number_follows(self, i, expected) -> bool:
        if i is None:
            return False
        rx = re.compile(rf"^\s*\[?\s*{expected}[A-Z]?\.\s+\S")
        for nxt in self.lines[i + 1:i + 80]:
            if rx.match(nxt.text) and nxt.x0 <= self.margin + 22:
                return True
        return False

    def try_paragraph(self, ln, i=None) -> tuple[str, str] | None:
        """Return (key, remaining_text) if this line opens a numbered paragraph."""
        t = ln.text.strip()
        if ln.is_table_row and not re.match(r"^\s*\d{1,3}\s*[.)]\s+\S", t.split(" | ")[0] + " x"):
            return None
        # Paragraph numbers sit at the left margin in body-size type. Table
        # rows numbered "1.", "2." are indented and/or set smaller - this is
        # what keeps disclosure-format tables from becoming clauses.
        near_margin = ln.x0 <= self.margin + 22 and ln.size >= self.body_size - 1.1

        dm = RE_DECIMAL_PARA.match(t)
        if dm and near_margin and self.scheme == "flat" and self.last_flat and not self.last_flat[0]:
            tup = _decimal_tuple(dm.group(1))
            if tup[0] == self.last_flat[1] and tup[1:2] == (1,):
                # "1. Primary Dealer System" followed by "1.1 Introduction":
                # the document is decimal-numbered; "1." was its first heading.
                self.scheme = "decimal"
                self.last_decimal = (tup[0],)
        if dm and near_margin and self.scheme in (None, "decimal"):
            tup = _decimal_tuple(dm.group(1))
            ok = False
            if self.last_decimal is None:
                ok = tup[0] == 1 or (tup[0] <= 3 and self.body_started)
            else:
                last = self.last_decimal
                ok = tup > last and tup[0] <= last[0] + 2 and not (tup[0] == last[0] + 1 and len(tup) > 1 and tup[1] > 3)
            if ok and not re.match(r"^\d", dm.group(2)):       # "2.5 per cent" is text, not a number
                self.scheme = "decimal"
                self.last_decimal = tup
                return dm.group(1), dm.group(2)

        fm = RE_FLAT_PARA.match(t)
        nodot = None
        if not fm:
            nm = RE_FLAT_PARA_NODOT.match(t)
            # Undotted numbers ("1 These Directions ...") are accepted only
            # with layout support: a bold heading, or a hanging indent on the
            # next line. "20 of the Act" (lowercase) never matches.
            if nm and (ln.bold or (i is not None and self._hanging_indent_follows(i, ln))):
                nodot = nm
        if (fm or nodot) and near_margin:
            n = int((fm or nodot).group(1))
            suffix = (fm.group(2) or "") if fm else ""
            rest = ((fm.group(3) or "") if fm else nodot.group(2))
            if rest and re.match(r"^(per\s*cent|%|crore|lakh|days?|months?|years?)\b", rest, re.I):
                return None
            if self.scheme == "decimal":
                # A top-level "3." in a decimal document is a chapter-level
                # item; accept only if it continues the top-level sequence.
                if self.last_decimal and n == self.last_decimal[0] + 1:
                    self.last_decimal = (n,)
                    return str(n), rest
                return None
            last = self.last_flat[1] if self.last_flat else None
            accept = False
            if last is None:
                # A cover letter's "2. The banks undertaking ..." must not
                # start the numbering; the operative text starts at 1.
                accept = n == 1 or (n <= 3 and self.body_started)
            elif suffix and n == last:
                accept = True                                    # "9A." inserted paragraph
            elif n == last + 1:
                accept = True
            elif last + 1 < n <= last + 6:
                # A jump is allowed (deleted paragraphs keep their numbers),
                # unless the expected next number shows up shortly after -
                # then this line is a wrapped reference ("... Paragraph\n53.")
                accept = not self._expected_number_follows(i, last + 1)
            elif n == 1 and (self.heading_since_para or self.chapter_since_para) and last >= 1:
                # numbering restarts under a new heading -> new scope
                self.scope = self._scope_label()
                accept = True
            if accept:
                self.scheme = "flat"
                self.last_flat = (self.scope, n)
                key = f"{self.scope}.{n}{suffix}" if self.scope else f"{n}{suffix}"
                return key, rest
        return None

    def _scope_label(self):
        if self.section_letter and self.heading_since_para and not self.chapter_since_para:
            base = f"{self.chapter_roman}.{self.section_letter}" if self.chapter_roman else self.section_letter
        elif self.chapter_roman:
            base = self.chapter_roman
        else:
            base = f"S{len(self.paragraphs)}"
        label, k = base, 1
        while any(p.key.startswith(label + ".") for p in self.paragraphs) and (self.cur_para is None or not self.cur_para.key.startswith(label + ".")):
            k += 1
            label = f"{base}_{k}"
        return label

    def run(self):
        in_toc = False
        for i, ln in enumerate(self.lines):
            t = ln.text.strip()
            if not t:
                continue
            ht = t.lstrip("[ ").strip() or t        # heading text without an amendment bracket

            # --- table of contents ------------------------------------------
            if RE_TOC_HEADER.match(t) and (ln.bold or _is_short(ln, 30)) and not self.paragraphs and self.cur_para is None:
                in_toc = True
                continue
            if RE_DOTTED_LEADER.search(t) and (self.cur_para is None or in_toc):
                continue
            if in_toc:
                heading_like = RE_CHAPTER.match(t) or RE_ANNEX.match(t) or RE_SECTION.match(t) \
                    or re.match(r"^(Form|Part)\s+\w+", t) or (ln.bold and _is_short(ln, 90))
                prose = RE_PROSE_START.match(t) or (len(t.split()) >= 9 and not heading_like
                                                     and sum(w[:1].islower() for w in t.split()) >= len(t.split()) / 2)
                if not prose and (heading_like or (len(t) < 70 and not t.endswith("."))):
                    continue
                in_toc = False

            # --- pending multi-line titles ------------------------------------
            if self.pending_chapter_title:
                self.pending_chapter_title = False
                title_done = bool(self.chapter_title) and not re.search(r"(\band|\bof|\bfor|\bin|\bto|,|\(\w*|-|–)$", self.chapter_title)
                if (ln.bold or t.isupper()) and _is_short(ln, 120) and not RE_FLAT_PARA.match(t) \
                        and not RE_DECIMAL_PARA.match(t) and not RE_SECTION.match(t) and not RE_CHAPTER.match(t) \
                        and not RE_ANNEX.match(t) and (not title_done or LOWER_START.match(t) or not self.chapter_title):
                    self.chapter_title = f"{self.chapter_title} {t}".strip(" .:-–") if self.chapter_title else t.strip(" .:-–")
                    self.pending_chapter_title = True
                    continue
            if self.pending_annex_title and self.cur_annex is not None:
                self.pending_annex_title = False
                if ln.bold and _is_short(ln, 150):
                    self.cur_annex.title = t
                    continue

            # --- chapter heading -------------------------------------------
            cm = RE_CHAPTER.match(ht) or (RE_SECTION_ROMAN.match(ht) if ln.bold else None)
            if cm and _is_short(ln, 150) and _looks_like_heading_text(cm.group(2)) \
                    and (ln.bold or not self.cur_para or _is_short(ln, 80)):
                if self.cur_annex is None:
                    self.close_para()
                    self.chapter_roman = cm.group(1)
                    self.chapter_word = "Chapter" if RE_CHAPTER.match(ht) else ht.split()[0].title()
                    self.chapter_title = cm.group(2).strip(" .:-–")
                    self.section_letter = self.section_title = self.subheading = ""
                    self.chapter_since_para = True
                    self.heading_since_para = True
                    self.pending_chapter_title = True
                    self.body_started = True
                    continue

            # --- annex heading ------------------------------------------------
            am = RE_ANNEX.match(ht)
            if am and (self.paragraphs or self.cur_para) and _is_short(ln, 150) \
                    and (am.group(2) or _is_short(ln, 40)) \
                    and _looks_like_heading_text(am.group(3)) and not self.next_is_heading(i) \
                    and (ln.bold or ln.x0 > self.margin + 40 or _is_short(ln, 60)):
                self.open_annex(am.group(2) or "", am.group(3), ln)
                continue

            # Safety net: inside an annex, a paragraph number that continues
            # the body's sequence means the "annex" heading was a false hit.
            if self.cur_annex is not None and self.scheme == "flat" and self.last_flat \
                    and self.last_flat[1] >= 5 and ln.x0 <= self.margin + 22:
                fm = RE_FLAT_PARA.match(t)
                if fm and int(fm.group(1)) == self.last_flat[1] + 1 and fm.group(3) and len(fm.group(3)) > 25:
                    self.cur_annex = None

            if self.cur_annex is not None:
                self.add_text(ln)
                continue

            # --- lettered section / sub-section headings ------------------
            sm = RE_SECTION.match(ht)
            if sm and _is_short(ln, 130) and ln.x0 <= self.margin + 30 and _looks_like_heading_text(sm.group(3)) \
                    and (ln.bold or (ln.x0 <= self.margin + 6 and not t.endswith((";", ",")) and len(t) <= 90
                                     and not re.search(r"[.;:]\s+\S", sm.group(3)))):
                self.close_para()
                title = sm.group(3).strip(" .:")
                if sm.group(2):                     # "B.2", "C.3.1": a sub-section of the current section
                    self.subheading = f"{sm.group(1)}{sm.group(2)} {title}"
                else:
                    self.section_letter, self.section_title, self.subheading = sm.group(1), title, ""
                self.heading_since_para = True
                continue

            # --- numbered paragraph ---------------------------------------
            pm = self.try_paragraph(ln, i)
            if pm:
                key, rest = pm
                self.open_para(key, rest or "", ln)
                continue

            # --- unnumbered bold heading (e.g. "Introduction", "Returns to be submitted") ---
            if ln.bold and _is_short(ln, 100) and not t.endswith((",", ";")) and not LOWER_START.match(t) \
                    and not ln.is_table_row and self.body_started \
                    and (self.cur_para is None or self.cur_para.text.rstrip().endswith((".", ";", "]"))):
                # A bold stand-alone line ("Introduction", "Returns to be
                # submitted by NBFCs") is context for the paragraphs that
                # follow. It never closes the open paragraph (bold table
                # header rows would otherwise split a paragraph from its own
                # table), and its text is still kept in the clause.
                self.subheading = t.strip(" .:")
                self.heading_since_para = True
                if self.cur_para is not None:
                    self.cur_para.text += "\n" + t
                    self.cur_para.page_end = ln.page
                continue

            self.add_text(ln)

        self.close_para()


def split_subclauses(text: str) -> list[tuple[str, str]]:
    """Split a paragraph's text at its top-level "(1)", "(2)" ... markers
    (one per line after assembly). Returns [] when there are fewer than two."""
    parts = re.split(r"\n(?=\[?\s*\(\d{1,2}\)\s)", text)
    if len(parts) < 2:
        m = re.match(r"^\s*\[?\s*\((\d{1,2})\)\s", text)
        if not m:
            return []
    out = []
    for p in parts:
        m = re.match(r"^\s*\[?\s*\((\d{1,2})\)\s*", p)
        out.append((m.group(1) if m else "", p.strip()))
    return out if sum(1 for k, _ in out if k) >= 2 else []


def parse_document(pdf_path: str) -> ParsedDocument:
    ex = pdf_text.extract(pdf_path)
    sha = sha256_file(pdf_path)
    header = parse_header(ex.lines, ex.raw_page_text[0] if ex.raw_page_text else "")

    b = _Builder(ex.lines, ex.left_margin, ex.body_size)
    b.run()
    for p in b.paragraphs:
        p.subclauses = split_subclauses(p.text)

    variant = {"decimal": "decimal_numbered", "flat": "flat_numbered"}.get(b.scheme, "unnumbered")
    if variant == "flat_numbered" and any(re.match(r"^[^u]*\.\d", p.key) for p in b.paragraphs):
        variant = "flat_numbered_scoped"

    paragraphs = [p for p in b.paragraphs if p.text.strip() or p.subclauses]
    return ParsedDocument(
        doc_id=doc_id_for(sha), file_path=pdf_path, pdf_sha256=sha,
        rbi_ref=header["rbi_ref"], dept_code=header["dept_code"], date=header["date"],
        title=header["title"], last_updated_label=header["last_updated_label"],
        template_variant=variant,
        preamble="\n".join(b.preamble).strip(), preamble_page=b.preamble_page or 1,
        paragraphs=paragraphs, annexes=[a for a in b.annexes if a.text.strip() or a.title],
        footnotes=ex.footnotes, page_count=ex.page_count,
        first_page_text=ex.raw_page_text[0] if ex.raw_page_text else "",
    )


if __name__ == "__main__":
    import sys
    d = parse_document(sys.argv[1])
    print(f"ref={d.rbi_ref!r} date={d.date!r} updated={d.last_updated_label!r}\ntitle={d.title!r}\n"
          f"dept={d.dept_code!r} variant={d.template_variant} pages={d.page_count} paras={len(d.paragraphs)} "
          f"annexes={len(d.annexes)} footnotes={len(d.footnotes)} preamble_chars={len(d.preamble)}")
    show = sys.argv[2] if len(sys.argv) > 2 else ""
    for p in d.paragraphs:
        if not show or p.key == show or show == "all":
            print(f"--- [{p.key}] p{p.page}-{p.page_end} {' > '.join(p.heading_path)} subclauses={len(p.subclauses)}")
            print(p.text[:600] if show == "all" else p.text)
    for a in d.annexes:
        print(f"=== Annex {a.key}: {a.title[:80]} p{a.page}-{a.page_end} chars={len(a.text)}")
