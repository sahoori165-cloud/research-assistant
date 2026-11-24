"""Retrieve and normalise OpenAlex research records."""

import logging
import requests
from app.common import Cache, request_with_retry

LOGGER = logging.getLogger(__name__)


def unpack_abstract(index):
    if not isinstance(index, dict):
        return ""
    indexed = {}
    for word, positions in index.items():
        for position in positions:
            indexed[int(position)] = word
    return " ".join(word for _, word in sorted(indexed.items()))


def normalise_work(item):
    locations = item.get("locations") or []
    venue = (item.get("primary_location") or {}).get("source") or {}
    indicators = [str(location.get("landing_page_url") or "") + " " + str((location.get("source") or {}).get("type") or "") for location in locations]
    preprint = venue.get("type") == "repository" or (not venue.get("type") and any("arxiv.org" in v.lower() or "biorxiv" in v.lower() or "medrxiv" in v.lower() for v in indicators))
    authors = [entry.get("author", {}).get("display_name", "") for entry in (item.get("authorships") or [])]
    return {
        "id": item.get("id", ""),
        "title": item.get("display_name") or item.get("title") or "",
        "abstract": unpack_abstract(item.get("abstract_inverted_index")),
        "doi": item.get("doi") or "",
        "all_dois": [item.get("doi")] if item.get("doi") else [],
        "year": item.get("publication_year"),
        "authors": [name for name in authors if name],
        "venue": venue.get("display_name") or "",
        "work_type": item.get("type") or "",
        "is_preprint": bool(preprint),
        "is_retracted_openalex": bool(item.get("is_retracted")),
        "cited_by_count": int(item.get("cited_by_count") or 0),
        "url": (item.get("primary_location") or {}).get("landing_page_url") or item.get("id") or "",
    }


def search(query, config, session=None, progress=None):
    session = session or requests
    cache = Cache(config.data_cache / "openalex") if config.openalex_use_cache else None
    results, errors, cursor = [], [], "*"
    seen = set()
    while cursor and len(results) < config.openalex_max_results:
        size = min(config.openalex_page_size, config.openalex_max_results - len(results))
        params = {"search": query, "per_page": size, "cursor": cursor}
        if config.openalex_api_key:
            params["api_key"] = config.openalex_api_key
        if config.openalex_contact_email:
            params["mailto"] = config.openalex_contact_email
        key = {"service": "openalex", "query": query, "cursor": cursor, "size": size, "version": 1}
        page = cache.get(key) if cache else None
        if page is None:
            try:
                response = request_with_retry(session, "GET", config.openalex_url, config.openalex_timeout, config.openalex_retries, params=params)
                response.raise_for_status()
                page = response.json()
                if cache:
                    cache.put(key, page)
            except (requests.RequestException, ValueError) as exc:
                errors.append({"stage": "retrieval", "message": str(exc).replace(config.openalex_api_key, "[redacted]") if config.openalex_api_key else str(exc)})
                break
        batch = page.get("results") or []
        for raw in batch:
            item = normalise_work(raw)
            if item["id"] not in seen:
                seen.add(item["id"])
                results.append(item)
        next_cursor = (page.get("meta") or {}).get("next_cursor")
        if progress:
            progress("retrieval", f"Fetched {len(results)} candidate records")
        if not batch or next_cursor == cursor:
            break
        cursor = next_cursor
    LOGGER.info("OpenAlex candidates %d", len(results))
    return results[:config.openalex_max_results], errors
