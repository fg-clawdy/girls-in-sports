# OOM Analysis & Mitigation Strategy — Girls In Sports

**Date:** 2026-05-26  
**Last verified system check:** 2026-05-26 18:30 UTC

## Architecture

| Role | Hostname | Hardware | RAM | Swap | Storage | OS |
|------|----------|----------|-----|------|---------|-----|
| **NGINX reverse proxy** | host01 (rpin03) | Raspberry Pi 4 Model B, 4×ARM Cortex-A72 | 3.8 GB total, ~3.3 GB free | **None** | 110 GB SSD (88 GB free) | Ubuntu 22.04 LTS |
| **Next.js app + worker + PostgreSQL** | host02 (this machine) | Intel i7-12700K (12th Gen), 5 vCPU cores (VM) | **8 GB base, burst to 10 GB** | 3.9 GB | 96 GB LVM (64 GB free) | Ubuntu 26.04 LTS |

**Key change as of 2026-05-26:** host02 upgraded from 3.4 GB → **8 GB (spike to 10 GB)**. This fundamentally changes the memory budget. Swap pressure eliminated at baseline.

**Current systemd limits applied:**
| Service | MemoryHigh (soft) | MemoryMax (hard) | CPUWeight | NODE_OPTIONS | Restart |
|---------|---------------------|--------------------|-------------|---------------|-----------|
| gis-server | 1 GB | 1.5 GB | 200 (higher) | — | on-failure |
| gis-worker | 1.5 GB | 2.5 GB | 50 (lower) | `--max-old-space-size=512` | on-failure |

See §2.6 for analysis of whether these need adjustment for 8-10 GB.
---

## 1. Root Cause Analysis: Why We Crash

### 1.1 Upload Pipeline (the primary OOM trigger)

The full flow when a user uploads a video:

```
Browser → NGINX (host01) → buffers to SSD → proxies to Next.js → streams multipart
  → Immich API → Asset row created → INGEST_CLIP job enqueued in PostgreSQL
  ↓
Worker (host02, port 3011) claims INGEST_CLIP:
  1. Downloads FULL video from Immich to /tmp/gis/{assetId}/source    [disk I/O]
  2. Runs ffprobe                                                     [light RAM]
  3. Runs transcription via Venice API                                [network, light RAM]
  4. Runs ffmpeg scene detection — reads entire video frame-by-frame  [HIGH CPU + RAM]
  5. For each scene (N scenes), cuts clip via ffmpeg stream copy      [moderate CPU]
  6. Each clip uploaded back to Immich via uploadAssetFromFile()      [was: readFileSync → now: streaming]
  7. Each clip enqueues SCORE_CLIP job                                [DB write only]
  8. Cleanup temp files
```

### 1.2 RAM Budget (host02, at 8 GB target)

| Component | Idle RAM | Peak RAM |
|-----------|----------|----------|
| OS + kernel + buffers | 400 MB | 500 MB |
| Next.js (standalone) | 200 MB | 400 MB |
| VSCode | 400 MB | 800 MB |
| Worker (Node, idle) | 100 MB | 150 MB |
| PostgreSQL | 100 MB | 256 MB |
| ffmpeg scene detection (threads=1) | 0 | 600 MB |
| ffmpeg clip cutting (threads=1, sequential) | 0 | 150 MB |
| Upload streaming buffers (64 KB chunks) | 0 | 10 MB |
| **Total at 8 GB RAM** | **~1.2 GB** | **~2.9 GB** |
| **Headroom** | **6.8 GB** | **5.1 GB + 4 GB swap** |

At the current 3.4 GB RAM, peak usage reaches ~2.9 GB, leaving only ~500 MB for everything else — which is why the system is perpetually in swap. **8 GB RAM solves this; 12 GB provides comfortable headroom.**

### 1.3 Identified OOM Bottlenecks (by severity)

