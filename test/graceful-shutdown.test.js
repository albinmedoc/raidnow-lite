import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installGracefulShutdown } from '../src/core/graceful-shutdown.js';

class FakeClock {
  now = 0;
  timers = new Map();
  nextId = 1;

  setTimeout = (callback, delay) => {
    const id = this.nextId++;
    this.timers.set(id, { callback, due: this.now + delay });
    return id;
  };

  clearTimeout = (id) => this.timers.delete(id);

  tick(ms) {
    this.now += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.due > this.now) continue;
      this.timers.delete(id);
      timer.callback();
    }
  }
}

test('signal shutdown awaits application cleanup before closing the server without immediate exit', async () => {
  const processRef = new EventEmitter();
  const order = [];
  const exits = [];
  processRef.exit = (code) => exits.push(code);
  const control = installGracefulShutdown({
    processRef,
    signals: ['SIGTERM'],
    timeoutMs: 100,
    shutdown: async () => { order.push('cleanup-start'); await Promise.resolve(); order.push('cleanup-end'); },
    server: { close(callback) { order.push('server-close'); callback(); } },
    logger: { error() {} }
  });
  processRef.emit('SIGTERM');
  await control.current();
  assert.deepEqual(order, ['cleanup-start', 'cleanup-end', 'server-close']);
  assert.deepEqual(exits, []);
  assert.equal(processRef.exitCode, 0);
  control.dispose();
});

test('signal shutdown uses process exit only for the bounded forced-exit deadline', async () => {
  const processRef = new EventEmitter();
  const exits = [];
  processRef.exit = (code) => exits.push(code);
  const control = installGracefulShutdown({
    processRef,
    signals: ['SIGTERM'],
    timeoutMs: 5,
    shutdown: () => new Promise(() => {}),
    server: { close() { throw new Error('must not close before cleanup'); } },
    logger: { error() {} }
  });
  processRef.emit('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(exits, [1]);
  control.dispose();
});

test('cleanup rejection closes the server without immediate exit but keeps the forced-exit deadline armed', async () => {
  const processRef = new EventEmitter();
  const clock = new FakeClock();
  const order = [];
  const exits = [];
  let cleanupCalls = 0;
  let closeCalls = 0;
  processRef.exit = (code) => exits.push(code);
  const control = installGracefulShutdown({
    processRef,
    signals: ['SIGINT', 'SIGTERM'],
    timeoutMs: 100,
    clock,
    shutdown: async () => { cleanupCalls += 1; order.push('cleanup'); throw new Error('cleanup failed'); },
    server: { close(callback) { closeCalls += 1; order.push('server-close'); callback(); } },
    logger: { error() {} }
  });
  processRef.emit('SIGTERM');
  processRef.emit('SIGINT');
  await control.current();
  assert.deepEqual(order, ['cleanup', 'server-close']);
  assert.equal(cleanupCalls, 1);
  assert.equal(closeCalls, 1);
  assert.equal(processRef.exitCode, 1);
  assert.deepEqual(exits, []);
  clock.tick(99);
  assert.deepEqual(exits, []);
  processRef.emit('SIGTERM');
  assert.equal(cleanupCalls, 1);
  assert.equal(closeCalls, 1);
  clock.tick(1);
  assert.deepEqual(exits, [1]);
  clock.tick(100);
  assert.deepEqual(exits, [1]);
  control.dispose();
});

test('server close rejection keeps the forced-exit deadline armed', async () => {
  const processRef = new EventEmitter();
  const exits = [];
  processRef.exit = (code) => exits.push(code);
  const control = installGracefulShutdown({
    processRef,
    signals: ['SIGTERM'],
    timeoutMs: 5,
    shutdown: async () => {},
    server: { close(callback) { callback(new Error('close failed')); } },
    logger: { error() {} }
  });
  processRef.emit('SIGTERM');
  await control.current();
  assert.equal(processRef.exitCode, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(exits, [1]);
  control.dispose();
});

test('hung server close is bounded by the forced-exit deadline', async () => {
  const processRef = new EventEmitter();
  const exits = [];
  processRef.exit = (code) => exits.push(code);
  const control = installGracefulShutdown({
    processRef,
    signals: ['SIGTERM'],
    timeoutMs: 5,
    shutdown: async () => {},
    server: { close() {} },
    logger: { error() {} }
  });
  processRef.emit('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(exits, [1]);
  control.dispose();
});

test('repeated signals share one cleanup and one server close attempt', async () => {
  const processRef = new EventEmitter();
  const exits = [];
  let cleanupCalls = 0;
  let closeCalls = 0;
  processRef.exit = (code) => exits.push(code);
  const control = installGracefulShutdown({
    processRef,
    signals: ['SIGINT', 'SIGTERM'],
    timeoutMs: 100,
    shutdown: async () => { cleanupCalls += 1; },
    server: { close(callback) { closeCalls += 1; callback(); } },
    logger: { error() {} }
  });
  processRef.emit('SIGINT');
  processRef.emit('SIGTERM');
  await control.current();
  assert.equal(cleanupCalls, 1);
  assert.equal(closeCalls, 1);
  assert.deepEqual(exits, []);
  control.dispose();
});
