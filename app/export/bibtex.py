"""Produce UTF-8 BibTeX with protected special characters."""

import hashlib
import re

from app.stages.deduplication import doi_key

ESCAPES = {"\\": r"\textbackslash{}", "&": r"\&", "%": r"\%", "$": r"\$", "#": r"\#", "_": r"\_",
           "{": r"\{", "}": r"\}", "~": r"\textasciitilde{}", "^": r"\textasciicircum{}",
           "‐": "-", "‑": "-"}

ENTRY_TYPES = {
    "article": ("article", "journal"),
    "review": ("article", "journal"),
    "letter": ("article", "journal"),
    "editorial": ("article", "journal"),
    "book": ("book", "publisher"),
    "book-chapter": ("incollection", "booktitle"),
    "proceedings-article": ("inproceedings", "booktitle"),
    "dissertation": ("phdthesis", "school"),
}
DEFAULT_ENTRY = ("misc", "howpublished")

VERBATIM_FIELDS = {"doi", "url"}


def latex_escape(value):
    return "".join(ESCAPES.get(letter, letter) for letter in str(value or ""))


def cite_key(paper):
    checksum = hashlib.sha256(str(paper.get("id") or paper.get("doi") or paper.get("title", "")).encode("utf-8")).hexdigest()[:12]
    year = str(paper.get("year") or "nodate")
    return "ref" + re.sub(r"\W", "", year) + checksum


def entry_type(paper):
    if paper.get("is_preprint") or paper.get("work_type") == "preprint":
        return DEFAULT_ENTRY
    return ENTRY_TYPES.get(paper.get("work_type") or "article", DEFAULT_ENTRY)


def to_bibtex(papers):
    entries = []
    for paper in papers:
        kind, venue_field = entry_type(paper)
        fields = {
            "title": paper.get("title"),
            "author": " and ".join(paper.get("authors") or []),
            "year": paper.get("year"),
            venue_field: paper.get("venue"),
            "doi": doi_key(paper.get("doi")),
            "url": paper.get("url"),
        }
        if kind == "misc" and paper.get("is_preprint"):
            fields["note"] = "Preprint"
        lines = ["@" + kind + "{" + cite_key(paper) + ","]
        for key, value in fields.items():
            if value:
                text = re.sub(r"[{}]", "", str(value)) if key in VERBATIM_FIELDS else latex_escape(value)
                lines.append("  " + key + " = {" + text + "},")
        lines.append("}")
        entries.append("\n".join(lines))
    return "\n\n".join(entries) + ("\n" if entries else "")