| # | Issue | Location | Status |
|---|-------|----------|--------|
| **1** | `readFileSync()` loaded entire video file into RAM before POSTing to Immich | `src/lib/immich.ts` → `uploadAssetFromFile()` | ✅ **FIXED** — now uses `createReadStream()` with 64 KB chunks |
| **2** | ffmpeg scene detection reads entire video frame-by-frame, output accumulated in stderr | `src/lib/handlers/ingest-clip.ts` | ✅ Mitigated — centralized `spawnLimitedFfmpeg()` with timeout + stderr collection |
| **3** | ffmpeg auto-scaled threads × decode buffers per process | All ffmpeg spawns | ✅ **FIXED** — `ffmpeg-utils.ts` enforces `-threads 2` + `nice 15-19` |
| **4** | Next.js + Worker + VSCode + PostgreSQL all on same 3.4 GB VM | Deployment | ✅ **DONE** — host02 upgraded to 8 GB (burst to 10 GB) |
| **5** | No per-process cgroup memory limits | systemd config | ✅ **DONE** — gis-server: MemoryMax=1.5G, gis-worker: MemoryMax=2.5G (see §2.11 for adjustments) |
| **6** | Swap present (4 GB) but throttles everything when under pressure | OS config | ⚠️ `vm.swappiness=10` recommended |
| **7** | No `OMP_NUM_THREADS=1` env on ffmpeg children | ffmpeg spawns | ✅ Mitigated via `leanEnv` in ffmpeg-utils.ts |

---

## 2. Solutions — Implemented & Planned

### 2.1 NGINX Upload Buffering on host01 ✅

**Goal:** Move upload buffering off the Node.js process entirely. NGINX on host01 accepts the upload, buffers it to its SSD (88 GB free), then proxies it to host02 at a controlled pace.

**Config file:** `docs/REMOTE-NGINX-CONFIG`

Key directives for upload paths:
- `proxy_request_buffering on` + `client_body_in_file_only on` — all upload bodies go to NGINX's SSD
- `client_body_temp_path /var/cache/nginx/uploads` — dedicated temp directory
- Rate limiting: 3 req/s burst 5, max 3 concurrent upload connections per IP
- `proxy_buffering on` — NGINX trickle-feeds the completed upload to the app
- `proxy_buffer_size 128k` with 8×128k buffers

**What this achieves:**
- Uploads are accepted by NGINX's async event loop, never touching Node.js
- Users get instant upload feedback — NGINX accepts, buffers, then proxies
- Node.js sees a fast, already-buffered request
- Parallel uploads handled on a dedicated machine (host01, 3.3 GB free RAM)
- host01's 88 GB free SSD provides ample buffer space

**Setup (on host01/rpin03):**
```bash
sudo mkdir -p /var/cache/nginx/uploads /var/cache/nginx/proxy
sudo chown www-data:www-data /var/cache/nginx/uploads /var/cache/nginx/proxy
sudo cp docs/REMOTE-NGINX-CONFIG /etc/nginx/sites-available/mydev.famgala.com
sudo nginx -t && sudo systemctl reload nginx
```

### 2.2 Eliminated `readFileSync` — Stream-Based Uploads ✅

**File:** `src/lib/immich.ts` → `uploadAssetFromFile()`

Changed from:
```typescript
const blob = await readFile(filePath);  // Loads ENTIRE file into RAM
```

To:
```typescript
const fileStream = createReadStream(filePath, { highWaterMark: 64 * 1024 });
// Streams file in 64 KB chunks — never more than 64 KB in memory at once
```

### 2.3 Centralized ffmpeg Resource Limits ✅

**File:** `src/lib/ffmpeg-utils.ts`

All ffmpeg/ffprobe child processes go through `spawnLimitedFfmpeg()` and `spawnLimitedFfprobe()`:

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `-threads` | **2** (was 2, stays 2) | Two threads @ 8 GB is safe. At 3.4 GB we could drop to 1. |
| `nice` | 15 (video), 19 (audio/probe) | Starves before stealing CPU from the app |
| `timeoutMs` | 10 min default, varies per handler | Auto-kills runaway processes |
| `leanEnv` | Minimal PATH, TMPDIR | Prevents env bloat, but leaves `OMP_NUM_THREADS` to ffmpeg's own `-threads` flag |
| Graceful SIGTERM → SIGKILL | 30s grace period | Prevents zombie processes |

**Handlers using the centralized wrappers:**
- `render-final.ts` — `spawnLimitedFfmpeg()` with nice=19
- `render-proxy.ts` — `spawnLimitedFfmpeg()` with nice=19
- `ingest-clip.ts` — `spawnLimitedFfmpeg()` with nice=15, scene detection + clip cutting
- `score-clip.ts` — `spawnLimitedFfmpeg()` + `spawnLimitedFfprobe()` with nice=15
- `video-segmentation.ts` — `spawnLimitedFfmpeg()` with nice=15

