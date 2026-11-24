"""Synthesise each cluster from verified, supplied abstracts only."""

from app.common import PinnedModelError, ServiceUnavailableError


def summarise(clusters, papers, client, progress=None):
    """Attach structured summaries to each cluster.

    A missing or changed pinned model stops the run. If Ollama cannot be
    reached, every theme is returned without a summary and one error says so,
    so the ranked and verified papers are not lost. Other failures become
    per-theme errors.
    """
    errors = []
    for position, cluster in enumerate(clusters, 1):
        if progress:
            progress("summarisation", f"Summarising theme {position} of {len(clusters)}")
        try:
            cluster["synthesis"] = client.synthesise(cluster, papers)
        except PinnedModelError:
            raise
        except ServiceUnavailableError as exc:
            for rest in clusters[position - 1:]:
                rest["synthesis"] = None
            errors.append({"stage": "summarisation", "message": f"No summaries: {exc}"})
            break
        except Exception as exc:
            errors.append({"stage": "summarisation", "cluster_id": cluster["cluster_id"], "message": str(exc)})
            cluster["synthesis"] = None
    return clusters, errors
