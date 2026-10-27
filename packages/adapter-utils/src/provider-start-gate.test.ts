import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as ssh from "./ssh.js";
import * as sandbox from "./local-process-sandbox.js";
import { POSIX_PROVIDER_START_GATE, runChildProcess, runningProcesses, signalRunningProcess } from "./server-utils.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const dirs: string[] = [];
const ids: string[] = [];
async function temp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-launch-gate-"));
  dirs.push(dir);
  return dir;
}
function id() { const value = randomUUID(); ids.push(value); return value; }
function options(extra: Partial<Parameters<typeof runChildProcess>[3]> = {}) {
  return { cwd: process.cwd(), env: {}, timeoutSec: 5, graceSec: 1,
    onLog: async () => {}, onLogError: () => {}, stdin: "diagnostic prompt", onSpawn: async () => {}, ...extra };
}
async function absent(file: string) {
  return fs.stat(file).then(() => false, () => true);
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const runId of ids.splice(0)) {
    const running = runningProcesses.get(runId);
    if (running) {
      const closed = new Promise<void>((resolve) => running.child.once("close", () => resolve()));
      signalRunningProcess(running, "SIGKILL");
      await closed;
    }
  }
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe.skipIf(process.platform === "win32")("POSIX provider start gate", () => {
  it("starts the provider after delayed metadata with stdin already queued, preserving PID/PGID", async () => {
    let persistedAt = 0;
    let registeredPid = 0;
    let registeredPgid: number | null = null;
    const runId = id();
    const result = await runChildProcess(runId, process.execPath, ["-e", [
      "const startedAt=Date.now();let data='';",
      "const deadline=setTimeout(()=>process.exit(23),120);",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data',chunk=>{clearTimeout(deadline);data+=chunk});",
      "process.stdin.on('end',()=>process.stdout.write(JSON.stringify({startedAt,pid:process.pid,pgid:Number(require('node:child_process').execFileSync('ps',['-o','pgid=','-p',String(process.pid)],{encoding:'utf8'}).trim()),data})));",
    ].join("")], options({ onSpawn: async (meta) => {
      expect(runningProcesses.get(runId)?.child.pid).toBe(meta.pid);
      registeredPid = meta.pid; registeredPgid = meta.processGroupId;
      expect(Number(execFileSync("ps", ["-o", "pgid=", "-p", String(meta.pid)], { encoding: "utf8" }).trim())).toBe(meta.processGroupId);
      await new Promise((resolve) => setTimeout(resolve, 800));
      persistedAt = Date.now();
    } }));
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.data).toBe("diagnostic prompt");
    expect(output.startedAt).toBeGreaterThanOrEqual(persistedAt);
    expect(output.pid).toBe(registeredPid);
    expect(output.pgid).toBe(registeredPgid);
    expect(registeredPgid).toBe(registeredPid);
    expect(result.pid).toBe(registeredPid);
  });

  it.each(["async", "sync"])("never launches on %s metadata rejection", async (kind) => {
    const marker = path.join(await temp(), "provider-started");
    const run = runChildProcess(id(), process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`], options({
      onSpawn: kind === "async" ? async () => { throw new Error("metadata rejected"); } : () => { throw new Error("metadata rejected"); },
    }));
    await expect(run).rejects.toThrow("Failed to record child process metadata; provider was not launched");
    expect(await absent(marker)).toBe(true);
  });

  it.each(["sync", "async"])("reaps a metadata-rejected gate when the %s log observer throws", async (kind) => {
    const marker = path.join(await temp(), "provider-started");const runId = id();
    const onLogError = kind === "sync" ? () => { throw new Error("observer failed"); } : async () => { throw new Error("observer failed"); };
    await expect(runChildProcess(runId, process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`], options({
      timeoutSec: 0, onLogError, onSpawn: async () => { throw new Error("metadata rejected"); },
    }))).rejects.toThrow("Failed to record child process metadata; provider was not launched");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await absent(marker)).toBe(true);expect(runningProcesses.has(runId)).toBe(false);
  });

  it.each(["cancel", "timeout", "exit"])("never late-launches after %s while metadata is pending", async (mode) => {
    const marker = path.join(await temp(), "provider-started");
    const ack = deferred(); const spawned = deferred(); const runId = id();
    const run = runChildProcess(runId, process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`], options({
      timeoutSec: mode === "timeout" ? 0.1 : 0,
      onSpawn: () => { spawned.resolve(); return ack.promise; },
    }));
    await spawned.promise;
    const running = runningProcesses.get(runId)!;
    if (mode === "cancel") process.kill(-running.processGroupId!, "SIGTERM");
    if (mode === "exit") running.child.kill("SIGKILL");
    const result = await run;
    expect(result.timedOut).toBe(mode === "timeout");
    ack.resolve();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await absent(marker)).toBe(true);
    expect(runningProcesses.has(runId)).toBe(false);
  });

  it.each(["SIGTERM", "SIGINT"] as const)("never launches when %s is sent immediately before metadata ACK", async (signal) => {
    const marker = path.join(await temp(), "provider-started");
    const ack = deferred();const spawned = deferred();const runId = id();
    const resultPromise = runChildProcess(runId, process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`], options({
      timeoutSec: 0, onSpawn: () => { spawned.resolve(); return ack.promise; },
    }));
    await spawned.promise;
    const running = runningProcesses.get(runId)!;
    process.kill(-running.processGroupId!, signal);
    ack.resolve(); // Deliberately do not await exit/close before releasing ACK.
    try {
      const result = await resultPromise;
      expect(result.exitCode === 125 || result.signal === signal).toBe(true);
    } catch (err) {
      // A closed gate can report EPIPE before the OS exit event is observed.
      // That is a pre-exit startup refusal, not a late override of terminal state.
      expect(err).toMatchObject({ message: "Provider launch gate closed before acknowledgement", cause: { code: "EPIPE" } });
    }
    expect(await absent(marker)).toBe(true);expect(runningProcesses.has(runId)).toBe(false);
  });

  it.each(["cancel", "timeout"])("logs a late metadata rejection without overriding %s during cleanup", async (mode) => {
    const dir = await temp();const marker = path.join(dir, "provider-started");const executable = path.join(dir, "bwrap");
    await fs.writeFile(executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'started');\n`, { mode: 0o700 });
    const ack = deferred();const spawned = deferred();const cleanupStarted = deferred();const cleanupRelease = deferred();
    const cleanup = vi.fn(async () => { cleanupStarted.resolve(); await cleanupRelease.promise; });
    vi.spyOn(sandbox, "buildLocalProcessSandboxSpawnTarget").mockResolvedValue({ command: executable, args: [], cwd: dir, cleanup });
    const runId = id();const onLogError = vi.fn();
    const resultPromise = runChildProcess(runId, process.execPath, [], options({ timeoutSec: mode === "timeout" ? 0.1 : 0,
      localProcessSandbox: { workspaceDir: dir, command: executable }, onLogError,
      onSpawn: () => { spawned.resolve(); return ack.promise; },
    }));
    let settled = false;void resultPromise.then(() => { settled = true; }, () => { settled = true; });
    await spawned.promise;
    const child = runningProcesses.get(runId)!.child;
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    if (mode === "cancel") process.kill(-runningProcesses.get(runId)!.processGroupId!, "SIGTERM");
    await cleanupStarted.promise;
    const terminal = await exited;
    const metadataError = new Error("late metadata rejected after stop");ack.reject(metadataError);
    await vi.waitFor(() => expect(onLogError).toHaveBeenCalledWith(metadataError, runId, "failed to record child process metadata"));
    expect(settled).toBe(false);expect(await absent(marker)).toBe(true);
    cleanupRelease.resolve();const result = await resultPromise;
    expect(result.exitCode).toBe(terminal.code);expect(result.signal).toBe(terminal.signal);
    expect(result.timedOut).toBe(mode === "timeout");expect(cleanup).toHaveBeenCalledOnce();
  });

  it("force-kills a gated provider that ignores SIGTERM after exec with the same PID/PGID", async () => {
    let registeredPid = 0;let registeredPgid: number | null = null;const begin = Date.now();
    const result = await runChildProcess(id(), process.execPath, ["-e", [
      "process.on('SIGTERM',()=>{});process.stdin.resume();",
      "const pgid=Number(require('node:child_process').execFileSync('ps',['-o','pgid=','-p',String(process.pid)],{encoding:'utf8'}).trim());",
      "process.stdout.write(JSON.stringify({pid:process.pid,pgid}));setInterval(()=>{},1000);",
    ].join("")], options({ timeoutSec: 1, graceSec: 1, onSpawn: async (meta) => { registeredPid = meta.pid;registeredPgid = meta.processGroupId; } }));
    expect(result.timedOut).toBe(true);expect(result.signal).toBe("SIGKILL");
    expect(JSON.parse(result.stdout)).toEqual({ pid: registeredPid, pgid: registeredPgid });
    expect(result.pid).toBe(registeredPid);expect(registeredPgid).toBe(registeredPid);
    expect(Date.now() - begin).toBeGreaterThanOrEqual(1_900);
    expect(() => process.kill(registeredPid, 0)).toThrow();
  });

  it("fails closed and reaps the gate if stdin closes before acknowledgement", async () => {
    const marker = path.join(await temp(), "provider-started"); const runId = id();
    await expect(runChildProcess(runId, process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`], options({
      timeoutSec: 0,
      onSpawn: async () => { runningProcesses.get(runId)!.child.stdin!.destroy(); },
    }))).rejects.toThrow("Provider stdin was closed before launch");
    expect(await absent(marker)).toBe(true);expect(runningProcesses.has(runId)).toBe(false);
  });

  it("reaps only its own gate and preserves a newer registry entry and process group", async () => {
    const marker = path.join(await temp(), "provider-started"); const runId = id();
    const replacement = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    const replacementClosed = new Promise<void>((resolve) => replacement.once("close", () => resolve()));
    const replacementOwner = { child: replacement, graceSec: 1, processGroupId: replacement.pid! };
    try {
      await new Promise<void>((resolve, reject) => { replacement.once("spawn", () => resolve()); replacement.once("error", reject); });
      let oldPid = 0;
      await expect(runChildProcess(runId, process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`], options({
        timeoutSec: 0, onSpawn: async (meta) => { oldPid = meta.pid; runningProcesses.set(runId, replacementOwner); },
      }))).rejects.toThrow("Provider process ownership changed before launch");
      expect(await absent(marker)).toBe(true);
      expect(replacement.pid).not.toBe(oldPid);
      expect(runningProcesses.get(runId)).toBe(replacementOwner);
      expect(() => process.kill(replacement.pid!, 0)).not.toThrow();
      expect(replacement.exitCode).toBeNull();expect(replacement.signalCode).toBeNull();
    } finally {
      signalRunningProcess(replacementOwner, "SIGKILL");
      await replacementClosed;
      if (runningProcesses.get(runId) === replacementOwner) runningProcesses.delete(runId);
    }
  });

  it("queues large unicode/NUL prompts plus EOF without waiting on pipe backpressure", async () => {
    const prompt = "π\0漢字".repeat(250_000);
    const result = await runChildProcess(id(), process.execPath, ["-e", [
      "const crypto=require('node:crypto');const hash=crypto.createHash('sha256');let bytes=0;",
      "process.stdin.on('data',chunk=>{hash.update(chunk);bytes+=chunk.length});",
      "process.stdin.on('end',()=>process.stdout.write(JSON.stringify({bytes,hash:hash.digest('hex')})));",
    ].join("")], options({ stdin: prompt }));
    const { createHash } = await import("node:crypto");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ bytes: Buffer.byteLength(prompt), hash: createHash("sha256").update(prompt).digest("hex") });
  });

  it("preserves literal argv, environment and cwd without shell expansion", async () => {
    const dir = await temp(); const marker = path.join(dir, "injected");
    const args = ["with spaces", "$HOME", `$(touch ${marker})`, "'quotes'", "a\nb"];
    const result = await runChildProcess(id(), process.execPath, ["-e", "let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({args:process.argv.slice(1),env:process.env.GATE_VALUE,cwd:process.cwd(),input})))", "--", ...args], options({ cwd: dir, env: { GATE_VALUE: "$HOME literal" } }));
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ args, env: "$HOME literal", cwd: dir, input: "diagnostic prompt" });
    expect(await absent(marker)).toBe(true);
  });

  it("sends EOF for empty input and leaves calls without stdin on the direct path", async () => {
    const script = "let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify(input)))";
    const empty = await runChildProcess(id(), process.execPath, ["-e", script], options({ stdin: "" }));
    expect(empty.stdout).toBe('""');
    const ack = deferred();
    const noInput = await runChildProcess(id(), process.execPath, ["-e", "process.stdout.write('direct')"], options({ stdin: undefined, onSpawn: () => ack.promise }));
    expect(noInput.stdout).toBe("direct");
    ack.resolve();
  });

  it("consumes early-exit EPIPE rather than throwing an unhandled stdin error", async () => {
    const result = await runChildProcess(id(), process.execPath, ["-e", "process.exit(7)"], options({ stdin: "x".repeat(8 * 1024 * 1024) }));
    expect(result.exitCode).toBe(7);
  });

  it.each([null, "WRONG\n", "GO extra\n"])("fails closed when the private gate receives %s", async (token) => {
    const marker = path.join(await temp(), "provider-started");
    const child = spawn("/bin/sh", ["-c", POSIX_PROVIDER_START_GATE, "gate-test", process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`], { stdio: ["ignore", "pipe", "pipe", "pipe"] });
    const closed = new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    (child.stdio[3] as Writable).end(token ?? undefined);
    expect(await closed).toBe(125);
    expect(await absent(marker)).toBe(true);
  });

  it.skipIf(process.platform !== "linux")("closes gate fd 3 before exec", async () => {
    const result = await runChildProcess(id(), "/bin/sh", ["-c", "if [ -e /proc/self/fd/3 ]; then exit 31; fi; cat"], options());
    expect(result.exitCode).toBe(0); expect(result.stdout).toBe("diagnostic prompt");
  });

  it("rejects missing and non-executable commands before persisting a wrapper identity", async () => {
    const dir = await temp();const nonexec = path.join(dir, "not-executable");await fs.writeFile(nonexec, "file", { mode: 0o600 });
    const onSpawn = vi.fn(async () => {});
    await expect(runChildProcess(id(), "paperclip-no-such-public-test-command", [], options({ onSpawn }))).rejects.toThrow("Command not found in PATH");
    await expect(runChildProcess(id(), nonexec, [], options({ onSpawn }))).rejects.toThrow("Command is not executable");
    expect(onSpawn).not.toHaveBeenCalled();
  });

  it("reports a bare mode-0644 PATH file as non-executable without launching it", async () => {
    const dir = await temp();const command = "paperclip-nonexec-path-fixture";
    await fs.writeFile(path.join(dir, command), "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    const onSpawn = vi.fn(async () => {});
    await expect(runChildProcess(id(), command, [], options({ env: { PATH: dir }, onSpawn }))).rejects.toThrow(`Command is not executable: "${command}"`);
    expect(onSpawn).not.toHaveBeenCalled();
  });

  it.each(["ssh", "bwrap"])("preserves resolved %s argv/env/cwd on successful exec", async (transport) => {
    const dir = await temp(); const executable = path.join(dir, transport);
    const targetArgs = ["literal space", "$HOME", "$(false)"];
    await fs.writeFile(executable, `#!${process.execPath}\nlet data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),env:process.env.GATE_VALUE,wrapper:process.env.WRAPPER_ENV,input:data})));\n`, { mode: 0o700 });
    const cleanup = vi.fn(async () => {});
    const remote = { host: "never-contact.invalid", port: 22, username: "fixture", remoteWorkspacePath: "/remote", remoteCwd: "/remote", privateKey: null, knownHosts: null, strictHostKeyChecking: true };
    const build = transport === "ssh"
      ? vi.spyOn(ssh, "buildSshSpawnTarget").mockResolvedValue({ command: executable, args: targetArgs, cleanup })
      : vi.spyOn(sandbox, "buildLocalProcessSandboxSpawnTarget").mockResolvedValue({ command: executable, args: targetArgs, cwd: dir, env: { WRAPPER_ENV: "wrapper-value" }, cleanup });
    const result = await runChildProcess(id(), process.execPath, ["original-argument"], options({ cwd: dir, env: { PATH: dir + path.delimiter + process.env.PATH, GATE_VALUE: "original-value" },
      ...(transport === "ssh" ? { remoteExecution: remote } : { localProcessSandbox: { workspaceDir: dir, command: executable } }),
    }));
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ args: targetArgs, cwd: transport === "ssh" ? process.cwd() : dir, env: "original-value", ...(transport === "bwrap" ? { wrapper: "wrapper-value" } : {}), input: "diagnostic prompt" });
    expect(build).toHaveBeenCalledOnce();expect(cleanup).toHaveBeenCalledOnce();
  });

  it("awaits resolved-target cleanup once after an asynchronous spawn error", async () => {
    const dir = await temp(); const executable = path.join(dir, "bwrap");
    await fs.writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const cleanup = vi.fn(async () => {});
    vi.spyOn(sandbox, "buildLocalProcessSandboxSpawnTarget").mockResolvedValue({ command: executable, args: [], cwd: path.join(dir, "missing-cwd"), cleanup });
    await expect(runChildProcess(id(), process.execPath, [], options({ localProcessSandbox: { workspaceDir: dir, command: executable } }))).rejects.toThrow("Failed to start command");
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it.each(["ssh", "bwrap"])("retains resolved %s wrapper arguments/cwd/env and awaits cleanup exactly once on abort", async (transport) => {
    const dir = await temp();const marker = path.join(dir, "provider-started");
    const executable = path.join(dir, transport);
    await fs.writeFile(executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'started');\n`, { mode: 0o700 });
    const cleanupGate = deferred();const cleanupStarted = deferred();
    const cleanup = vi.fn(async () => { cleanupStarted.resolve(); await cleanupGate.promise; });
    if (transport === "ssh") vi.spyOn(ssh, "buildSshSpawnTarget").mockResolvedValue({ command: executable, args: ["literal space", "$HOME"], cleanup });
    else vi.spyOn(sandbox, "buildLocalProcessSandboxSpawnTarget").mockResolvedValue({ command: executable, args: ["literal space", "$HOME"], cwd: dir, env: { WRAPPER_ENV: "kept" }, cleanup });
    const onSpawn = vi.fn(async () => { throw new Error("metadata rejected"); });
    const result = runChildProcess(id(), process.execPath, ["argument"], options({ env: { PATH: dir + path.delimiter + process.env.PATH }, onSpawn,
      ...(transport === "ssh" ? { remoteExecution: { host: "never-contact.invalid", port: 22, username: "fixture", remoteWorkspacePath: "/remote", remoteCwd: "/remote", privateKey: null, knownHosts: null, strictHostKeyChecking: true } } : { localProcessSandbox: { workspaceDir: dir, command: executable } }),
    }));
    const rejected = expect(result).rejects.toThrow("Failed to record child process metadata");
    await cleanupStarted.promise;
    let settled = false;void result.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));expect(settled).toBe(false);
    cleanupGate.resolve();await rejected;
    expect(cleanup).toHaveBeenCalledTimes(1);expect(await absent(marker)).toBe(true);
  });
});
