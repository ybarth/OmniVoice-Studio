from pathlib import Path

import yaml


def test_model_catalog_lists_hymt_translation_models():
    catalog_path = Path(__file__).resolve().parents[1] / "backend" / "config" / "models.yaml"
    rows = yaml.safe_load(catalog_path.read_text(encoding="utf-8"))["models"]
    by_repo = {row["repo_id"]: row for row in rows}

    assert by_repo["tencent/HY-MT1.5-1.8B"]["role"] == "Translation"
    assert by_repo["tencent/HY-MT1.5-7B"]["role"] == "Translation"
    assert by_repo["tencent/HY-MT1.5-1.8B"]["size_gb"] > 0
    assert by_repo["tencent/HY-MT1.5-7B"]["size_gb"] > by_repo["tencent/HY-MT1.5-1.8B"]["size_gb"]
