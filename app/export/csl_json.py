"""Convert paper metadata to CSL-JSON."""

from app.export.bibtex import cite_key
from app.stages.deduplication import doi_key

CSL_TYPES = {
    "article": "article-journal", "review": "article-journal", "letter": "article-journal",
    "editorial": "article-journal", "book": "book", "book-chapter": "chapter",
    "proceedings-article": "paper-conference", "dissertation": "thesis",
}


def to_csl_json(papers):
    records = []
    for paper in papers:
        kind = "article" if paper.get("is_preprint") else CSL_TYPES.get(paper.get("work_type") or "article", "article")
        item = {"id": cite_key(paper), "type": kind, "title": paper.get("title") or "", "author": [{"literal": name} for name in paper.get("authors", [])], "container-title": paper.get("venue") or "", "DOI": doi_key(paper.get("doi")), "URL": paper.get("url") or ""}
        if paper.get("year"):
            item["issued"] = {"date-parts": [[int(paper["year"])]]}
        records.append(item)
    return records
