"""Embed research records using the locked Qwen encoder."""

from app.common import Cache, hf_snapshot, shared_model


class SimilarityEngine:
    def __init__(self, config):
        self.config = config
        self.model = None
        self.cache = Cache(config.evaluation_cache / "embeddings")

    def _load(self):
        if self.model is None:
            def load():
                from sentence_transformers import SentenceTransformer
                return SentenceTransformer(hf_snapshot(self.config.embedding_model, self.config.embedding_revision))
            self.model = shared_model(("embeddings", self.config.embedding_model, self.config.embedding_revision), load)
        return self.model

    def embed(self, texts):
        import numpy as np
        vectors = [None] * len(texts)
        pending, positions, keys = [], [], []
        for index, value in enumerate(texts):
            key = {"model": self.config.embedding_model, "revision": self.config.embedding_revision, "parameters": {"normalise": True}, "text": value}
            cached = self.cache.get(key)
            if cached is None:
                pending.append(value)
                positions.append(index)
                keys.append(key)
            else:
                vectors[index] = cached
        if pending:
            outputs = self._load().encode(pending, batch_size=self.config.embedding_batch_size, show_progress_bar=False, normalize_embeddings=True)
            for index, key, value in zip(positions, keys, outputs):
                vectors[index] = value.tolist()
                self.cache.put(key, vectors[index])
        return np.array(vectors, dtype=float)

    def similarity_matrix(self, texts):
        vectors = self.embed(texts)
        return vectors @ vectors.T
