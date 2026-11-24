"""Index local Crossref Retraction Watch update notices."""

import csv
from app.stages.deduplication import doi_key


class RetractionWatch:
    def __init__(self, path):
        self.records = {}
        with open(path, encoding="utf-8-sig", newline="") as handle:
            for row in csv.DictReader(handle):
                doi = doi_key(row.get("OriginalPaperDOI", ""))
                if doi and doi != "unavailable":
                    self.records.setdefault(doi, []).append({"type": row.get("RetractionNature", ""), "record_id": row.get("Record ID", ""), "notice_doi": row.get("RetractionDOI", "")})

    def get(self, doi):
        return self.records.get(doi_key(doi), [])