### 2.4 Worker Health Endpoint with Memory Monitoring ✅

**File:** `src/lib/job-worker.ts` → `startHealthServer()` (port 3011)

```json
GET /health → {
  "status": "ok",
  "queueDepth": 5,
  "runningJobs": 1,
  "memory": {
    "heapUsedMB": 45,
    "heapTotalMB": 64,
    "rssMB": 128,
    "externalMB": 2
  },
  "system": {
    "freeMemMB": 823,
    "totalMemMB": 3395,
    "loadAvg1m": 0.45,
    "loadAvg5m": 0.62,
    "loadAvg15m": 0.71
  }
}
```

Monitor with: `watch -n 5 'curl -s http://host02:3011/health | jq .'`

### 2.5 Recommended: Increase host02 RAM to 8 GB

The single most impactful change. At 8 GB:
- VSCode + Next.js + Worker + PostgreSQL baseline: ~1.2 GB
- Peak with 1 ffmpeg job: ~2.9 GB
- Remaining headroom: **5.1 GB + 4 GB swap**
- Can comfortably run 2 concurrent ffmpeg jobs

### 2.6 Recommended: systemd cgroup Memory Limits

Create `/etc/systemd/system/gis-worker.service`:

```ini
[Unit]
Description=Girls In Sports Job Worker
After=network.target postgresql.service

[Service]
Type=simple
User=sensei
WorkingDirectory=/home/sensei/girls-in-sports
ExecStart=/usr/bin/node --max-old-space-size=512 /home/sensei/girls-in-sports/.next/standalone/server.js

# At 8 GB RAM:
MemoryMax=3072M           # Hard limit: 3 GB (leaves 5 GB for OS/VSCode/Next.js)
MemoryHigh=2560M          # Soft limit: 2.5 GB (triggers throttling)

CPUQuota=200%             # Max 2 CPU cores
IOWeight=50               # Lower I/O priority

Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now gis-worker
```

### 2.7 Recommended: Swap Tuning

```bash
# Reduce swap aggressiveness — prefer RAM
sudo sysctl vm.swappiness=10
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf

# Already present: /swap.img 3.9 GB
# If upgrading RAM to 8 GB, the existing swap is adequate
```

### 2.8 Recommended: Redis + BullMQ on host01

host01 (rpin03) has 3.3 GB free RAM and 88 GB free SSD — more than enough for Redis.

```bash
# On host01:
sudo apt install -y redis-server
sudo systemctl enable --now redis-server
# Redis uses ~10-20 MB RAM idle
```

Then add BullMQ to the worker:
```typescript
// Concurrency = 1 for heavy ffmpeg jobs
// Rate limiter prevents back-to-back ffmpeg spawns
ingestWorker: concurrency: 1, max 1 per 30s
scoreWorker:  concurrency: 1, max 2 per 10s
renderWorker: concurrency: 1, max 1 per 60s
```

Benefits:
- Proper backpressure — queue depth is visible
- Retry with exponential backoff built-in
- Pause/resume queues during memory pressure
- Bull Board dashboard for visibility
- Decouples enqueue from processing

**Alternative without Redis:** Use `pg-boss` or `graphile-worker` — leverages the existing PostgreSQL instance for job queuing. Zero new infrastructure.

### 2.9 Recommended: PostgreSQL Tuning

Reduce PostgreSQL's memory footprint (if it's on host02):

```sql
-- In postgresql.conf:
shared_buffers = 128MB          -- At 8 GB RAM: could go to 256 MB
work_mem = 8MB                  -- Per-operation memory
maintenance_work_mem = 32MB     -- For VACUUM
effective_cache_size = 512MB    -- Hint for query planner (8 GB RAM)
max_connections = 10            -- Limit connections
```

### 2.10 Recommended: `--max-old-space-size` for Node.js

```bash
# Next.js (port 3010):
node --max-old-space-size=512 server.js

# Worker (port 3011):
node --max-old-space-size=768 worker.js
```

At 8 GB RAM, these limits are conservative and safe.


