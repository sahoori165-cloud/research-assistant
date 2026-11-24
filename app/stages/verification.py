"""Combine three sources into attributable research-integrity status."""

from app.connectors.crossref import verify_batch
from app.connectors.retraction_watch import RetractionWatch
from app.stages.deduplication import doi_key


PRIORITY = {"clean": 0, "corrected": 1, "expression_of_concern": 2, "retracted": 3}


def classify(text):
    value = str(text or "").casefold().replace("-", " ").replace("_", " ")
    if "retract" in value or "withdraw" in value:
        return "retracted"
    if "concern" in value:
        return "expression_of_concern"
    if "correct" in value or "erratum" in value or "corrigendum" in value:
        return "corrected"
    return "clean"


def determine_status(paper, crossref_results, watch):
    sources = []
    all_dois = paper.get("all_dois") or [paper.get("doi", "")]
    all_dois = list(dict.fromkeys(doi_key(value) for value in all_dois if doi_key(value)))
    if paper.get("is_retracted_openalex"):
        sources.append({"source": "openalex", "status": "retracted", "detail": "is_retracted=true"})
    unresolved = not bool(all_dois)
    for doi in all_dois:
        result = crossref_results.get(doi, {"resolved": False, "metadata": {}, "error": "Crossref check unavailable"})
        if not result["resolved"]:
            unresolved = True
        else:
            for field in ("update-to", "updated-by"):
                for notice in result.get("metadata", {}).get(field, []) or []:
                    status = classify(notice.get("type") or notice.get("label"))
                    if status != "clean":
                        sources.append({"source": "crossref", "status": status, "detail": f"{field}: {notice.get('source', 'publisher')}", "doi": doi})
        if watch is not None:
            for notice in watch.get(doi):
                status = classify(notice["type"])
                if status != "clean":
                    sources.append({"source": "retraction_watch", "status": status, "detail": notice["record_id"], "doi": doi})
    score = max((PRIORITY[item["status"]] for item in sources), default=0)
    if score:
        status = next(key for key, value in PRIORITY.items() if value == score)
    else:
        status = "unverified" if unresolved or watch is None else "clean"
    complete = bool(all_dois) and not unresolved and watch is not None
    return {
        "status": status,
        "doi_resolved": bool(all_dois) and not unresolved,
        "verification_sources": sources,
        "verification_complete": complete,
        "sources_disagree": sources_disagree(status, sources, complete),
    }


def sources_disagree(status, sources, complete):
    """Return True when the sources tell different stories about the same paper.

    Either they report different statuses, or a paper is retracted according
    to some sources while another fully checked source has no notice. Each
    source is incomplete on its own, so such papers deserve a manual look.
    """
    if len({item["status"] for item in sources}) > 1:
        return True
    reporting = {item["source"] for item in sources}
    return status == "retracted" and complete and reporting != {"openalex", "crossref", "retraction_watch"}


def verify(papers, config, progress=None):
    errors = []
    try:
        watch = RetractionWatch(config.retraction_watch_csv)
    except (OSError, ValueError) as exc:
        watch = None
        errors.append({"stage": "verification", "message": f"Retraction Watch CSV missing or invalid: {exc}. Run python setup.py. Integrity checks are incomplete."})
    results = verify_batch(papers, config, progress)
    for paper in papers:
        paper.update(determine_status(paper, results, watch))
        for doi in paper.get("all_dois") or [paper.get("doi", "")]:
            record = results.get(doi_key(doi))
            if record and record.get("error"):
                errors.append({"stage": "verification", "paper_id": paper["id"], "message": f"{doi}: {record['error']}"})
    return papers, errors
