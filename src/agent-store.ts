import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, truncateSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { agentStateSchema, emptyAgentState, type AgentState } from './agent-contract.js';

export interface AgentStore { load(): AgentState; save(state: AgentState): void; close(): void }
export class MemoryAgentStore implements AgentStore {
  private state = emptyAgentState();
  load() { return structuredClone(this.state); }
  save(state: AgentState) { this.state = structuredClone(agentStateSchema.parse(state)); }
  close() {}
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

/** Fsynced state journal with integrity chaining; one process owns a file. Never replays game writes. */
export class FileAgentStore implements AgentStore {
  private state = emptyAgentState();
  private hash = '';
  private fd?: number;
  private lockFd?: number;
  private poisoned = false;
  constructor(readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
    const lock = `${file}.lock`;
    if (existsSync(lock)) {
      const pid = Number(readFileSync(lock, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('AGENT_STORE_LOCK_INVALID');
      try { process.kill(pid, 0); throw new Error('AGENT_STORE_IN_USE'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      // Serialize stale-lock reclamation; never unlink a newly acquired live owner's lock.
      const guard = `${lock}.reclaim`;
      const guardFd = openSync(guard, 'wx');
      try {
        if (existsSync(lock)) {
          const currentPid = Number(readFileSync(lock, 'utf8'));
          if (!Number.isSafeInteger(currentPid) || currentPid <= 0) throw new Error('AGENT_STORE_LOCK_INVALID');
          try { process.kill(currentPid, 0); throw new Error('AGENT_STORE_IN_USE'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
          unlinkSync(lock);
        }
        this.lockFd = openSync(lock, 'wx');
      } finally { closeSync(guardFd); unlinkSync(guard); }
    }
    this.lockFd ??= openSync(lock, 'wx');
    try {
      writeSync(this.lockFd, String(process.pid)); fsyncSync(this.lockFd);
      const snapshot = `${file}.snapshot`;
      if (existsSync(snapshot)) {
        const saved = JSON.parse(readFileSync(snapshot, 'utf8'));
        if (saved.checksum !== digest(saved.payload) || typeof saved.chainHash !== 'string') throw new Error('AGENT_STORE_SNAPSHOT_CORRUPT');
        this.state = agentStateSchema.parse(JSON.parse(saved.payload)); this.hash = saved.chainHash;
      }
      const checkpointSequence = this.state.sequence;
      if (existsSync(file)) {
        const raw = readFileSync(file);
        const end = raw.lastIndexOf(10) + 1;
        for (const line of raw.subarray(0, end).toString('utf8').split('\n').filter(Boolean)) {
          const entry = JSON.parse(line);
          const state = agentStateSchema.parse(JSON.parse(entry.payload));
          if (state.sequence <= checkpointSequence) {
            if (state.sequence === checkpointSequence && entry.hash !== this.hash) throw new Error('AGENT_STORE_CHECKPOINT_MISMATCH');
            continue; // Crash after checkpoint but before journal rotation.
          }
          if (entry.previous !== this.hash || entry.hash !== digest(entry.previous + entry.payload)) throw new Error('AGENT_STORE_CORRUPT');
          if (state.sequence !== this.state.sequence + 1) throw new Error('AGENT_STORE_SEQUENCE');
          this.state = state; this.hash = entry.hash;
        }
        // An incomplete final write is not a committed snapshot.
        if (end !== raw.length) truncateSync(file, end);
      }
      this.fd = openSync(file, 'a');
    } catch (error) { this.close(); throw error; }
  }
  load() { return structuredClone(this.state); }
  save(state: AgentState) {
    if (this.fd === undefined || this.poisoned) throw new Error('AGENT_STORE_CLOSED_OR_FAILED');
    const checked = agentStateSchema.parse(state);
    if (checked.sequence !== this.state.sequence + 1) throw new Error('AGENT_STORE_SEQUENCE');
    const payload = JSON.stringify(checked), hash = digest(this.hash + payload);
    const bytes = Buffer.from(JSON.stringify({ previous: this.hash, hash, payload }) + '\n');
    try {
      let written = 0;
      while (written < bytes.length) {
        const count = writeSync(this.fd, bytes, written, bytes.length - written);
        if (count <= 0) throw new Error('AGENT_STORE_SHORT_WRITE');
        written += count;
      }
      fsyncSync(this.fd);
    } catch (error) { this.poisoned = true; throw error; }
    this.state = structuredClone(checked); this.hash = hash;
    if (checked.sequence % 64 === 0) {
      // Atomic checkpoint first; archive rather than delete historical journal segments.
      const temporary = `${this.file}.snapshot.tmp`;
      let fd: number | undefined;
      try {
        fd = openSync(temporary, 'w');
        const body = Buffer.from(JSON.stringify({ payload, checksum: digest(payload), chainHash: hash }));
        let offset = 0;
        while (offset < body.length) {
          const count = writeSync(fd, body, offset, body.length - offset);
          if (count <= 0) throw new Error('AGENT_STORE_SHORT_WRITE');
          offset += count;
        }
        fsyncSync(fd); closeSync(fd); fd = undefined;
        renameSync(temporary, `${this.file}.snapshot`);
        closeSync(this.fd); this.fd = undefined;
        renameSync(this.file, `${this.file}.${checked.sequence}.archive`);
        this.fd = openSync(this.file, 'a');
      } catch (error) { this.poisoned = true; throw error; }
      finally { if (fd !== undefined) closeSync(fd); }
    }
  }
  close() {
    if (this.fd !== undefined) { closeSync(this.fd); this.fd = undefined; }
    if (this.lockFd !== undefined) { closeSync(this.lockFd); this.lockFd = undefined; unlinkSync(`${this.file}.lock`); }
  }
}