### 2.11 Analysis: Current systemd Limits at 8-10 GB

**Current limits (already applied):**

| Service | MemoryHigh (soft) | MemoryMax (hard) | CPUWeight | NODE_OPTIONS |
|---------|---------------------|--------------------|-------------|---------------|
| gis-server | 1 GB | 1.5 GB | 200 (higher) | — |
| gis-worker | 1.5 GB | 2.5 GB | 50 (lower) | `--max-old-space-size=512` |

**Assessment: Are these sufficient? Will they harden the instance without hurting performance?**

**Verdict: Yes, sufficient — and well-chosen for 8 GB.** The current limits are already conservative and appropriate. Here's the detailed breakdown:

- **gis-server (Next.js, port 3010):** MemoryHigh=1G / MemoryMax=1.5G. The Next.js standalone server typically idles at 200-400 MB and peaks at ~400 MB serving pages. Even under load with SSR and API routes proxying uploads, it won't touch 1 GB. VSCode (400-800 MB) lives *outside* the cgroup so it's not counted here. These limits give Next.js 2.5× headroom above its normal peak — plenty. **No adjustment needed.**

- **gis-worker (port 3011):** MemoryHigh=1.5G / MemoryMax=2.5G with `--max-old-space-size=512`. The worker's Node.js heap is capped at 512 MB by V8 itself. The remaining ~1.5-2 GB of headroom in the cgroup is **for ffmpeg child processes** (which live in the same cgroup). ffmpeg scene detection: ~400-600 MB. So: 512 MB (Node heap) + 600 MB (ffmpeg) = ~1.1 GB — well under the 1.5 GB MemoryHigh soft limit. Even with two concurrent ffmpeg processes: 512 + 600 + 150 = ~1.3 GB. The 2.5 GB MemoryMax hard limit is never hit in normal operation. **No adjustment needed.**

- `--max-old-space-size=512` on the worker: **This is the right choice.** The worker is a job processor, not a web server. It holds one job's payload in memory at a time, runs ffmpeg as a child process, then releases. V8's heap doesn't need to be large. Keeping it at 512 MB forces aggressive GC which keeps the RSS footprint low for the process itself, leaving more room for ffmpeg children within the same cgroup. **Do not increase this.**

**Should we raise any numbers?** No. Raising them *reduces* hardening without benefit. The cgroup limits exist to prevent a runaway worker or server from consuming all 8 GB and causing OOM of other processes. At 8-10 GB total RAM, the current limits give:

| Component | Limit | 8 GB budget | 10 GB budget |
|-----------|-------|-------------|--------------|
| gis-server cgroup (hard) | 1.5 GB | 18.75% | 15% |
| gis-worker cgroup (hard) | 2.5 GB | 31.25% | 25% |
| Systemd cgroup total | 4.0 GB | 50% | 40% |
| Remaining for OS/kernel/VSCode/Postgres/buffers | 4-6 GB | 50% | 60% |

That's a well-balanced split. **Keep the current limits as-is.**

**One adjustment to consider:** You could *reduce* the worker's MemoryHigh from 1.5 GB → 1.2 GB now that 8 GB is confirmed. This would trigger throttling (not kill) earlier if a job leaks, giving more warning before the hard 2.5 GB kill. But it's a minor tweak — the current settings are production-safe.

---

### 2.12 Analysis: Redis on host01 (Raspberry Pi 4)

**Question:** How does adding Redis to the nginx server help? Should we do it?

**What Redis would give us (if on host01):**

| Capability | Benefit | On RPi4? |
|------------|---------|-----------|
| BullMQ job queue backend | Proper Redis-backed queues with delayed jobs, rate limiting, priorities, concurrency control | ✅ Works, ~20 MB RAM |
| Session/cache store | Store user sessions in Redis instead of in-memory (survives app restart) | Low priority |
| Rate limiting counters | Track per-IP upload rates for the nginx layer | Can do in nginx natively |
| Pub/sub for real-time updates | Notify the UI when jobs complete without polling | Nice to have |

**The real question: does Redis belong on the DMZ-exposed nginx box?**

**Your instinct is correct — I recommend against it.** Here's why:

1. **Security surface area.** host01 is your internet-facing edge. It runs nginx and nothing else. Adding Redis means opening another service that, if compromised, exposes job queue data and potentially allows an attacker to inject jobs. Redis has almost no built-in auth (a password, no TLS by default). You'd need to firewall it to only accept connections from host02 anyway, which means the security benefit of co-location is zero.

2. **Network hop is negligible.** Whether Redis is on host01 or host02, the worker connects over the LAN. The latency difference between localhost and a LAN hop to the RPi4 is < 1ms. BullMQ is designed for remote Redis — every production deployment connects over a network.

3. **RPi4 is resource-constrained.** 3.3 GB free RAM sounds like a lot, but 3.8 GB total with no swap means Redis can't grow. If job payloads are large (they shouldn't be — job data should be IDs, not file contents), Redis could push the RPi into OOM. The RPi has no swap to fall back on.

4. **Single point of failure coupling.** If the RPi4 goes down (SD card failure, power loss, network blip), you lose BOTH nginx AND the job queue. With Redis on host02, a host02 failure already takes down the worker anyway. With Redis on host01, an RPi4 failure takes down jobs that are still processable on a still-healthy host02.

**What I recommend instead: Run Redis on host02 or use PostgreSQL-native queuing.**

**Option A: Redis on host02 (recommended if you want BullMQ)**
```bash
# On host02:
sudo apt install -y redis-server
sudo systemctl enable --now redis-server
# Memory: ~20-50 MB idle, up to 200 MB with large queues
# Connect via: redis://localhost:6379
```
At 8-10 GB RAM, 200 MB for Redis is noise. It's co-located with the worker (zero network latency), and the security surface is internal-only (bind to 127.0.0.1).

**Option B: pg-boss (PostgreSQL-native, zero new infra)**
```bash
npm install pg-boss
```
This uses the existing PostgreSQL instance as the job queue with `SKIP LOCKED` semantics (which your current `claimNextJob()` already uses). Benefits:
- Zero new service to manage
- Zero new RAM overhead (uses existing PostgreSQL connections)
- Transactional — enqueue + business data in same DB transaction
- Built-in retry, dead letter, cron scheduling
- Single backup/restore story

**Option C: Keep current PostgreSQL polling (status quo)**
Your current implementation in `job-worker.ts` already does `FOR UPDATE SKIP LOCKED` for atomic job claiming. It works. The downside is polling (2s interval) instead of push notifications for new jobs, which wastes a tiny amount of CPU. At your scale, this is perfectly fine.

