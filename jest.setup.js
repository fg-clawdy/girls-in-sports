// Global Jest setup for the Girls In Sports test suite
// Ensures pino-based logger never breaks tests (pre-existing infra debt fixed for US-014 clean closure)
// Also safely mocks child_process.spawn so real handleScoreClip (used by scenes tests) does not
// attempt Unix-only "nice" / ffmpeg binaries on Windows or CI environments.

jest.mock('./src/lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    }),
  }),
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock child_process.spawn (used inside score-clip.ts for ffmpeg cuts + "nice" wrapper)
// This makes any test that pulls the real handleScoreClip safe on Windows / non-Unix CI.
jest.mock('child_process', () => {
  const { EventEmitter } = require('events');
  return {
    spawn: jest.fn((command, args, options) => {
      const mockProc = new EventEmitter();
      // Simulate instantaneous successful completion (no real binary needed)
      setImmediate(() => {
        mockProc.emit('close', 0);
      });
      // Minimal shape expected by callers that listen for 'error' / 'close'
      mockProc.stdout = new EventEmitter();
      mockProc.stderr = new EventEmitter();
      return mockProc;
    }),
  };
});