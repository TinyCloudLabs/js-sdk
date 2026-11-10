import { ISessionStorage, PersistedSessionData, validatePersistedSessionData, registerOwnedSessionStorage } from "@tinycloud/sdk-core";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync, lstatSync } from "fs";
import { dirname, join } from "path";
import { createHash } from "node:crypto";

/**
 * File-based session storage for Node.js.
 *
 * Sessions are persisted to the file system and survive process restarts.
 * Suitable for:
 * - CLI applications
 * - Long-running server processes
 * - Development environments
 *
 * @example
 * ```typescript
 * const storage = new FileSessionStorage("/tmp/tinycloud-sessions");
 * await storage.save("0x123...", sessionData);
 * // Session persists across process restarts
 * ```
 */
export class FileSessionStorage implements ISessionStorage {
  private readonly baseDir: string;

  /**
   * Create a new FileSessionStorage.
   *
   * @param baseDir - Directory to store session files (default: ~/.tinycloud/sessions)
   */
  constructor(baseDir?: string) {
    this.baseDir = baseDir || this.getDefaultDir();
    this.ensureDirectoryExists();
    if (new.target === FileSessionStorage) {
      registerOwnedSessionStorage(this, (address, signature) => this.invalidateSession(address, signature));
    }
  }

  /**
   * Get the default session storage directory.
   */
  private getDefaultDir(): string {
    const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
    return join(home, ".tinycloud", "sessions");
  }

  /**
   * Ensure the storage directory exists.
   */
  private ensureDirectoryExists(): void {
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true });
    }
  }

  /**
   * Get the file path for an address.
   */
  private getFilePath(address: string): string {
    const normalizedAddress = address.toLowerCase();
    // Use a hash of the address to avoid filesystem issues
    const filename = `${normalizedAddress.replace("0x", "")}.json`;
    return join(this.baseDir, filename);
  }

  private retirementPath(address: string, signature: string): string {
    return `${this.getFilePath(address)}.${createHash("sha256").update(signature).digest("hex")}.signed-out`;
  }

  private invalidateSession(address: string, signature: string): void {
    let failure: unknown;
    const marker = this.retirementPath(address, signature);
    try {
      writeFileSync(marker, "", { mode: 0o600, flag: "wx" });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
        try {
          if (!lstatSync(marker).isFile()) failure = error;
        } catch (readError) {
          failure = readError;
        }
      } else {
        failure = error;
      }
    }
    try {
      const filePath = this.getFilePath(address);
      if (existsSync(filePath)) {
        // The comparison and unlink do not yield to another participating writer in this process.
        const stored = JSON.parse(readFileSync(filePath, "utf-8")) as PersistedSessionData;
        if (stored.signature === signature) unlinkSync(filePath);
      }
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) throw failure;
  }

  /**
   * Save a session for an address.
   */
  async save(address: string, session: PersistedSessionData): Promise<void> {
    const filePath = this.getFilePath(address);
    if (existsSync(this.retirementPath(address, session.signature))) {
      throw new Error("Session was cancelled by sign-out.");
    }
    const data = JSON.stringify(session, null, 2);
    // Write a sibling temp file, then rename over the target: a crash or a failed write
    // never leaves a half-written session where the previous one was.
    // A fresh name per call, created exclusively: concurrent saves (other processes, worker threads) never share a temp file,
    // and the file always gets the owner-only mode.
    const tempPath = `${filePath}.${process.pid}.${process.hrtime.bigint()}.tmp`;
    try {
      // The session holds a key: the temp file, and so the file renamed over the target, is owner-only.
      writeFileSync(tempPath, data, { mode: 0o600, flag: "wx" });
      renameSync(tempPath, filePath);
    } catch (error) {
      try {
        unlinkSync(tempPath);
      } catch {
        // The temp file may never have been created.
      }
      throw error;
    }
  }

  /**
   * Load a session for an address.
   *
   * Rejects when the file exists but cannot be read or parsed; the file is left in place.
   */
  async load(address: string): Promise<PersistedSessionData | null> {
    const filePath = this.getFilePath(address);

    if (!existsSync(filePath)) {
      return null;
    }

    try {
      const data = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(data);

      // Validate loaded data against schema
      const validation = validatePersistedSessionData(parsed);
      if (!validation.ok) {
        console.warn(`Invalid session data for ${address}:`, validation.error.message);
        // Clean up invalid session
        unlinkSync(filePath);
        return null;
      }

      const session = validation.data;
      if (existsSync(this.retirementPath(address, session.signature))) return null;

      // Check if session is expired
      const expiresAt = new Date(session.expiresAt);
      if (expiresAt < new Date()) {
        // Clean up expired session
        unlinkSync(filePath);
        return null;
      }

      return session;
    } catch (error) {
      // A read or parse error says nothing about whether the session is still wanted:
      // keep the file and let the caller see why it could not be read.
      throw new Error(
        `Could not read session file ${filePath}: ${error}`,
      );
    }
  }

  /**
   * Clear a session for an address.
   */
  async clear(address: string): Promise<void> {
    const filePath = this.getFilePath(address);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  }

  /**
   * Check if a session exists for an address.
   */
  exists(address: string): boolean {
    const filePath = this.getFilePath(address);
    if (!existsSync(filePath)) {
      return false;
    }

    try {
      const data = readFileSync(filePath, "utf-8");
      const session: PersistedSessionData = JSON.parse(data);
      if (existsSync(this.retirementPath(address, session.signature))) return false;

      // Check if session is expired
      const expiresAt = new Date(session.expiresAt);
      if (expiresAt < new Date()) {
        // Clean up expired session
        unlinkSync(filePath);
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if file system storage is available.
   */
  isAvailable(): boolean {
    try {
      this.ensureDirectoryExists();
      return existsSync(this.baseDir);
    } catch {
      return false;
    }
  }
}
