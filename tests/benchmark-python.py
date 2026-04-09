#!/usr/bin/env python3
"""
Python performance benchmark — same operations as test-benchmark.ts.

Uses ChromaDB (the Python original's storage layer) with the default
all-MiniLM-L6-v2 model. Mirrors the TypeScript benchmark exactly:

  - Same sample texts
  - Same palace sizes (100, 1K, 5K, 10K)
  - Same metric set: insert / cold / warm / filtered query latency
  - Same wing distribution (10% pig / 20% graff / 70% general)

Run:
  pip install chromadb -i https://pypi.org/simple/
  python tests/benchmark-python.py
"""

import os
import shutil
import sys
import tempfile
import time

import chromadb

# Same 20 sample texts as the TypeScript benchmark
SAMPLE_TEXTS = [
    "今天和小猪聊了一下午的旧物件收藏，他对机械表特别有研究",
    "Graff提议下次去咖啡店见面，他最近在看一本关于拉丁语的书",
    "决定改用 GraphQL 替代 REST API，因为查询灵活性更好",
    "修复了 Windows 上的原生模块编译问题，需要 pathToFileURL",
    "用户反馈说深色模式下的对比度不够，需要调整 CSS 变量",
    "会议讨论了下季度的 OKR，重点是用户增长和留存率",
    "阅读了《人类简史》第三章，讲的是认知革命如何改变了人类",
    "今天天气很好，去公园散步看到了梅花开了",
    "调试了一整天的 WebSocket 连接问题，最后发现是防火墙在搞鬼",
    "小猪推荐了一部老电影，《重庆森林》，王家卫的代表作之一",
    "尝试了新的咖啡豆烘焙方法，浅烘的酸度比想象中还要明亮",
    "研究 Rust 的 ownership 模型，跟 C++ 的智能指针思路有相似之处",
    "春天来了，决定养几盆多肉植物，从最容易的种类开始",
    "会计报告显示这个月的开销超出了预算，主要是订阅服务太多",
    "看完了纪录片《地球脉动》的第二季，海洋那一集特别震撼",
    "试了一下新的 Vim 配置，加了 Telescope 和 LSP，效率提升明显",
    "收到了订购的二手书，是钱钟书的《围城》，封面有点旧但内容完好",
    "健身教练建议增加力量训练，每周三次复合动作为主",
    "调研了几款向量数据库，最后选了 SQLite 加自研的相似度计算",
    "夜里失眠的时候听了一段巴赫的平均律，心情慢慢平静下来",
]


def generate_text(seed: int) -> str:
    base = SAMPLE_TEXTS[seed % len(SAMPLE_TEXTS)]
    return f"{base} (record #{seed})"


def heap_mb() -> int:
    """Best-effort RSS in MB (psutil if available, otherwise resource module)."""
    try:
        import psutil  # type: ignore
        return int(psutil.Process().memory_info().rss / 1024 / 1024)
    except ImportError:
        try:
            import resource  # POSIX only
            kb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            # macOS reports bytes, Linux reports KB — normalize
            return int(kb / 1024 / 1024) if kb > 1_000_000 else int(kb / 1024)
        except Exception:
            return 0


def run_benchmark(size: int, palace_root: str) -> dict:
    palace_path = os.path.join(palace_root, f"palace-{size}")
    if os.path.exists(palace_path):
        shutil.rmtree(palace_path)

    client = chromadb.PersistentClient(path=palace_path)
    col = client.create_collection("mempalace_drawers")

    peak_heap = heap_mb()

    # ── Insert ─────────────────────────────────────────────────────────
    insert_start = time.time()
    BATCH = 100
    for batch_start in range(0, size, BATCH):
        batch_end = min(batch_start + BATCH, size)
        ids = []
        docs = []
        metas = []
        for i in range(batch_start, batch_end):
            wing = "pig" if i < size * 0.1 else "graff" if i < size * 0.3 else "general"
            room = ["tech", "personal", "general"][i % 3]
            ids.append(f"d{i}")
            docs.append(generate_text(i))
            metas.append({"wing": wing, "room": room})
        col.upsert(ids=ids, documents=docs, metadatas=metas)
        peak_heap = max(peak_heap, heap_mb())
    insert_sec = time.time() - insert_start
    insert_rate = round(size / insert_sec)

    peak_heap = max(peak_heap, heap_mb())

    # ── Cold query (recreate client to drop in-memory caches) ──────────
    del col
    del client
    client2 = chromadb.PersistentClient(path=palace_path)
    col2 = client2.get_collection("mempalace_drawers")

    cold_t = time.time()
    col2.query(query_texts=["小猪喜欢的旧物件"], n_results=5)
    cold_ms = int((time.time() - cold_t) * 1000)

    # ── Warm query ────────────────────────────────────────────────────
    warm_t = time.time()
    col2.query(query_texts=["机械表的故事"], n_results=5)
    warm_ms = int((time.time() - warm_t) * 1000)

    # ── Filtered query (10% wing) ─────────────────────────────────────
    filt_t = time.time()
    col2.query(
        query_texts=["小猪"],
        n_results=5,
        where={"wing": "pig"},
    )
    filt_ms = int((time.time() - filt_t) * 1000)

    peak_heap = max(peak_heap, heap_mb())

    return {
        "size": size,
        "insert_sec": insert_sec,
        "insert_rate": insert_rate,
        "cold_ms": cold_ms,
        "warm_ms": warm_ms,
        "filt_ms": filt_ms,
        "heap_mb": peak_heap,
    }


def main() -> None:
    print("=" * 72)
    print("  mempalace-node benchmark — Python ChromaDB original")
    print("  Model: all-MiniLM-L6-v2 (ChromaDB default)")
    print(f"  Python: {sys.version.split()[0]}")
    print("=" * 72)
    print()

    palace_root = tempfile.mkdtemp(prefix="mempalace-bench-py-")
    print(f"  (palace root: {palace_root})")
    print()

    sizes = [100, 1000, 5000, 10000]
    results = []

    for size in sizes:
        print(f"  Benchmarking {size} drawers...")
        try:
            r = run_benchmark(size, palace_root)
            results.append(r)
            print(
                f"    insert={r['insert_sec']:.1f}s ({r['insert_rate']}/s) | "
                f"cold={r['cold_ms']}ms warm={r['warm_ms']}ms filtered={r['filt_ms']}ms | "
                f"heap={r['heap_mb']}MB"
            )
        except Exception as e:
            print(f"    FAILED: {e}")
            break

    # ── Summary ────────────────────────────────────────────────────────
    print()
    print("=" * 72)
    print("  Summary")
    print("=" * 72)
    print()
    print("  | Size   | Insert         | Cold    | Warm    | Filtered | Heap    |")
    print("  |--------|----------------|---------|---------|----------|---------|")
    for r in results:
        size_str = str(r["size"]).rjust(6)
        insert_str = f"{r['insert_sec']:.1f}s ({r['insert_rate']}/s)".ljust(14)
        cold_str = f"{r['cold_ms']}ms".rjust(7)
        warm_str = f"{r['warm_ms']}ms".rjust(7)
        filt_str = f"{r['filt_ms']}ms".rjust(8)
        heap_str = f"{r['heap_mb']}MB".rjust(7)
        print(f"  | {size_str} | {insert_str} | {cold_str} | {warm_str} | {filt_str} | {heap_str} |")
    print()

    # Cleanup
    shutil.rmtree(palace_root, ignore_errors=True)


if __name__ == "__main__":
    main()
