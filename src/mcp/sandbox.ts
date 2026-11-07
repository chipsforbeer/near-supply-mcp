import { newQuickJSWASMModule, RELEASE_SYNC, shouldInterruptAfterDeadline } from 'quickjs-emscripten';
import type { QuickJSContext, QuickJSDeferredPromise, QuickJSHandle, QuickJSRuntime } from 'quickjs-emscripten';
import { OpError, publicError } from '../ops/errors.ts';

export type SandboxLimits = {
  maxCodeBytes: number;
  timeoutMs: number;
  memoryBytes: number;
  maxCalls: number;
  maxResultChars: number;
};

export const DEFAULT_LIMITS: SandboxLimits = {
  maxCodeBytes: 32 * 1024,
  timeoutMs: 60_000,
  memoryBytes: 64 * 1024 * 1024,
  maxCalls: 25,
  maxResultChars: 24_000,
};

export type HostApi = {
  spec(): Promise<unknown>;
  call?(op: string, args: unknown): Promise<unknown>;
};

export type SandboxResult = { ok: true; text: string; calls: number } | { ok: false; error: string; calls: number };

// Inside the sandbox only `api` exists: api.spec() and, for execute, api.call(name, args).
const PRELUDE = `
const __spec = __host_spec;
const __call = typeof __host_call === 'function' ? __host_call : undefined;
delete globalThis.__host_spec;
delete globalThis.__host_call;
const __api = { spec: async () => JSON.parse(await __spec()) };
if (__call) __api.call = async (name, args) => JSON.parse(await __call(String(name), JSON.stringify(args === undefined ? {} : args)));
globalThis.api = Object.freeze(__api);
`;

function errorText(value: unknown): string {
  if (value && typeof value === 'object' && 'message' in value) {
    const v = value as { name?: string; message?: string };
    const message = String(v.message ?? '');
    if (/interrupted/i.test(message)) return 'Run stopped: time limit reached.';
    if (/out of memory/i.test(message)) return 'Run stopped: memory limit reached.';
    if (/stack overflow/i.test(message)) return 'Run stopped: stack limit reached.';
    return v.name && v.name !== 'Error' ? `${v.name}: ${message}` : message;
  }
  return String(value);
}

export function renderResult(value: unknown, maxChars: number): string {
  const normalized = value === undefined ? null : value;
  let text = JSON.stringify(normalized, null, 2) ?? 'null';
  if (text.length > maxChars) text = JSON.stringify(normalized) ?? 'null';
  if (text.length > maxChars) {
    const more = text.length - maxChars;
    text = `${text.slice(0, maxChars)}\n[truncated: ${more} more characters]`;
  }
  return text;
}

function hostErrorMessage(e: unknown): string {
  const p = publicError(e);
  const details = p.details === undefined ? '' : ` ${JSON.stringify(p.details)}`;
  return `${p.code}: ${p.message}${details}`;
}

export async function runInSandbox(code: string, host: HostApi, limits: SandboxLimits): Promise<SandboxResult> {
  let calls = 0;
  if (typeof code !== 'string' || code.trim() === '') return { ok: false, error: 'code is required.', calls };
  if (Buffer.byteLength(code, 'utf8') > limits.maxCodeBytes) {
    return { ok: false, error: `code must be at most ${limits.maxCodeBytes} bytes.`, calls };
  }

  // A fresh WebAssembly instance per run: nothing is shared between runs, and a run that
  // fails mid-flight is simply dropped with its instance.
  const QuickJS = await newQuickJSWASMModule(RELEASE_SYNC);
  const runtime: QuickJSRuntime = QuickJS.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(1024 * 1024);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + limits.timeoutMs));
  const vm: QuickJSContext = runtime.newContext();
  const pending = new Set<QuickJSDeferredPromise>();
  let timer: NodeJS.Timeout | undefined;
  let clean = false;

  const pump = () => {
    if (!runtime.alive) return;
    const r = runtime.executePendingJobs();
    r.dispose();
  };

  const exposeAsync = (name: string, impl: (args: string[]) => Promise<string>) => {
    const fn = vm.newFunction(name, (...handles: QuickJSHandle[]) => {
      const args = handles.map((h) => vm.getString(h));
      const deferred = vm.newPromise();
      pending.add(deferred);
      impl(args).then(
        (text) => {
          if (!vm.alive || !deferred.alive) return;
          const h = vm.newString(text);
          deferred.resolve(h);
          h.dispose();
        },
        (e: unknown) => {
          if (!vm.alive || !deferred.alive) return;
          const h = vm.newError(e instanceof Error ? e.message : String(e));
          deferred.reject(h);
          h.dispose();
        },
      );
      deferred.settled.then(() => {
        pending.delete(deferred);
        if (deferred.alive) deferred.dispose();
        pump();
      });
      return deferred.handle;
    });
    vm.setProp(vm.global, name, fn);
    fn.dispose();
  };

  try {
    exposeAsync('__host_spec', async () => JSON.stringify(await host.spec()));
    if (host.call) {
      const hostCall = host.call.bind(host);
      exposeAsync('__host_call', async ([name, argsJson]) => {
        calls += 1;
        if (calls > limits.maxCalls) throw new Error(`At most ${limits.maxCalls} operation calls per run.`);
        try {
          const result = await hostCall(name ?? '', JSON.parse(argsJson ?? '{}'));
          return JSON.stringify(result === undefined ? null : result);
        } catch (e) {
          throw new Error(hostErrorMessage(e));
        }
      });
    }

    const evaluated = vm.evalCode(`${PRELUDE}\n;(${code}\n)()`, 'run.js');
    if (evaluated.error) {
      const err = vm.dump(evaluated.error);
      evaluated.error.dispose();
      return { ok: false, error: errorText(err), calls };
    }
    const promiseHandle = evaluated.value;
    const native = vm.resolvePromise(promiseHandle);
    promiseHandle.dispose();
    pump();

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new OpError('limit_exceeded', 'Run stopped: time limit reached.')), limits.timeoutMs);
    });
    const settled = await Promise.race([native, timeout]);
    if (settled.error) {
      const err = vm.dump(settled.error);
      settled.error.dispose();
      clean = pending.size === 0;
      return { ok: false, error: errorText(err), calls };
    }
    const value = vm.dump(settled.value);
    settled.value.dispose();
    clean = pending.size === 0;
    return { ok: true, text: renderResult(value, limits.maxResultChars), calls };
  } catch (e) {
    return { ok: false, error: e instanceof OpError ? e.message : errorText(e), calls };
  } finally {
    if (timer) clearTimeout(timer);
    if (clean) {
      try {
        vm.dispose();
        runtime.dispose();
      } catch {
        // The instance is discarded either way.
      }
    }
  }
}

// At most `max` runs at once; callers wait up to `waitMs` for a slot.
export class Gate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly max: number;
  private readonly waitMs: number;

  constructor(max: number, waitMs: number) {
    this.max = max;
    this.waitMs = waitMs;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve, reject) => {
        const waiter = () => {
          clearTimeout(t);
          resolve();
        };
        const t = setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new OpError('limit_exceeded', 'Server busy, try again shortly.'));
        }, this.waitMs);
        this.waiters.push(waiter);
      });
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

export const SANDBOX_GATE = new Gate(2, 10_000);
