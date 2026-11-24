"""Execute the seven-stage pipeline in a fixed, code-determined order."""

import logging

from app.common import PinnedModelError, set_seeds, verify_lock
from app.connectors.openalex import search as search_papers
from app.export.bibtex import to_bibtex
from app.export.csl_json import to_csl_json
from app.models.embeddings import SimilarityEngine
from app.models.ollama_client import OllamaClient
from app.models.reranker import Reranker
from app.pipeline.errors import normalise_errors
from app.stages.clustering import group_papers
from app.stages.deduplication import deduplicate
from app.stages.summarisation import summarise
from app.stages.verification import verify

logger = logging.getLogger(__name__)

STAGES = ("retrieval", "deduplication", "reranking", "verification", "clustering", "summarisation")


def _payload(question, papers, clusters, errors, completed, stage, dedup_counts=None):
    trends = [
        {"cluster_id": cluster["cluster_id"], "label": cluster.get("label", ""), "trends": cluster.get("trends", [])}
        for cluster in clusters
    ]
    return {
        "question": question,
        "results": papers,
        "clusters": clusters,
        "trends": trends,
        "bibtex": to_bibtex(papers),
        "csl_json": to_csl_json(papers),
        "returned": len(papers),
        "deduplication": dedup_counts or {},
        "completed_stages": completed,
        "stage": stage,
        "partial": stage != "complete",
        "errors": normalise_errors(errors, "error" if stage == "failed" else "warning"),
    }


def run_pipeline(question, config, progress=None):
    errors, completed = [], []

    def report(stage, message):
        logger.info("%s: %s", stage, message)
        if progress:
            progress(stage, message)

    verify_lock(config)
    set_seeds(config)

    report("retrieval", "Searching OpenAlex")
    papers, retrieval_errors = search_papers(question, config, progress=report)
    errors.extend(retrieval_errors)
    if not papers:
        if not retrieval_errors:
            errors.append({"stage": "retrieval", "message": "OpenAlex returned no papers for this question"})
        report("failed", "Returned 0 papers")
        return _payload(question, [], [], errors, completed, "failed")
    completed.append("retrieval")

    report("deduplication", f"Checking {len(papers)} paper records")
    unique, dedup_counts = deduplicate(papers, config)
    completed.append("deduplication")

    candidates = unique[:config.rerank_candidates]
    if len(candidates) < config.rerank_candidates:
        errors.append({"stage": "retrieval", "message": (
            f"Only {len(candidates)} unique candidates were found (target {config.rerank_candidates}); "
            "results may miss relevant papers. Try a broader question.")})
    report("reranking", f"Ranking {len(candidates)} unique papers")
    try:
        ranked = Reranker(config).rank(question, candidates)
        completed.append("reranking")
    except PinnedModelError:
        raise
    except Exception as exc:
        logger.exception("Reranking failed")
        errors.append({"stage": "reranking", "message": f"Reranking failed; papers keep OpenAlex order: {exc}"})
        ranked = [dict(paper, relevance_score=None) for paper in candidates]
    selected = ranked[:config.top_k]

    report("verification", f"Checking {len(selected)} ranked papers")
    try:
        verified, verification_errors = verify(selected, config, report)
        errors.extend(verification_errors)
        completed.append("verification")
    except Exception as exc:
        logger.exception("Verification failed")
        errors.append({"stage": "verification", "message": f"Verification failed; every paper is unverified: {exc}"})
        verified = [dict(paper, status="unverified", verification_complete=False) for paper in selected]

    report("clustering", f"Grouping {len(verified)} verified paper records")
    try:
        verified, clusters = group_papers(verified, config, SimilarityEngine(config))
        completed.append("clustering")
    except PinnedModelError:
        raise
    except Exception as exc:
        logger.exception("Clustering failed")
        errors.append({"stage": "clustering", "message": f"Clustering failed; no themes or trends: {exc}"})
        clusters = []

    if clusters:
        report("summarisation", "Generating grounded cluster summaries")
        clusters, summary_errors = summarise(clusters, verified, OllamaClient(config), report)
        errors.extend(summary_errors)
        completed.append("summarisation")

    stage = "complete" if not errors and len(completed) == len(STAGES) else "partial"
    report(stage, f"Returned {len(verified)} papers")
    return _payload(question, verified, clusters, errors, completed, stage, dedup_counts)


def execute(question, config, progress=None):
    if not isinstance(question, str) or not question.strip():
        return _payload("", [], [], [{"stage": "input", "message": "A research question is required"}], [], "failed")
    try:
        return run_pipeline(question.strip(), config, progress)
    except PinnedModelError as exc:
        logger.error("Pinned model check failed: %s", exc)
        return _payload(question, [], [], [{"stage": "models", "message": str(exc)}], [], "failed")
    except Exception as exc:
        logger.exception("Pipeline failed")
        return _payload(question, [], [], [{"stage": "pipeline", "message": str(exc)}], [], "failed")


def run(question, config, progress=None):
    return execute(question, config, progress)
