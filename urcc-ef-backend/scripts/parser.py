"""
Structure-aware parser for RBI Master Directions / Circulars.

Design principle: extraction is DETERMINISTIC (regex + layout rules) wherever
the document's own drafting template makes it possible. No LLM calls happen
in this file. Anything the deterministic parser can't resolve with confidence
is tagged for escalation (see rule_extractor.py) rather than guessed.

Observed template (confirmed across 266 real RBI PDFs spanning 12 institution
categories):

    RBI/<dept>/<FY>/<num>                       <-- circular reference no.
    <DEPT.CODE>.<...>/<...>/<FY>        <date>    <-- department code + date
    <blank>
    Reserve Bank of India (<Institution> - <Topic>) Directions, <year>
    <blank>
    Table of Contents
    Chapter I[:–-] Preliminary ......... <page>
       A. Short title and commencement ......... <page>
       B. Applicability ......... <page>
       C. Definitions ......... <page>
    Chapter II ...
    <blank>
    In exercise of the powers conferred by Section 35A ... (preamble)
    Chapter I: Preliminary
    A. Short Title and Commencement
    1.   These Directions shall be called ...
    2.   These Directions shall come into effect ...
    B. Applicability
    3.   These Directions shall be applicable to ...
    C. Definitions
    4.   For the purpose of these Directions ...
        (1) 'Term' means ...
        (2) 'Term' means ...
    Chapter II: <Title>
    5. ...
    ...
    Annex I: <Title>                 (Refer Paragraph N(M))

Numbering is CONTINUOUS across the whole document (paragraph numbers are not
reset per chapter) - confirmed on multiple documents. This is what makes a
flat, document-wide clause_uri scheme like rbi://<doc_id>/para<N> viable.
"""
import re
import subprocess
import hashlib
from dataclasses import dataclass, field
from pathlib import Path

# ---------------------------------------------------------------------------
# Regex patterns, built directly from the observed corpus (see notes above)
# ---------------------------------------------------------------------------

RE_RBI_REF = re.compile(r'RBI/(?:[\w\-]+/)?\d{4}-\d{2}/\d+')
RE_DEPT_CODE = re.compile(r'^([A-Z]{2,6}(?:\.[\w\-]+)+/\d{2}[-.]\d{2}[-.]\d{3}/\d{4}-\d{2})')
RE_DATE = re.compile(r'([A-Z][a-z]+ \d{1,2},\s*\d{4})\s*$')

# "Chapter I: Preliminary" / "Chapter I Preliminary" / "Chapter I – Preliminary"
# Also tolerates "Chatper" - a confirmed real typo in at least one published
# RBI PDF (Small Finance Banks - KYC Directions). Source documents are not
# perfectly proofread; a rigid parser that only accepts the correct spelling
# silently drops the entire document's clause structure over one typo, which
# is a worse failure mode than a slightly loose regex.
RE_CHAPTER = re.compile(
    r'^\s*Cha(?:pter|tper)\s+([IVXLCDM]+)\s*[:\-–]?\s*(.*?)\s*\.{0,}\s*\d*\s*$', re.IGNORECASE)

# "A. Short Title and Commencement"  (section letter, NOT a numbered paragraph)
# Trailing period is optional - some documents write "A. Applicability" and
# others "A. Applicability." (confirmed both forms in the corpus).
RE_SECTION = re.compile(r'^\s*([A-H])\.\s+([A-Za-z][^.]{2,90}?)\.?\s*$')

# "77.   An RRB's incremental investment ..."  (top-level numbered paragraph)
RE_PARAGRAPH = re.compile(r'^\s*(\d{1,3})\.\s+(\S.*)$')

# "(1)   'Available for Sale' (AFS) means ..." (sub-clause / definition entry)
RE_SUBCLAUSE = re.compile(r'^\s*\((\d{1,2})\)\s+(\S.*)$')

# "Annex I: Reconciliation Statement" / "Annex I"
RE_ANNEX = re.compile(r'^\s*Annex\s+([IVXLCDM]+)\s*[:\-–]?\s*(.*)$', re.IGNORECASE)

# Cross-reference: "paragraph 15(1)", "paragraphs 36 to 42", "Paragraph 98(3)"
RE_CROSSREF = re.compile(
    r'[Pp]aragraphs?\s+(\d{1,3})(?:\((\d{1,2})\))?(?:\s+to\s+(\d{1,3}))?')

# Definition entry inside a Definitions sub-clause:  'Term' means / shall mean
RE_DEFINITION = re.compile(
    r'^[\u2018\u2019\'\u201c\u201d"]([^\u2018\u2019\'\u201c\u201d"]{2,120})[\u2018\u2019\'\u201c\u201d"]\s*'
    r'(?:\([^)]*\)\s*)?(means|shall mean|shall have the (?:same )?meaning)', re.IGNORECASE)

