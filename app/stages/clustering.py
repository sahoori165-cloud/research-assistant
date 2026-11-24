"""Select 4 to 8 themes by silhouette score and compute ten-year publication trends."""

from datetime import datetime, timezone


def choose_k(vectors, config):
    """Score k-means for k in the search range, keep the best silhouette, clamp it to the allowed range.

    Args:
        vectors: Embedding matrix, one row per paper.
        config: Settings with cluster_search_min/max, cluster_min/max, cluster_n_init and seed.

    Returns:
        (k, labels, scores) where scores maps each searched k to its silhouette score.
    """
    from sklearn.cluster import KMeans
    from sklearn.metrics import silhouette_score

    def fit(k):
        return KMeans(n_clusters=k, random_state=config.seed, n_init=config.cluster_n_init).fit_predict(vectors)

    count = len(vectors)
    labels_by_k, scores = {}, {}
    for k in range(config.cluster_search_min, min(config.cluster_search_max, count - 1) + 1):
        labels = fit(k)
        if len(set(labels)) > 1:
            labels_by_k[k] = labels
            scores[k] = float(silhouette_score(vectors, labels))
    if not scores:
        raise ValueError("Unable to form distinct semantic clusters")
    best = sorted(scores, key=lambda k: (-scores[k], k))[0]
    k = max(config.cluster_min, min(config.cluster_max, best, count - 1))
    labels = labels_by_k.get(k)
    if labels is None:
        labels = fit(k)
    return k, labels, scores


def group_papers(papers, config, embedder):
    import numpy as np
    from sklearn.feature_extraction.text import TfidfVectorizer

    if len(papers) <= config.cluster_min:
        raise ValueError(f"At least {config.cluster_min + 1} papers are required for {config.cluster_min} to {config.cluster_max} clusters")
    texts = [(item.get("title") or "") + ". " + (item.get("abstract") or "") for item in papers]
    vectors = embedder.embed(texts)
    k, labels, _ = choose_k(vectors, config)
    for item, label in zip(papers, labels):
        item["cluster_id"] = int(label)
    now = datetime.now(timezone.utc).year
    years = list(range(now - config.trend_years + 1, now + 1))
    output = []
    for cluster_id in range(k):
        members = [item for item in papers if item["cluster_id"] == cluster_id]
        corpus = [(item.get("title") or "") + " " + (item.get("abstract") or "") for item in members]
        label = "Theme " + str(cluster_id + 1)
        try:
            fit = TfidfVectorizer(stop_words="english", max_features=1000, ngram_range=(1, 2))
            matrix = fit.fit_transform(corpus)
            indices = np.argsort(matrix.sum(axis=0).A1)[::-1][:3]
            label = " / ".join(fit.get_feature_names_out()[index] for index in indices)
        except ValueError:
            pass
        trends = [
            {"year": year, "count": sum(item.get("year") == year for item in members),
             "incomplete": year > now - config.incomplete_years}
            for year in years
        ]
        output.append({"cluster_id": cluster_id, "label": label, "count": len(members), "trends": trends,
                       "paper_ids": [item["id"] for item in members]})
    return papers, output
