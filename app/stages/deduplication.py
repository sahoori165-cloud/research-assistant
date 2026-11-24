"""Remove DOI, title, and preprint/publication duplicates."""

import re
from difflib import SequenceMatcher

STOPWORDS = frozenset("a an and are as at by for from in into of on or the to with via study research".split())


def doi_key(doi):
    return re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:)", "", str(doi or "").strip(), flags=re.I).lower().strip()


def title_key(title):
    tokens = re.findall(r"[^\W_]+", str(title or "").casefold(), flags=re.UNICODE)
    return " ".join(token for token in tokens if token not in STOPWORDS)


def is_duplicate(left, right, config):
    left_dois = {doi_key(v) for v in left.get("all_dois", []) + [left.get("doi", "")] if doi_key(v)}
    right_dois = {doi_key(v) for v in right.get("all_dois", []) + [right.get("doi", "")] if doi_key(v)}
    if left_dois & right_dois:
        return "same_doi"
    a, b = title_key(left.get("title", "")), title_key(right.get("title", ""))
    if not a or not b:
        return None
    similarity = SequenceMatcher(None, a, b).ratio()
    left_authors = author_keys(left)
    right_authors = author_keys(right)
    if left_authors and right_authors and left_authors.isdisjoint(right_authors):
        return None
    if bool(left.get("is_preprint")) != bool(right.get("is_preprint")) and similarity >= config.dedup_preprint_threshold:
        return "preprint_pair"
    if similarity >= config.dedup_title_threshold:
        return "same_title"
    return None


def author_keys(paper):
    return {" ".join(str(name).casefold().split()) for name in (paper.get("authors") or []) if str(name).strip()}


def _quality(paper):
    return (not paper.get("is_preprint", False), bool(paper.get("abstract")), len(paper.get("authors", [])), bool(paper.get("doi")), bool(paper.get("venue")))


def find_match(paper, existing, config):
    """Return (index, kind) of the record `paper` duplicates, or None.

    A shared DOI is definitive, so any DOI match wins over an earlier title-based match;
    otherwise the first title or preprint match in order is returned.
    """
    first_title_match = None
    for index, candidate in enumerate(existing):
        kind = is_duplicate(candidate, paper, config)
        if kind == "same_doi":
            return index, kind
        if kind and first_title_match is None:
            first_title_match = (index, kind)
    return first_title_match


def deduplicate(papers, config):
    output = []
    matches = {"same_doi": 0, "same_title": 0, "preprint_pair": 0}
    for paper in papers:
        duplicate = find_match(paper, output, config)
        if duplicate is None:
            output.append(dict(paper))
            continue
        index, kind = duplicate
        matches[kind] += 1
        old = output[index]
        primary, secondary = (paper, old) if _quality(paper) > _quality(old) else (old, paper)
        combined = dict(primary)
        combined["all_dois"] = list(dict.fromkeys(v for v in old.get("all_dois", []) + paper.get("all_dois", []) if v))
        combined["is_retracted_openalex"] = bool(old.get("is_retracted_openalex") or paper.get("is_retracted_openalex"))
        combined["merged_ids"] = list(dict.fromkeys(old.get("merged_ids", [old["id"]]) + paper.get("merged_ids", [paper["id"]])))
        if not combined.get("abstract"):
            combined["abstract"] = secondary.get("abstract", "")
        output[index] = combined
    return output, matches