RE_PROVISO = re.compile(r'^\s*Provided (that|further)', re.IGNORECASE)


@dataclass
class Paragraph:
    number: int
    text: str
    page: int
    chapter_roman: str
    chapter_title: str
    section_letter: str
    section_title: str
    subclauses: list = field(default_factory=list)   # [(sub_no, text, page)]
    is_definitions_paragraph: bool = False
    is_proviso_continuation: bool = False


@dataclass
class ParsedDocument:
    doc_id: str
    file_path: str
    rbi_ref: str
    dept_code: str
    date: str
    title: str
    institution_category: str
    toc: list                 # [(level, label, title, page)]
    paragraphs: list          # [Paragraph]
    annexes: list             # [(roman, title, refers_to_paragraph, text, page)]
    raw_pages: list           # list[str] page text, 0-indexed


def _pdftotext_pages(pdf_path: str) -> list[str]:
    """One subprocess call per document; split on the form-feed page marker
    pdftotext already emits. Far cheaper than one call per page."""
    out = subprocess.run(
        ["pdftotext", "-layout", pdf_path, "-"],
        capture_output=True, text=True, timeout=120
    ).stdout
    pages = out.split("\f")
    if pages and pages[-1].strip() == "":
        pages = pages[:-1]
    return pages


def _doc_id(pdf_path: str) -> str:
    return hashlib.sha1(pdf_path.encode()).hexdigest()[:16]


def parse_header(pages: list[str]) -> dict:
    """First ~15 lines of page 1 contain ref number, dept code+date, title."""
    head_lines = [l for l in pages[0].splitlines()[:20] if l.strip()]
    rbi_ref, dept_code, date, title_lines = "", "", "", []
    title_started = False
    for line in head_lines:
        if not rbi_ref and RE_RBI_REF.search(line):
            rbi_ref = RE_RBI_REF.search(line).group(0)
            continue
        if not dept_code and RE_DEPT_CODE.search(line):
            dept_code = RE_DEPT_CODE.search(line).group(1)
            m = RE_DATE.search(line)
            if m:
                date = m.group(1)
            continue
        if "table of contents" in line.lower():
            break
        # Skip the Hindi masthead + "RESERVE BANK OF INDIA" banner line only
        # (the banner is a short standalone line; the actual title line often
        # *starts* with "Reserve Bank of India (...)" so a substring check
        # would wrongly eat the first line of the title too).
        if line.strip().upper() == "RESERVE BANK OF INDIA" or "रिज़र्व बैंक" in line or "रज़वर" in line:
            continue
        if rbi_ref or dept_code:  # only start collecting title after header found
            title_started = True
        if title_started:
            title_lines.append(line.strip())
    title = " ".join(title_lines).strip()
    return {"rbi_ref": rbi_ref, "dept_code": dept_code, "date": date, "title": title}


def parse_toc(pages: list[str]) -> list:
    """Parse the Table of Contents block (present in every document in the
    corpus) into a structural index: [(level, label, title, page_num)].
    This index is used both as a navigation aid and as a validation check
    against headers actually detected in the body (see validate_structure)."""
    toc_entries = []
    in_toc = False
    for page in pages[:3]:  # TOC always lands in the first 1-3 pages
        for line in page.splitlines():
            if "table of contents" in line.lower():
                in_toc = True
                continue
            if not in_toc:
                continue
            # stop once body content starts (preamble line, no dotted leader)
            if re.match(r'^\s*In exercise of the powers', line):
                in_toc = False
                break
            page_num_m = re.search(r'(\d{1,4})\s*$', line.strip())
            if not page_num_m:
                continue
            page_num = int(page_num_m.group(1))
            chap_m = RE_CHAPTER.match(line)
            if chap_m:
                toc_entries.append(("chapter", chap_m.group(1), chap_m.group(2).strip(" ."), page_num))
                continue
            sec_m = RE_SECTION.match(line.strip())
            if sec_m:
                toc_entries.append(("section", sec_m.group(1), sec_m.group(2).strip(" ."), page_num))
                continue
            annex_m = RE_ANNEX.match(line)
            if annex_m:
                toc_entries.append(("annex", annex_m.group(1), annex_m.group(2).strip(" ."), page_num))
    return toc_entries


