import { JobType, JobStatus } from "@prisma/client";

// ── Hoisting-safe mocks ──────────────────────────────────────────

let mockQueueAdd: jest.Mock;
let mockQueuePause: jest.Mock;
let mockQueueResume: jest.Mock;
let mockQueueClose: jest.Mock;
let mockJobCreate: jest.Mock;
let mockJobCount: jest.Mock;
let mockJobFindUnique: jest.Mock;
let mockJobUpdate: jest.Mock;
let mockQueryRaw: jest.Mock;
let mockDisconnect: jest.Mock;

jest.mock("bullmq", () => {
  const actual = jest.requireActual("bullmq");
  return {
    ...actual,
    Queue: jest.fn().mockImplementation((name: string, opts?: any) => {
      const instance = {
        name,
        opts,
        add: (...args: any[]) => mockQueueAdd?.(...args),
        pause: () => mockQueuePause?.(),
        resume: () => mockQueueResume?.(),
        close: () => mockQueueClose?.(),
      };
      return instance;
    }),
    Worker: jest.fn(),
  };
});

// Mock pg Pool and PrismaPg adapter so job-worker.ts getPrisma() works without a real DB
jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation(() => ({
    connect: jest.fn(),
    query: jest.fn(),
    end: jest.fn(),
  })),
}));

jest.mock("@prisma/adapter-pg", () => ({
  PrismaPg: jest.fn().mockImplementation(() => ({
    provider: "postgresql",
    adapterName: "mock",
  })),
}));

// Override PrismaClient to return our mock methods
jest.mock("@prisma/client", () => {
  const actual = jest.requireActual("@prisma/client");
  return {
    ...actual,
    PrismaClient: jest.fn().mockImplementation(() => ({
      job: {
        create: (...args: any[]) => mockJobCreate?.(...args),
        count: (...args: any[]) => mockJobCount?.(...args),
        findUnique: (...args: any[]) => mockJobFindUnique?.(...args),
        update: (...args: any[]) => mockJobUpdate?.(...args),
      },
      $queryRaw: (...args: any[]) => mockQueryRaw?.(...args),
      $disconnect: () => mockDisconnect?.(),
    })),
  };
});

jest.mock("../src/lib/push", () => ({
  sendPushNotification: jest.fn(),
}));

import { getQueue, getQueueConfig, pauseAllQueues, resumeAllQueues, isQueuesPaused, closeAllQueues } from "../src/lib/queues";

