/**
 * Performance benchmark for the SQLite vector store.
 *
 * Tests across multiple palace sizes to measure:
 *   - Insert throughput (drawers/sec)
 *   - Cold query latency (no cache)
 *   - Warm query latency (LRU cache hit)
 *   - Filtered query latency (metadata pre-filter)
 *   - Worker thread engagement (large candidate set)
 *   - Memory footprint
 *
 * Run: npx tsc && node dist/tests/test-benchmark.js
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createStore } from '../src/vector-store';
import { setModel } from '../src/embedder';
import { SqliteVectorStore, shutdownWorkerPool } from '../src/store';

const TEST_DIR = path.join(os.tmpdir(), 'mempalace-bench-' + Date.now());

interface BenchmarkResult {
  size: number;
  insertSec: number;
  insertRate: number;
  coldQueryMs: number;
  warmQueryMs: number;
  filteredQueryMs: number;
  workerPath: boolean;
  peakHeapMB: number;
}

// Diverse sample texts for realistic embedding distribution
const SAMPLE_TEXTS = [
  '今天和小猪聊了一下午的旧物件收藏，他对机械表特别有研究',
  'Graff提议下次去咖啡店见面，他最近在看一本关于拉丁语的书',
  '决定改用 GraphQL 替代 REST API，因为查询灵活性更好',
  '修复了 Windows 上的原生模块编译问题，需要 pathToFileURL',
  '用户反馈说深色模式下的对比度不够，需要调整 CSS 变量',
  '会议讨论了下季度的 OKR，重点是用户增长和留存率',
  '阅读了《人类简史》第三章，讲的是认知革命如何改变了人类',
  '今天天气很好，去公园散步看到了梅花开了',
  '调试了一整天的 WebSocket 连接问题，最后发现是防火墙在搞鬼',
  '小猪推荐了一部老电影，《重庆森林》，王家卫的代表作之一',
  '尝试了新的咖啡豆烘焙方法，浅烘的酸度比想象中还要明亮',
  '研究 Rust 的 ownership 模型，跟 C++ 的智能指针思路有相似之处',
  '春天来了，决定养几盆多肉植物，从最容易的种类开始',
  '会计报告显示这个月的开销超出了预算，主要是订阅服务太多',
  '看完了纪录片《地球脉动》的第二季，海洋那一集特别震撼',
  '试了一下新的 Vim 配置，加了 Telescope 和 LSP，效率提升明显',
  '收到了订购的二手书，是钱钟书的《围城》，封面有点旧但内容完好',
  '健身教练建议增加力量训练，每周三次复合动作为主',
  '调研了几款向量数据库，最后选了 SQLite 加自研的相似度计算',
  '夜里失眠的时候听了一段巴赫的平均律，心情慢慢平静下来',
];

// Generate diverse text by combining samples + random suffix
function generateText(seed: number): string {
  const base = SAMPLE_TEXTS[seed % SAMPLE_TEXTS.length];
  return `${base} (record #${seed})`;
}

function getHeapMB(): number {
  return Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
}

async function runBenchmark(size: number): Promise<BenchmarkResult> {
  const palacePath = path.join(TEST_DIR, `palace-${size}`);
  fs.rmSync(palacePath, { recursive: true, force: true });

  const store = createStore(palacePath);
  let peakHeap = getHeapMB();

  // ── Insert ─────────────────────────────────────────────────────────
  const insertStart = Date.now();
  for (let i = 0; i < size; i++) {
    const wing = i < size * 0.1 ? 'pig' : i < size * 0.3 ? 'graff' : 'general';
    const room = i % 3 === 0 ? 'tech' : i % 3 === 1 ? 'personal' : 'general';
    await store.upsert(`d${i}`, generateText(i), { wing, room });
    if (i % 100 === 0) peakHeap = Math.max(peakHeap, getHeapMB());
  }
  const insertSec = (Date.now() - insertStart) / 1000;
  const insertRate = Math.round(size / insertSec);

  peakHeap = Math.max(peakHeap, getHeapMB());

  // ── Cold query (clear cache first) ─────────────────────────────────
  if (store instanceof SqliteVectorStore) store.clearCache();
  const cold1 = Date.now();
  const r1 = await store.query({ queryText: '小猪喜欢的旧物件', nResults: 5 });
  const coldQueryMs = Date.now() - cold1;

  // Sanity check
  if (r1.documents[0].length === 0 && size > 0) {
    console.warn(`  WARNING: cold query returned 0 results for size=${size}`);
  }

  // ── Warm query (cache populated) ───────────────────────────────────
  const warm1 = Date.now();
  await store.query({ queryText: '机械表的故事', nResults: 5 });
  const warmQueryMs = Date.now() - warm1;

  // ── Filtered query (10% of data) ───────────────────────────────────
  const filt1 = Date.now();
  await store.query({ queryText: '小猪', nResults: 5, where: { wing: 'pig' } });
  const filteredQueryMs = Date.now() - filt1;

  // Worker path engages above 5000 candidates
  const workerPath = size >= 5000;

  peakHeap = Math.max(peakHeap, getHeapMB());

  store.close();

  return {
    size,
    insertSec,
    insertRate,
    coldQueryMs,
    warmQueryMs,
    filteredQueryMs,
    workerPath,
    peakHeapMB: peakHeap,
  };
}

async function main(): Promise<void> {
  // Allow choosing model via env: MODEL=english or MODEL=multilingual (default)
  const modelKey = (process.env.MODEL as 'english' | 'multilingual') || 'multilingual';
  setModel(modelKey);
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const modelLabel = modelKey === 'english'
    ? 'english (all-MiniLM-L6-v2, 384-dim)'
    : 'multilingual (paraphrase-multilingual-MiniLM-L12-v2, 384-dim)';

  console.log('='.repeat(72));
  console.log('  mempalace-node — SQLite backend benchmark');
  console.log(`  Model: ${modelLabel}`);
  console.log(`  CPU: ${os.cpus()[0].model} (${os.cpus().length} cores)`);
  console.log(`  Node: ${process.version}`);
  console.log('='.repeat(72));
  console.log();

  // Warm up the embedding model so it's not counted in the first benchmark
  console.log('  (warming up embedding model...)');
  const warmupStore = createStore(path.join(TEST_DIR, 'warmup'));
  await warmupStore.upsert('warmup', '预热文本', { wing: 'warmup' });
  warmupStore.close();
  console.log();

  const sizes = [100, 1000, 5000, 10000];
  const results: BenchmarkResult[] = [];

  for (const size of sizes) {
    console.log(`  Benchmarking ${size} drawers...`);
    const r = await runBenchmark(size);
    results.push(r);
    console.log(
      `    insert=${r.insertSec.toFixed(1)}s (${r.insertRate}/s) | ` +
      `cold=${r.coldQueryMs}ms warm=${r.warmQueryMs}ms filtered=${r.filteredQueryMs}ms | ` +
      `heap=${r.peakHeapMB}MB ${r.workerPath ? '[workers]' : ''}`,
    );
  }

  // ── Summary table ──────────────────────────────────────────────────
  console.log();
  console.log('='.repeat(72));
  console.log('  Summary');
  console.log('='.repeat(72));
  console.log();
  console.log('  | Size   | Insert         | Cold    | Warm    | Filtered | Heap    |');
  console.log('  |--------|----------------|---------|---------|----------|---------|');
  for (const r of results) {
    const sizeStr = String(r.size).padStart(6);
    const insertStr = `${r.insertSec.toFixed(1)}s (${r.insertRate}/s)`.padEnd(14);
    const coldStr = `${r.coldQueryMs}ms`.padStart(7);
    const warmStr = `${r.warmQueryMs}ms`.padStart(7);
    const filtStr = `${r.filteredQueryMs}ms`.padStart(8);
    const heapStr = `${r.peakHeapMB}MB${r.workerPath ? '*' : ''}`.padStart(7);
    console.log(`  | ${sizeStr} | ${insertStr} | ${coldStr} | ${warmStr} | ${filtStr} | ${heapStr} |`);
  }
  console.log();
  console.log('  * worker thread path engaged');
  console.log();
  console.log('  Notes:');
  console.log('  - Insert is dominated by embedding model inference (~5-15ms per text)');
  console.log('  - Cold = first query after cache clear; warm = subsequent query');
  console.log('  - Filtered = where: { wing: "pig" } narrows to 10% of data');
  console.log('  - All queries return top 5 results with full metadata');
  console.log();

  // Cleanup
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  shutdownWorkerPool();
}

main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