def parse_body(pages: list[str]) -> tuple[list, list]:
    """Walk the document body line by line, tracking current chapter/section
    context, and split into numbered-paragraph clause units. This is the
    'legal boundary chunking' step: a clause never gets split mid-paragraph
    because the unit of segmentation IS the paragraph's own number, not a
    fixed token window."""
    paragraphs: list[Paragraph] = []
    annexes = []

    cur_chapter_roman, cur_chapter_title = "", ""
    cur_section_letter, cur_section_title = "", ""
    cur_para: Paragraph | None = None
    in_annex = False
    cur_annex = None
    body_started = False
    chapter_roman_seen_count: dict[str, int] = {}

    for page_idx, page_text in enumerate(pages):
        page_no = page_idx + 1
        for raw_line in page_text.splitlines():
            line = raw_line.rstrip()
            stripped = line.strip()
            if not stripped:
                continue

            if not body_started:
                # Trigger 1: most "Directions" documents open with a
                # statutory-power preamble ("In exercise of the powers..." /
                # "Accordingly, in exercise of the powers...").
                # Trigger 2: "Guidelines" documents carry no such preamble
                # and go straight from the TOC into "Chapter I: <title>".
                # Distinguishing a real chapter heading from the SAME text
                # inside the TOC by "does this line end in a page number" is
                # NOT reliable - long chapter titles wrap across two TOC
                # lines, so the line bearing "Chapter IX" sometimes ends in
                # nothing but the title's own hyphen, not a page number.
                # The robust signal instead: a chapter's roman numeral is
                # guaranteed to appear once in the TOC and once for real in
                # the body - so the SECOND time a given roman numeral is
                # seen is the real heading, regardless of line wrapping.
                if re.search(r'in exercise of the powers', stripped, re.IGNORECASE):
                    body_started = True
                    continue
                chap_probe = RE_CHAPTER.match(stripped)
                if chap_probe:
                    roman = chap_probe.group(1)
                    chapter_roman_seen_count[roman] = chapter_roman_seen_count.get(roman, 0) + 1
                    if chapter_roman_seen_count[roman] >= 2:
                        body_started = True
                        # fall through - process this line as the real heading below
                    else:
                        continue
                else:
                    continue

            annex_m = RE_ANNEX.match(stripped)
            if annex_m:
                if cur_para:
                    paragraphs.append(cur_para)
                    cur_para = None
                in_annex = True
                cur_annex = {"roman": annex_m.group(1), "title": annex_m.group(2).strip(),
                             "page": page_no, "text_lines": [], "refers_to_paragraph": None}
                annexes.append(cur_annex)
                continue

            if in_annex and cur_annex is not None:
                ref = RE_CROSSREF.search(stripped)
                if ref and cur_annex["refers_to_paragraph"] is None:
                    cur_annex["refers_to_paragraph"] = int(ref.group(1))
                cur_annex["text_lines"].append(stripped)
                continue

            chap_m = RE_CHAPTER.match(stripped)
            if chap_m and len(chap_m.group(1)) <= 6:
                if cur_para:
                    paragraphs.append(cur_para)
                    cur_para = None
                cur_chapter_roman, cur_chapter_title = chap_m.group(1), chap_m.group(2).strip(" .")
                cur_section_letter, cur_section_title = "", ""
                continue

            sec_m = RE_SECTION.match(stripped)
            if sec_m:
                if cur_para:
                    paragraphs.append(cur_para)
                    cur_para = None
                cur_section_letter, cur_section_title = sec_m.group(1), sec_m.group(2).strip(" .")
                continue

            para_m = RE_PARAGRAPH.match(line)
            if para_m:
                if cur_para:
                    paragraphs.append(cur_para)
                cur_para = Paragraph(
                    number=int(para_m.group(1)), text=para_m.group(2),
                    page=page_no, chapter_roman=cur_chapter_roman,
                    chapter_title=cur_chapter_title,
                    section_letter=cur_section_letter, section_title=cur_section_title,
                    is_definitions_paragraph=("definition" in cur_section_title.lower()),
                )
                continue

            sub_m = RE_SUBCLAUSE.match(line)
            if sub_m and cur_para is not None:
                cur_para.subclauses.append((int(sub_m.group(1)), sub_m.group(2), page_no))
                continue

            if RE_PROVISO.match(stripped) and cur_para is not None:
                cur_para.text += " " + stripped
                cur_para.is_proviso_continuation = True
                continue

            # Continuation of the current paragraph or its last sub-clause
            if cur_para is not None:
                if cur_para.subclauses:
                    n, t, p = cur_para.subclauses[-1]
                    cur_para.subclauses[-1] = (n, t + " " + stripped, p)
                else:
                    cur_para.text += " " + stripped

    if cur_para:
        paragraphs.append(cur_para)
    for a in annexes:
        a["text"] = " ".join(a.pop("text_lines"))
    return paragraphs, annexes