**Recommendation: Option B (pg-boss) for medium-term, status quo for now.** It gives you rate limiting, delayed retry, dead letter queues, and visibility — without any new infrastructure. BullMQ is powerful but overkill unless you need multi-worker distributed processing (which you don't at this scale).

---

### 2.13 Analysis: BullMQ — What Does It Actually Net Us?

**BullMQ is a Redis-backed job queue library for Node.js.** It's the most popular choice in the Node ecosystem. Here's what it would give you compared to the current PostgreSQL polling:

| Feature | Current (PostgreSQL polling) | BullMQ | Worth it? |
|---------|------------------------------|--------|-----------|
| **Job claiming** | `SELECT ... FOR UPDATE SKIP LOCKED` (atomic, works) | Redis `BRPOPLPUSH` (atomic, works) | Tie — both correct |
| **Concurrency control** | Manual (you'd need to track running count in DB) | `concurrency: 1` per worker — built-in | ✅ Nice |
| **Rate limiting** | Manual (add delay between polls) | `limiter: { max: 1, duration: 30000 }` — built-in | ✅ Nice |
| **Delayed jobs** | `retryAfter` column + polling (works) | `delay: 60000` — built-in, precise | Tie |
| **Job priorities** | Not implemented | `priority: 1` (higher = first) | ✅ Potentially useful |
| **Job progress** | Not implemented | `job.updateProgress(50)` — UI can poll | ✅ Useful for UX |
| **Pause/resume queues** | Not implemented | `queue.pause()` / `queue.resume()` | ✅ Critical for OOM safety |
| **Dead letter queue** | Manual (FAILED status) | Automatic after N retries, inspectable | ✅ Nice |
| **Bull Board UI** | Not included | `bull-board` gives a web dashboard | ✅ Nice for debugging |
| **Push (no polling)** | 2s poll interval wastes CPU | Redis pub/sub — instant job delivery | Minor |
| **New infrastructure** | None | Requires Redis (~50 MB RAM) | ❌ Cost |
| **Operational complexity** | None | Redis to monitor, backup, secure | ❌ Cost |
| **Failure mode** | If PostgreSQL is down, everything is down | If Redis is down, jobs can't be queued but PostgreSQL still works | ❌ New failure domain |

**Net assessment:**

BullMQ's killer features for your OOM scenario:
1. **`queue.pause()`** — Before spawning ffmpeg, the worker checks `os.freemem()`. If below threshold, it pauses the queue. New jobs queue up harmlessly in Redis. When memory frees up, resume. This is MUCH cleaner than the current approach of `checkMemoryPressure()` throwing an error and the job getting requeued (which creates retry churn).
2. **Rate limiting** — `limiter: { max: 1, duration: 60000 }` on the ingest queue means: "process at most 1 ingest job per 60 seconds, regardless of how many are queued." This guarantees ffmpeg processes are spaced out — no back-to-back scene detections gobbling RAM.
3. **Concurrency = 1** — Guarantees only one ffmpeg process runs at a time per queue type.

**But you can achieve all three without BullMQ:**

```typescript
// In your current worker loop, add:
const MAX_CONCURRENT_FFMPEG = 1;
let runningFfmpegJobs = 0;

while (!isShuttingDown) {
  if (runningFfmpegJobs >= MAX_CONCURRENT_FFMPEG) {
    await sleep(POLL_INTERVAL_MS);
    continue;
  }
  // ... claim and process
}
```

The current `checkMemoryPressure()` in `ffmpeg-utils.ts` already blocks ffmpeg spawns when RAM is low. That combined with `concurrency: 1` in your loop gives you 80% of BullMQ's value.

**Recommendation: Don't add BullMQ yet.** Your current PostgreSQL polling + `checkMemoryPressure()` + manual concurrency control is sufficient for 8-10 GB RAM. If you later need:
- Multi-worker distributed processing
- Job progress reporting to the UI
- A pause/resume button in an admin dashboard

...then BullMQ is the right tool. For now, the complexity cost of adding Redis outweighs the benefit.

---

## 3. Priority Implementation Order

### Immediate (today/tomorrow):
1. ✅ ~~Fix `uploadAssetFromFile` streaming~~ — Done
2. ✅ ~~Create `ffmpeg-utils.ts` centralized wrappers~~ — Done
3. Deploy updated NGINX config to host01 — `docs/REMOTE-NGINX-CONFIG`
4. **Increase host02 RAM to 8 GB** — single biggest win

### Short-term (this week):
5. Apply PostgreSQL tuning (§2.9)
6. Add `--max-old-space-size` flags (§2.10)
7. Create systemd service for worker with cgroup limits (§2.6)
8. Set `vm.swappiness=10` (§2.7)

### Medium-term (next 1-2 weeks):
9. Install Redis on host01 + BullMQ (§2.8)
10. Or implement `pg-boss` for zero-new-infrastructure queueing

---

## 4. Expected Outcome

| Scenario | Before (3.4 GB) | After (8 GB + nginx buffering) |
|----------|-----------------|-------------------------------|
| Upload 500 MB video | OOM crash (swap exhausted) | 2.9 GB peak, 5.1 GB headroom |
| VSCode + 1 ffmpeg job | 2.2 GB into swap, thrashing | 3.0 GB used, zero swap pressure |
| 3 parallel uploads | Impossible (OOM) | NGINX buffers on host01, app processes serially |
| Peak ffmpeg RAM per process | ~600 MB (with threads=2) | ~400 MB (with threads=1 at 3.4 GB) or ~600 MB (threads=2 at 8 GB) |
| Swap usage | 2.2 GB used at IDLE | < 100 MB used |

---

## 5. Monitoring Commands

```bash
# Worker health (real-time)
watch -n 5 'curl -s http://localhost:3011/health | jq .'

# System memory pressure
watch -n 2 'free -m; echo "---"; vmstat 1 3'

# Swap activity
vmstat 1

# Top memory consumers
ps aux --sort=-%mem | head -15

# ffmpeg processes only
ps aux | grep ffmpeg

# NGINX upload buffer disk usage (on host01)
ssh rpin03 'du -sh /var/cache/nginx/uploads/'