describe("BullMQ/Redis Integration", () => {
  beforeEach(() => {
    mockQueueAdd = jest.fn().mockResolvedValue({ id: "bull-job-1" });
    mockQueuePause = jest.fn().mockResolvedValue(undefined);
    mockQueueResume = jest.fn().mockResolvedValue(undefined);
    mockQueueClose = jest.fn().mockResolvedValue(undefined);
    mockJobCreate = jest.fn().mockResolvedValue({
      id: "job-1",
      type: "SCORE_CLIP",
      payload: { eventId: "evt-1" },
      status: "QUEUED",
      attempts: 0,
      maxAttempts: 3,
      parentJobId: null,
    });
    mockJobCount = jest.fn().mockResolvedValue(0);
    mockJobFindUnique = jest.fn().mockResolvedValue(null);
    mockJobUpdate = jest.fn().mockResolvedValue({});
  });

  afterEach(async () => {
    await closeAllQueues();
    jest.clearAllMocks();
  });

  describe("getQueue: lazy initialization and caching", () => {
    test("returns a Queue for a valid JobType", () => {
      const q = getQueue(JobType.INGEST_CLIP);
      expect(q).toBeDefined();
      expect(q.name).toBe("INGEST_CLIP");
    });

    test("returns the same Queue instance on repeated calls (cache)", () => {
      const q1 = getQueue(JobType.SCORE_CLIP);
      const q2 = getQueue(JobType.SCORE_CLIP);
      expect(q1).toBe(q2);
    });
  });

  describe("getQueueConfig: per-type rate limits", () => {
    test("INGEST_CLIP has 2 concurrency, max 2 per 30s", () => {
      const cfg = getQueueConfig(JobType.INGEST_CLIP);
      expect(cfg.concurrency).toBe(2);
      expect(cfg.limiter).toEqual({ max: 2, duration: 30_000 });
    });

    test("SCORE_CLIP has 2 concurrency, max 2 per 10s", () => {
      const cfg = getQueueConfig(JobType.SCORE_CLIP);
      expect(cfg.concurrency).toBe(2);
      expect(cfg.limiter).toEqual({ max: 2, duration: 10_000 });
    });

    test("RENDER_PROXY has 1 concurrency, max 1 per 60s", () => {
      const cfg = getQueueConfig(JobType.RENDER_PROXY);
      expect(cfg.concurrency).toBe(1);
      expect(cfg.limiter).toEqual({ max: 1, duration: 60_000 });
    });

    test("RENDER_FINAL has 1 concurrency, max 1 per 60s", () => {
      const cfg = getQueueConfig(JobType.RENDER_FINAL);
      expect(cfg.concurrency).toBe(1);
      expect(cfg.limiter).toEqual({ max: 1, duration: 60_000 });
    });

    test("DIRECT_SCRIPT has 2 concurrency, no rate limiter", () => {
      const cfg = getQueueConfig(JobType.DIRECT_SCRIPT);
      expect(cfg.concurrency).toBe(2);
      expect(cfg.limiter).toBeUndefined();
    });

    test("GENERATE_MUSIC has 1 concurrency, no rate limiter", () => {
      const cfg = getQueueConfig(JobType.GENERATE_MUSIC);
      expect(cfg.concurrency).toBe(1);
      expect(cfg.limiter).toBeUndefined();
    });

    test("FEEDBACK_ANALYSIS has 1 concurrency, no rate limiter", () => {
      const cfg = getQueueConfig(JobType.FEEDBACK_ANALYSIS);
      expect(cfg.concurrency).toBe(1);
      expect(cfg.limiter).toBeUndefined();
    });

    test("unregistered job type returns default config (concurrency 1)", () => {
      const cfg = getQueueConfig("UNKNOWN_TYPE" as JobType);
      expect(cfg.concurrency).toBe(1);
      expect(cfg.limiter).toBeUndefined();
    });
  });

  describe("pauseAllQueues / resumeAllQueues: global pause state machine", () => {
    test("isQueuesPaused returns false initially", () => {
      expect(isQueuesPaused()).toBe(false);
    });

    test("pauseAllQueues sets paused state and calls queue.pause()", async () => {
      getQueue(JobType.SCORE_CLIP);
      getQueue(JobType.INGEST_CLIP);
      await pauseAllQueues();
      expect(isQueuesPaused()).toBe(true);
      expect(mockQueuePause).toHaveBeenCalledTimes(2);
    });

    test("pauseAllQueues is idempotent — calling twice only pauses once", async () => {
      getQueue(JobType.SCORE_CLIP);
      await pauseAllQueues();
      const callCount = mockQueuePause.mock.calls.length;
      await pauseAllQueues();
      expect(mockQueuePause).toHaveBeenCalledTimes(callCount);
    });

    test("resumeAllQueues clears paused state after pause", async () => {
      getQueue(JobType.SCORE_CLIP);
      await pauseAllQueues();
      expect(isQueuesPaused()).toBe(true);
      await resumeAllQueues();
      expect(isQueuesPaused()).toBe(false);
      expect(mockQueueResume).toHaveBeenCalledTimes(1);
    });

    test("resumeAllQueues is idempotent when not paused", async () => {
      await resumeAllQueues();
      expect(mockQueueResume).not.toHaveBeenCalled();
    });
  });

  describe("closeAllQueues: graceful shutdown", () => {
    test("closes all queues and clears cache", async () => {
      getQueue(JobType.SCORE_CLIP);
      getQueue(JobType.INGEST_CLIP);
      await closeAllQueues();
      expect(mockQueueClose).toHaveBeenCalledTimes(2);
      const qAfterClose = getQueue(JobType.SCORE_CLIP);
      expect(qAfterClose).toBeDefined();
    });
  });

  describe("enqueueJob: dual-write (PostgreSQL + BullMQ)", () => {
    test("creates PostgreSQL row then pushes to BullMQ queue", async () => {
      const { enqueueJob } = await import("../src/lib/job-worker");

      const result = await enqueueJob(JobType.SCORE_CLIP, { eventId: "evt-1", assetId: "ast-1" });

      expect(mockJobCreate).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          type: "SCORE_CLIP",
          payload: { eventId: "evt-1", assetId: "ast-1" },
          status: "QUEUED",
          attempts: 0,
          maxAttempts: 3,
        }),
      }));

      expect(mockQueueAdd).toHaveBeenCalledWith(
        "SCORE_CLIP",
        { dbJobId: "job-1", payload: { eventId: "evt-1", assetId: "ast-1" } },
        { jobId: "job-1" }
      );

      expect(result.id).toBe("job-1");
      expect(result.status).toBe("QUEUED");
    });

    test("enqueues with parentJobId when provided", async () => {
      const { enqueueJob } = await import("../src/lib/job-worker");

      await enqueueJob(JobType.SCORE_CLIP, { eventId: "evt-2" }, "parent-job-99");

      expect(mockJobCreate).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          parentJobId: "parent-job-99",
        }),
      }));
    });

    test("uses BullMQ jobId matching PostgreSQL job ID for traceability", async () => {
      mockJobCreate.mockResolvedValueOnce({
        id: "pg-job-abc123",
        type: "INGEST_CLIP",
        payload: { assetId: "a1" },
        status: "QUEUED",
        attempts: 0,
        maxAttempts: 3,
        parentJobId: null,
      });

      const { enqueueJob } = await import("../src/lib/job-worker");
      await enqueueJob(JobType.INGEST_CLIP, { assetId: "a1" });

      expect(mockQueueAdd).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ dbJobId: "pg-job-abc123" }),
        { jobId: "pg-job-abc123" }
      );
    });
  });
});