# ---------------------------------------------------------------------------
# Legacy template (2016-2018 vintage "Master Direction" circular-letters).
# Confirmed present in the uploaded corpus: 35 of 266 documents use "Section
# I / Section II" top-level headers and DECIMAL numbering ("1.2.1") instead
# of "Chapter <roman>" + flat paragraph numbers. Detected separately and
# routed to its own parse path rather than forced through the same regexes,
# since forcing one template onto the other silently drops content instead
# of failing loudly.
# ---------------------------------------------------------------------------

RE_SECTION_ROMAN = re.compile(r'^\s*Section\s+([IVXLCDM]+)\s*[:\-–]?\s*(.*)$', re.IGNORECASE)
RE_DECIMAL = re.compile(r'^\s*(\d+(?:\.\d+){0,3})\s+(\S.*)$')


def is_legacy_template(pages: list[str]) -> bool:
    """A document is 'legacy' if it has no 'Chapter <roman>' headers ANYWHERE
    (checked across the full document, since front matter length varies --
    some of these older circulars carry a 1-2 page cover letter before the
    TOC even starts) but does have 'Section <roman>' headers. Line-anchored
    match, not a substring search on a joined blob, to avoid false hits from
    wrapped text."""
    has_chapter = False
    has_section_roman = False
    for page in pages:
        for line in page.splitlines():
            s = line.strip()
            if not s:
                continue
            if RE_CHAPTER.match(s):
                has_chapter = True
            if RE_SECTION_ROMAN.match(s):
                has_section_roman = True
        if has_chapter:  # a single real Chapter header rules out legacy path
            return False
    return has_section_roman


def parse_body_legacy(pages: list[str]) -> tuple[list, list]:
    """Clause unit = any decimally-numbered line (e.g. '1.2.1'). The decimal
    string itself is the paragraph 'number' (kept as a string, not an int,
    since e.g. '1.2.1' has no meaningful int form) -- everything else about
    the Paragraph/clause_uri model stays the same downstream."""
    paragraphs: list[Paragraph] = []
    annexes = []
    cur_section_roman, cur_section_title = "", ""
    cur_para: Paragraph | None = None
    in_annex = False
    cur_annex = None
    body_started = False

    for page_idx, page_text in enumerate(pages):
        page_no = page_idx + 1
        for raw_line in page_text.splitlines():
            stripped = raw_line.strip()
            if not stripped:
                continue

            if not body_started:
                if re.search(r'in exercise of the powers|introduced the system|for the purpose of (this|these)', stripped, re.IGNORECASE) or RE_SECTION_ROMAN.match(stripped):
                    body_started = True
                else:
                    continue

            annex_m = RE_ANNEX.match(stripped)
            if annex_m:
                if cur_para:
                    paragraphs.append(cur_para); cur_para = None
                in_annex = True
                cur_annex = {"roman": annex_m.group(1), "title": annex_m.group(2).strip(),
                             "page": page_no, "text_lines": [], "refers_to_paragraph": None}
                annexes.append(cur_annex)
                continue
            if in_annex and cur_annex is not None:
                cur_annex["text_lines"].append(stripped)
                continue

            sec_m = RE_SECTION_ROMAN.match(stripped)
            if sec_m:
                if cur_para:
                    paragraphs.append(cur_para); cur_para = None
                cur_section_roman, cur_section_title = sec_m.group(1), sec_m.group(2).strip(" .")
                continue

            dec_m = RE_DECIMAL.match(stripped)
            if dec_m:
                if cur_para:
                    paragraphs.append(cur_para)
                cur_para = Paragraph(
                    number=dec_m.group(1), text=dec_m.group(2), page=page_no,
                    chapter_roman=cur_section_roman, chapter_title=cur_section_title,
                    section_letter="", section_title="",
                    is_definitions_paragraph=("definition" in dec_m.group(2).lower()[:40]),
                )
                continue

            if cur_para is not None:
                cur_para.text += " " + stripped

    if cur_para:
        paragraphs.append(cur_para)
    for a in annexes:
        a["text"] = " ".join(a.pop("text_lines"))
    return paragraphs, annexes


def parse_document(pdf_path: str, institution_category: str) -> ParsedDocument:
    pages = _pdftotext_pages(pdf_path)
    header = parse_header(pages)
    toc = parse_toc(pages)
    if is_legacy_template(pages):
        paragraphs, annexes = parse_body_legacy(pages)
    else:
        paragraphs, annexes = parse_body(pages)
    return ParsedDocument(
        doc_id=_doc_id(pdf_path), file_path=pdf_path,
        rbi_ref=header["rbi_ref"], dept_code=header["dept_code"], date=header["date"],
        title=header["title"], institution_category=institution_category,
        toc=toc, paragraphs=paragraphs, annexes=annexes, raw_pages=pages,
    )
