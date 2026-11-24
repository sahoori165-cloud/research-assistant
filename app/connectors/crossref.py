"""Resolve DOIs through Crossref, falling back to the DataCite registry for non-Crossref DOIs."""

import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import quote

import requests

from app.common import Cache, request_with_retry
from app.stages.deduplication import doi_key

HEADERS = {"User-Agent": "research-assistant/1.0 DOI verification"}


def _result(resolved, registry="", metadata=None, error=""):
    return {"resolved": resolved, "metadata": metadata or {}, "registry": registry, "error": error}


def lookup(doi, config):
    """Resolve one DOI; return a record with resolved/metadata/registry/error, never raise.

    Args:
        doi: DOI string in any common form (URL, `doi:` prefix, bare).
        config: Settings object providing Crossref/DataCite URLs, timeouts and retries.

    Returns:
        dict with keys resolved, metadata, registry and error.
    """
    normalized = doi_key(doi)
    if not normalized:
        return _result(False, error="Missing DOI")
    key = {"service": "doi_registry", "doi": normalized, "version": 2}
    cache = Cache(config.data_cache / "crossref")
    cached = cache.get(key)
    if cached is not None:
        return cached
    params = {"mailto": config.crossref_contact_email} if config.crossref_contact_email else {}
    try:
        with requests.Session() as session:
            return _resolve(session, normalized, key, cache, params, config)
    except (requests.RequestException, ValueError) as exc:
        return _result(False, error=str(exc))


def _resolve(session, normalized, key, cache, params, config):
    time.sleep(config.crossref_request_delay)
    response = request_with_retry(
        session, "GET", config.crossref_url + "/" + quote(normalized, safe=""),
        config.crossref_timeout, config.crossref_retries, params=params, headers=HEADERS,
    )
    if response.status_code != 404:
        response.raise_for_status()
        result = _result(True, "crossref", response.json().get("message", {}))
        cache.put(key, result)
        return result
    time.sleep(config.crossref_request_delay)
    datacite = request_with_retry(
        session, "GET", config.datacite_url + "/" + quote(normalized, safe=""),
        config.crossref_timeout, config.crossref_retries, headers=HEADERS,
    )
    if datacite.status_code == 404:
        result = _result(False, error="DOI not found in Crossref or DataCite")
    else:
        datacite.raise_for_status()
        result = _result(True, "datacite")
    cache.put(key, result)
    return result


def verify_batch(papers, config, progress=None):
    dois = sorted({
        doi_key(value)
        for paper in papers
        for value in (paper.get("all_dois") or [paper.get("doi", "")])
        if doi_key(value)
    })
    resolved = {}
    with ThreadPoolExecutor(max_workers=config.crossref_workers) as pool:
        jobs = {pool.submit(lookup, doi, config): doi for doi in dois}
        for index, job in enumerate(as_completed(jobs), 1):
            resolved[jobs[job]] = job.result()
            if progress and index % 20 == 0:
                progress("verification", f"Verified {index} of {len(dois)} distinct DOIs")
    return resolved
