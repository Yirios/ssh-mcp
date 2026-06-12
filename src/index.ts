#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { Client, ClientChannel, SFTPWrapper } from 'ssh2';
import { z } from 'zod';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';

// Example usage: node build/index.js --host=1.2.3.4 --port=22 --user=root --password=pass --key=path/to/key --timeout=5000 --disableSudo
function parseArgv() {
  const args = process.argv.slice(2);
  const config: Record<string, string | null> = {};
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const equalIndex = arg.indexOf('=');
      if (equalIndex === -1) {
        // Flag without value
        config[arg.slice(2)] = null;
      } else {
        // Key=value pair
        config[arg.slice(2, equalIndex)] = arg.slice(equalIndex + 1);
      }
    }
  }
  return config;
}
const isTestMode = process.env.SSH_MCP_TEST === '1';
const isCliEnabled = process.env.SSH_MCP_DISABLE_MAIN !== '1';
const argvConfig = (isCliEnabled || isTestMode) ? parseArgv() : {} as Record<string, string>;

const HOST = argvConfig.host;
const PORT = argvConfig.port ? parseInt(argvConfig.port) : 22;
const USER = argvConfig.user;
const PASSWORD = argvConfig.password;
const SUPASSWORD = argvConfig.suPassword;
const SUDOPASSWORD = argvConfig.sudoPassword;
const DISABLE_SUDO = argvConfig.disableSudo !== undefined;
const KEY = argvConfig.key;
const PROFILES_FILE = argvConfig.profiles || process.env.SSH_MCP_PROFILES;
const PROFILES_DIR = argvConfig.profilesDir || process.env.SSH_MCP_PROFILES_DIR;
const DEFAULT_TIMEOUT = argvConfig.timeout ? parseInt(argvConfig.timeout) : 60000; // 60 seconds default timeout
const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_FILE_SIZE_RAW = argvConfig.maxFileSize;
export function parseMaxFileSize(value: string | null | undefined): number {
  if (typeof value === 'string') {
    const lowered = value.toLowerCase();
    if (lowered === 'none') return Infinity;
    const parsed = parseInt(value);
    if (isNaN(parsed)) return DEFAULT_MAX_FILE_SIZE;
    if (parsed <= 0) return Infinity;
    return parsed;
  }
  return DEFAULT_MAX_FILE_SIZE;
}
const MAX_FILE_SIZE = parseMaxFileSize(MAX_FILE_SIZE_RAW);
// Max characters configuration:
// - Default: 1000 characters
// - When set via --maxChars:
//   * a positive integer enforces that limit
//   * 0 or a negative value disables the limit (no max)
//   * the string "none" (case-insensitive) disables the limit (no max)
const MAX_CHARS_RAW = argvConfig.maxChars;
const MAX_CHARS = (() => {
  if (typeof MAX_CHARS_RAW === 'string') {
    const lowered = MAX_CHARS_RAW.toLowerCase();
    if (lowered === 'none') return Infinity;
    const parsed = parseInt(MAX_CHARS_RAW);
    if (isNaN(parsed)) return 1000;
    if (parsed <= 0) return Infinity;
    return parsed;
  }
  return 1000;
})();

function validateConfig(config: Record<string, string | null>) {
  const errors = [];
  const hasProfiles = Boolean(config.profiles || config.profilesDir || process.env.SSH_MCP_PROFILES || process.env.SSH_MCP_PROFILES_DIR);
  if (!hasProfiles && !config.host) errors.push('Missing required --host');
  if (!hasProfiles && !config.user) errors.push('Missing required --user');
  if (config.port && isNaN(Number(config.port))) errors.push('Invalid --port');
  if (errors.length > 0) {
    throw new Error('Configuration error:\n' + errors.join('\n'));
  }
}

if (isCliEnabled) {
  validateConfig(argvConfig);
}

// Command sanitization and validation
export function sanitizeCommand(command: string): string {
  if (typeof command !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'Command must be a string');
  }

  const trimmedCommand = command.trim();
  if (!trimmedCommand) {
    throw new McpError(ErrorCode.InvalidParams, 'Command cannot be empty');
  }

  // Length check
  if (Number.isFinite(MAX_CHARS) && trimmedCommand.length > (MAX_CHARS as number)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Command is too long (max ${MAX_CHARS} characters)`
    );
  }

  return trimmedCommand;
}

function sanitizePassword(password: string | undefined): string | undefined {
  if (typeof password !== 'string') return undefined;
  // minimal check, do not log or modify content
  if (password.length === 0) return undefined;
  return password;
}

// Escape command for use in shell contexts (like pkill)
export function escapeCommandForShell(command: string): string {
  // Replace single quotes with escaped single quotes
  return command.replace(/'/g, "'\"'\"'");
}

// SSH Connection Manager to maintain persistent connection
export interface SSHConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  suPassword?: string;
  sudoPassword?: string;  // Password for sudo commands specifically (if different from suPassword)
}

export interface SSHProfile extends SSHConfig {
  name: string;
  keyPath?: string;
}

function parseEnvFile(content: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const equalIndex = line.indexOf('=');
    if (equalIndex === -1) continue;
    const key = line.slice(0, equalIndex).trim();
    let value = line.slice(equalIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

function profileFromEnv(name: string, env: Record<string, string>): SSHProfile {
  const host = env.SSH_MCP_HOST || env.HOST;
  const username = env.SSH_MCP_USER || env.SSH_MCP_USERNAME || env.USER;
  if (!host) {
    throw new Error(`Profile "${name}" is missing SSH_MCP_HOST`);
  }
  if (!username) {
    throw new Error(`Profile "${name}" is missing SSH_MCP_USER`);
  }

  const profile: SSHProfile = {
    name,
    host,
    port: Number(env.SSH_MCP_PORT || env.PORT || 22),
    username,
  };

  const password = sanitizePassword(env.SSH_MCP_PASSWORD || env.PASSWORD);
  const suPassword = sanitizePassword(env.SSH_MCP_SU_PASSWORD || env.SSH_MCP_SUPASSWORD || env.SU_PASSWORD);
  const sudoPassword = sanitizePassword(env.SSH_MCP_SUDO_PASSWORD || env.SSH_MCP_SUDOPASSWORD || env.SUDO_PASSWORD);
  const keyPath = env.SSH_MCP_KEY || env.SSH_MCP_KEY_PATH || env.KEY;

  if (password) profile.password = password;
  if (suPassword) profile.suPassword = suPassword;
  if (sudoPassword) profile.sudoPassword = sudoPassword;
  if (keyPath) profile.keyPath = keyPath;

  return profile;
}

function profileFromObject(name: string, value: any): SSHProfile {
  const host = value.host || value.SSH_MCP_HOST;
  const username = value.user || value.username || value.SSH_MCP_USER || value.SSH_MCP_USERNAME;
  if (!host) {
    throw new Error(`Profile "${name}" is missing host`);
  }
  if (!username) {
    throw new Error(`Profile "${name}" is missing user`);
  }

  const profile: SSHProfile = {
    name,
    host,
    port: Number(value.port || value.SSH_MCP_PORT || 22),
    username,
  };

  const password = sanitizePassword(value.password || value.SSH_MCP_PASSWORD);
  const suPassword = sanitizePassword(value.suPassword || value.SSH_MCP_SU_PASSWORD || value.SSH_MCP_SUPASSWORD);
  const sudoPassword = sanitizePassword(value.sudoPassword || value.SSH_MCP_SUDO_PASSWORD || value.SSH_MCP_SUDOPASSWORD);
  const keyPath = value.key || value.keyPath || value.SSH_MCP_KEY || value.SSH_MCP_KEY_PATH;

  if (password) profile.password = password;
  if (suPassword) profile.suPassword = suPassword;
  if (sudoPassword) profile.sudoPassword = sudoPassword;
  if (keyPath) profile.keyPath = keyPath;

  return profile;
}

function loadProfiles(): Map<string, SSHProfile> {
  const profiles = new Map<string, SSHProfile>();

  if (PROFILES_FILE) {
    const raw = readFileSync(PROFILES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const profileValues = parsed.profiles || parsed;
    for (const [name, value] of Object.entries(profileValues)) {
      profiles.set(name, profileFromObject(name, value));
    }
  }

  if (PROFILES_DIR) {
    for (const entry of readdirSync(PROFILES_DIR)) {
      if (!entry.endsWith('.env')) continue;
      const fullPath = path.join(PROFILES_DIR, entry);
      if (!statSync(fullPath).isFile()) continue;
      const name = entry.slice(0, -'.env'.length);
      profiles.set(name, profileFromEnv(name, parseEnvFile(readFileSync(fullPath, 'utf8'))));
    }
  }

  if (profiles.size === 0 && HOST && USER) {
    const profile: SSHProfile = {
      name: 'default',
      host: HOST,
      port: PORT,
      username: USER,
    };
    if (PASSWORD) profile.password = PASSWORD;
    if (KEY) profile.keyPath = KEY;
    if (SUPASSWORD !== null && SUPASSWORD !== undefined) {
      profile.suPassword = sanitizePassword(SUPASSWORD);
    }
    if (SUDOPASSWORD !== null && SUDOPASSWORD !== undefined) {
      profile.sudoPassword = sanitizePassword(SUDOPASSWORD);
    }
    profiles.set(profile.name, profile);
  }

  return profiles;
}

const profiles = loadProfiles();

function resolveProfileName(requested?: string): string {
  if (requested) {
    if (!profiles.has(requested)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Unknown profile "${requested}". Available profiles: ${Array.from(profiles.keys()).join(', ')}`
      );
    }
    return requested;
  }

  if (profiles.size === 1) {
    const first = profiles.keys().next().value;
    if (first) return first;
  }

  throw new McpError(
    ErrorCode.InvalidParams,
    `Multiple SSH profiles are configured. Pass one of: ${Array.from(profiles.keys()).join(', ')}`
  );
}

async function buildSshConfig(profile: SSHProfile): Promise<SSHConfig> {
  const sshConfig: SSHConfig = {
    host: profile.host,
    port: profile.port || 22,
    username: profile.username,
  };

  if (profile.password) {
    sshConfig.password = profile.password;
  } else if (profile.keyPath) {
    sshConfig.privateKey = readFileSync(profile.keyPath, 'utf8');
  } else if (profile.privateKey) {
    sshConfig.privateKey = profile.privateKey;
  }

  if (profile.suPassword) sshConfig.suPassword = profile.suPassword;
  if (profile.sudoPassword) sshConfig.sudoPassword = profile.sudoPassword;

  return sshConfig;
}

export class SSHConnectionManager {
  private conn: Client | null = null;
  private sshConfig: SSHConfig;
  private isConnecting = false;
  private connectionPromise: Promise<void> | null = null;
  private suShell: any = null;  // Store the elevated shell session
  private suPromise: Promise<void> | null = null;
  private isElevated = false;  // Track if we're in su mode

  constructor(config: SSHConfig) {
    this.sshConfig = config;
  }

  async connect(): Promise<void> {
    if (this.conn && this.isConnected()) {
      return; // Already connected
    }

    if (this.isConnecting && this.connectionPromise) {
      return this.connectionPromise; // Wait for ongoing connection
    }

    this.isConnecting = true;
    this.connectionPromise = new Promise((resolve, reject) => {
      this.conn = new Client();

      const timeoutId = setTimeout(() => {
        this.conn?.end();
        this.conn = null;
        this.isConnecting = false;
        this.connectionPromise = null;
        reject(new McpError(ErrorCode.InternalError, 'SSH connection timeout'));
      }, 30000); // 30 seconds connection timeout

      this.conn.on('ready', async () => {
        clearTimeout(timeoutId);
        this.isConnecting = false;

        // In test mode, don't wait for su elevation during connection setup, as it
        // may cause JSON-RPC server initialization to hang. Instead, elevation will
        // be triggered on-demand when a command is executed.
        // In production, elevation during connection is desirable for robustness.
        if (this.sshConfig.suPassword && !process.env.SSH_MCP_TEST) {
          try {
            await this.ensureElevated();
          } catch (err) {
            // Do not reject the connection; just log the error. Subsequent commands
            // will either use the su shell if available or fall back to normal execution.
          }
        }

        resolve();
      });

      this.conn.on('error', (err: Error) => {
        clearTimeout(timeoutId);
        this.conn = null;
        this.isConnecting = false;
        this.connectionPromise = null;
        reject(new McpError(ErrorCode.InternalError, `SSH connection error: ${err.message}`));
      });

      this.conn.on('end', () => {
        console.error('SSH connection ended');
        this.conn = null;
        this.isConnecting = false;
        this.connectionPromise = null;
      });

      this.conn.on('close', () => {
        console.error('SSH connection closed');
        this.conn = null;
        this.isConnecting = false;
        this.connectionPromise = null;
      });

      this.conn.connect(this.sshConfig);
    });

    return this.connectionPromise;
  }

  isConnected(): boolean {
    return this.conn !== null && (this.conn as any)._sock && !(this.conn as any)._sock.destroyed;
  }

  getSudoPassword(): string | undefined {
    return this.sshConfig.sudoPassword;
  }

  getSuPassword(): string | undefined {
    return this.sshConfig.suPassword;
  }

  async setSuPassword(pwd?: string): Promise<void> {
    this.sshConfig.suPassword = pwd;
    if (pwd) {
      try {
        await this.ensureElevated();
      } catch (err) {
        console.error('setSuPassword: failed to elevate to su shell:', err);
      }
    } else {
      // If clearing suPassword, drop any existing suShell
      if (this.suShell) {
        try { this.suShell.end(); } catch (e) { /* ignore */ }
        this.suShell = null;
        this.isElevated = false;
      }
    }
  }

  private async ensureElevated(): Promise<void> {
    if (this.isElevated && this.suShell) return;
    if (!this.sshConfig.suPassword) return;

    if (this.suPromise) return this.suPromise;

    this.suPromise = new Promise((resolve, reject) => {
      const conn = this.getConnection();

      // Add a safety timeout so elevation doesn't hang forever
      const timeoutId = setTimeout(() => {
        this.suPromise = null;
        reject(new McpError(ErrorCode.InternalError, 'su elevation timed out'));
      }, 10000);  // 10 second timeout for elevation

      conn.shell({ term: 'xterm', cols: 80, rows: 24 }, (err: Error | undefined, stream: ClientChannel) => {
        if (err) {
          clearTimeout(timeoutId);
          this.suPromise = null;
          reject(new McpError(ErrorCode.InternalError, `Failed to start interactive shell for su: ${err.message}`));
          return;
        }

        let buffer = '';
        let passwordSent = false;
        const cleanup = () => {
          try { stream.removeAllListeners('data'); } catch (e) { /* ignore */ }
        };

        const onData = (data: Buffer) => {
          const text = data.toString();
          buffer += text;

          // If we haven't sent the password yet, look for the password prompt
          if (!passwordSent && /password[: ]/i.test(buffer)) {
            passwordSent = true;
            stream.write(this.sshConfig.suPassword + '\n');
            // Don't return; keep looking for root prompt
          }

          // After password is sent, look for any root indicator
          // Look for '#' which indicates root prompt (may be followed by spaces, escape codes, etc)
          if (passwordSent) {
            if (/#/.test(buffer)) {
              clearTimeout(timeoutId);
              cleanup();
              this.suShell = stream;
              this.isElevated = true;
              this.suPromise = null;
              resolve();
              return;
            }
          }

          // Detect authentication failure messages
          if (/authentication failure|incorrect password|su: .*failed|su: failure/i.test(buffer)) {
            clearTimeout(timeoutId);
            cleanup();
            this.suPromise = null;
            reject(new McpError(ErrorCode.InternalError, `su authentication failed: ${buffer}`));
            return;
          }
        };

        stream.on('data', onData);

        stream.on('close', () => {
          clearTimeout(timeoutId);
          if (!this.isElevated) {
            this.suPromise = null;
            reject(new McpError(ErrorCode.InternalError, 'su shell closed before elevation completed'));
          }
        });

        // Kick off the su command
        stream.write('su -\n');
      });
    });

    return this.suPromise;
  }

  getSftp(): Promise<SFTPWrapper> {
    const conn = this.getConnection();
    return new Promise((resolve, reject) => {
      conn.sftp((err: Error | undefined, sftp: SFTPWrapper) => {
        if (err) {
          reject(new McpError(ErrorCode.InternalError, `SFTP session error: ${err.message}`));
          return;
        }
        resolve(sftp);
      });
    });
  }

  async ensureConnected(): Promise<void> {
    if (!this.isConnected()) {
      await this.connect();
    }
  }

  getConnection(): Client {
    if (!this.conn) {
      throw new McpError(ErrorCode.InternalError, 'SSH connection not established');
    }
    return this.conn;
  }

  close(): void {
    if (this.conn) {
      if (this.suShell) {
        try { this.suShell.end(); } catch (e) { /* ignore */ }
        this.suShell = null;
        this.isElevated = false;
      }
      this.conn.end();
      this.conn = null;
    }
  }
}

const connectionManagers = new Map<string, SSHConnectionManager>();

async function getConnectionManager(profileName?: string): Promise<SSHConnectionManager> {
  const resolvedName = resolveProfileName(profileName);
  const existing = connectionManagers.get(resolvedName);
  if (existing) return existing;

  const profile = profiles.get(resolvedName);
  if (!profile) {
    throw new McpError(ErrorCode.InvalidParams, `Unknown profile "${resolvedName}"`);
  }

  const manager = new SSHConnectionManager(await buildSshConfig(profile));
  connectionManagers.set(resolvedName, manager);
  return manager;
}

const server = new McpServer({
  name: 'SSH MCP Server',
  version: '1.5.0',
});

server.registerTool(
  "list-profiles",
  {
    description: "List configured SSH profiles that can be used with exec or sudo-exec.",
    inputSchema: {},
  },
  async () => ({
    content: [{
      type: 'text',
      text: Array.from(profiles.values())
        .map((profile) => `${profile.name}\t${profile.username}@${profile.host}:${profile.port || 22}`)
        .join('\n') + (profiles.size ? '\n' : ''),
    }],
  })
);

server.registerTool(
  "exec",
  {
    description: "Execute a shell command on a configured SSH profile and return the output.",
    inputSchema: {
      command: z.string().describe("Shell command to execute on the remote SSH server"),
      profile: z.string().optional().describe("SSH profile name. Required when multiple profiles are configured"),
      description: z.string().optional().describe("Optional description of what this command will do"),
    },
  },
  async ({ command, profile, description }) => {
    const sanitizedCommand = sanitizeCommand(command);

    try {
      const manager = await getConnectionManager(profile);
      await manager.ensureConnected();

      if ((manager as any).getSuPassword && (manager as any).getSuPassword()) {
        try {
          const elevationPromise = (manager as any).ensureElevated();
          await Promise.race([
            elevationPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Elevation timeout')), 5000))
          ]);
        } catch (err) {
          // Fall back to non-elevated execution if elevation times out.
        }
      }

      const commandWithDescription = description
        ? `${sanitizedCommand} # ${description.replace(/#/g, '\\#')}`
        : sanitizedCommand;

      return await execSshCommandWithConnection(manager, commandWithDescription);
    } catch (err: any) {
      if (err instanceof McpError) throw err;
      throw new McpError(ErrorCode.InternalError, `Unexpected error: ${err?.message || err}`);
    }
  }
);

// Expose sudo-exec tool unless explicitly disabled
if (!DISABLE_SUDO) {
  server.registerTool(
    "sudo-exec",
    {
      description: "Execute a shell command on a configured SSH profile using sudo. Will use sudo password if provided, otherwise assumes passwordless sudo.",
      inputSchema: {
        command: z.string().describe("Shell command to execute with sudo on the remote SSH server"),
        profile: z.string().optional().describe("SSH profile name. Required when multiple profiles are configured"),
        description: z.string().optional().describe("Optional description of what this command will do"),
      },
    },
    async ({ command, profile, description }) => {
      const sanitizedCommand = sanitizeCommand(command);

      try {
        const manager = await getConnectionManager(profile);
        await manager.ensureConnected();

        let wrapped: string;
        const sudoPassword = manager.getSudoPassword();

        const commandWithDescription = description
          ? `${sanitizedCommand} # ${description.replace(/#/g, '\\#')}`
          : sanitizedCommand;

        if (!sudoPassword) {
          wrapped = `sudo -n sh -c '${commandWithDescription.replace(/'/g, "'\\''")}'`;
        } else {
          const pwdEscaped = sudoPassword.replace(/'/g, "'\\''");
          wrapped = `printf '%s\\n' '${pwdEscaped}' | sudo -p "" -S sh -c '${commandWithDescription.replace(/'/g, "'\\''")}'`;
        }

        return await execSshCommandWithConnection(manager, wrapped);
      } catch (err: any) {
        if (err instanceof McpError) throw err;
        throw new McpError(ErrorCode.InternalError, `Unexpected error: ${err?.message || err}`);
      }
    }
  );
}

export function validateRemotePath(remotePath: string): string {
  if (typeof remotePath !== 'string' || !remotePath.trim()) {
    throw new McpError(ErrorCode.InvalidParams, 'remotePath must be a non-empty string');
  }

  const trimmed = remotePath.trim();
  if (!trimmed.startsWith('/')) {
    throw new McpError(ErrorCode.InvalidParams, 'remotePath must be an absolute path (start with /)');
  }
  if (trimmed.includes('\0')) {
    throw new McpError(ErrorCode.InvalidParams, 'remotePath cannot contain null bytes');
  }

  return trimmed;
}

server.registerTool(
  "upload-file",
  {
    description: "Upload file content to a configured SSH profile via SFTP. Parent directories must already exist.",
    inputSchema: {
      remotePath: z.string().describe("Absolute path on the remote server where the file will be written"),
      content: z.string().describe("File content as raw UTF-8 text or base64-encoded binary data"),
      encoding: z.enum(["utf8", "base64"]).default("utf8").describe("Content encoding: utf8 for text files, base64 for binary files"),
      profile: z.string().optional().describe("SSH profile name. Required when multiple profiles are configured"),
    },
  },
  async ({ remotePath, content, encoding, profile }) => {
    const validatedPath = validateRemotePath(remotePath);
    const buffer = encoding === "base64"
      ? Buffer.from(content, "base64")
      : Buffer.from(content, "utf8");
    let sftp: SFTPWrapper | undefined;

    try {
      const manager = await getConnectionManager(profile);
      await manager.ensureConnected();
      sftp = await manager.getSftp();

      return await new Promise((resolve, reject) => {
        let isResolved = false;
        const timeoutId = setTimeout(() => {
          if (!isResolved) {
            isResolved = true;
            reject(new McpError(ErrorCode.InternalError, `Upload timed out after ${DEFAULT_TIMEOUT}ms`));
          }
        }, DEFAULT_TIMEOUT);

        sftp!.writeFile(validatedPath, buffer, (err?: Error | null) => {
          if (isResolved) return;
          isResolved = true;
          clearTimeout(timeoutId);

          if (err) {
            reject(new McpError(ErrorCode.InternalError, `SFTP write error: ${err.message}`));
            return;
          }

          resolve({
            content: [{
              type: 'text' as const,
              text: `Uploaded ${buffer.length} bytes to ${validatedPath}`,
            }],
          });
        });
      });
    } catch (err: any) {
      if (err instanceof McpError) throw err;
      throw new McpError(ErrorCode.InternalError, `Unexpected error: ${err?.message || err}`);
    } finally {
      if (sftp) sftp.end();
    }
  }
);

server.registerTool(
  "download-file",
  {
    description: "Download a file from a configured SSH profile via SFTP and return its content.",
    inputSchema: {
      remotePath: z.string().describe("Absolute path of the file to download from the remote server"),
      encoding: z.enum(["utf8", "base64"]).default("utf8").describe("Output encoding: utf8 for text files, base64 for binary files"),
      profile: z.string().optional().describe("SSH profile name. Required when multiple profiles are configured"),
    },
  },
  async ({ remotePath, encoding, profile }) => {
    const validatedPath = validateRemotePath(remotePath);
    let sftp: SFTPWrapper | undefined;

    try {
      const manager = await getConnectionManager(profile);
      await manager.ensureConnected();
      sftp = await manager.getSftp();

      if (Number.isFinite(MAX_FILE_SIZE)) {
        const stats = await new Promise<{ size: number }>((resolve, reject) => {
          sftp!.stat(validatedPath, (err: Error | undefined, stats: any) => {
            if (err) {
              reject(new McpError(ErrorCode.InternalError, `SFTP stat error: ${err.message}`));
              return;
            }
            resolve(stats);
          });
        });

        if (stats.size > MAX_FILE_SIZE) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `File size ${stats.size} bytes exceeds maximum allowed ${MAX_FILE_SIZE} bytes. Use --maxFileSize to increase or set to "none" to disable.`
          );
        }
      }

      return await new Promise((resolve, reject) => {
        let isResolved = false;
        const timeoutId = setTimeout(() => {
          if (!isResolved) {
            isResolved = true;
            reject(new McpError(ErrorCode.InternalError, `Download timed out after ${DEFAULT_TIMEOUT}ms`));
          }
        }, DEFAULT_TIMEOUT);

        sftp!.readFile(validatedPath, (err: Error | undefined, data: Buffer) => {
          if (isResolved) return;
          isResolved = true;
          clearTimeout(timeoutId);

          if (err) {
            reject(new McpError(ErrorCode.InternalError, `SFTP read error: ${err.message}`));
            return;
          }

          resolve({
            content: [{
              type: 'text' as const,
              text: encoding === "base64" ? data.toString("base64") : data.toString("utf8"),
            }],
          });
        });
      });
    } catch (err: any) {
      if (err instanceof McpError) throw err;
      throw new McpError(ErrorCode.InternalError, `Unexpected error: ${err?.message || err}`);
    } finally {
      if (sftp) sftp.end();
    }
  }
);

// New function that uses persistent connection
export async function execSshCommandWithConnection(manager: SSHConnectionManager, command: string, stdin?: string): Promise<{ [x: string]: unknown; content: ({ [x: string]: unknown; type: "text"; text: string; } | { [x: string]: unknown; type: "image"; data: string; mimeType: string; } | { [x: string]: unknown; type: "audio"; data: string; mimeType: string; } | { [x: string]: unknown; type: "resource"; resource: any; })[] }> {
  return new Promise((resolve, reject) => {
    let timeoutId: NodeJS.Timeout;
    let isResolved = false;

    const conn = manager.getConnection();
    const shell = (manager as any).suShell;  // Use su shell if available

    // Set up timeout
    timeoutId = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        reject(new McpError(ErrorCode.InternalError, `Command execution timed out after ${DEFAULT_TIMEOUT}ms`));
      }
    }, DEFAULT_TIMEOUT);

    // If we have an active su shell, use it directly (commands run as root in session)
    if (shell) {
      let buffer = '';

      const dataHandler = (data: Buffer) => {
        const text = data.toString();
        buffer += text;

        // Wait for root prompt (#) to know command is complete
        // Match # which indicates root prompt (may be followed by spaces, escape codes, etc)
        if (/#/.test(buffer)) {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timeoutId);

            // Extract output: remove the command echo and final prompt
            const lines = buffer.split('\n');
            // First line is often the echoed command; last line is the prompt
            let output = lines.slice(1, -1).join('\n');

            resolve({
              content: [{
                type: 'text',
                text: output + (output ? '\n' : ''),
              }],
            });
          }
          shell.removeListener('data', dataHandler);
        }
      };

      shell.on('data', dataHandler);
      // Send command immediately; shell is ready after elevation
      shell.write(command + '\n');
      return;
    }

    // No persistent su shell; use normal exec with optional password piping
    conn.exec(command, (err: Error | undefined, stream: ClientChannel) => {
      if (err) {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutId);
          reject(new McpError(ErrorCode.InternalError, `SSH exec error: ${err.message}`));
        }
        return;
      }

      let stdout = '';
      let stderr = '';

      // If stdin provided (e.g., sudo password), write it
      if (stdin && stdin.length > 0) {
        try {
          stream.write(stdin);
        } catch (e) {
          console.error('Error writing to stdin:', e);
        }
      }
      try { stream.end(); } catch (e) { /* ignore */ }

      stream.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      stream.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      stream.on('close', (code: number, signal: string) => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutId);
          if (stderr) {
            reject(new McpError(ErrorCode.InternalError, `Error (code ${code}):\n${stderr}`));
          } else {
            resolve({
              content: [{
                type: 'text',
                text: stdout,
              }],
            });
          }
        }
      });
    });
  });
}

// Keep the old function for backward compatibility (used in tests)
export async function execSshCommand(sshConfig: any, command: string, stdin?: string): Promise<{ [x: string]: unknown; content: ({ [x: string]: unknown; type: "text"; text: string; } | { [x: string]: unknown; type: "image"; data: string; mimeType: string; } | { [x: string]: unknown; type: "audio"; data: string; mimeType: string; } | { [x: string]: unknown; type: "resource"; resource: any; })[] }> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let timeoutId: NodeJS.Timeout;
    let isResolved = false;

    // Set up timeout
    timeoutId = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        // Try to abort the running command before closing connection
        const abortTimeout = setTimeout(() => {
          // If abort command itself times out, force close connection
          conn.end();
        }, 5000); // 5 second timeout for abort command

        conn.exec('timeout 3s pkill -f \'' + escapeCommandForShell(command) + '\' 2>/dev/null || true', (err: Error | undefined, abortStream: ClientChannel | undefined) => {
          if (abortStream) {
            abortStream.on('close', () => {
              clearTimeout(abortTimeout);
              conn.end();
            });
          } else {
            clearTimeout(abortTimeout);
            conn.end();
          }
        });
        reject(new McpError(ErrorCode.InternalError, `Command execution timed out after ${DEFAULT_TIMEOUT}ms`));
      }
    }, DEFAULT_TIMEOUT);

    conn.on('ready', () => {
      conn.exec(command, (err: Error | undefined, stream: ClientChannel) => {
        if (err) {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timeoutId);
            reject(new McpError(ErrorCode.InternalError, `SSH exec error: ${err.message}`));
          }
          conn.end();
          return;
        }
        // If stdin provided, write it to the stream and end stdin
        if (stdin && stdin.length > 0) {
          try {
            stream.write(stdin);
          } catch (e) {
            // ignore
          }
        }
        try { stream.end(); } catch (e) { /* ignore */ }
        let stdout = '';
        let stderr = '';
        stream.on('close', (code: number, signal: string) => {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timeoutId);
            conn.end();
            if (stderr) {
              reject(new McpError(ErrorCode.InternalError, `Error (code ${code}):\n${stderr}`));
            } else {
              resolve({
                content: [{
                  type: 'text',
                  text: stdout,
                }],
              });
            }
          }
        });
        stream.on('data', (data: Buffer) => {
          stdout += data.toString();
        });
        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
      });
    });
    conn.on('error', (err: Error) => {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timeoutId);
        reject(new McpError(ErrorCode.InternalError, `SSH connection error: ${err.message}`));
      }
    });
    conn.connect(sshConfig);
  });
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("SSH MCP Server running on stdio");

  // Handle graceful shutdown
  const cleanup = () => {
    console.error("Shutting down SSH MCP Server...");
    for (const manager of connectionManagers.values()) {
      manager.close();
    }
    connectionManagers.clear();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', () => {
    for (const manager of connectionManagers.values()) {
      manager.close();
    }
  });
}

// Initialize server in test mode for automated tests
if (isTestMode) {
  const transport = new StdioServerTransport();
  server.connect(transport).catch(error => {
    console.error("Fatal error connecting server:", error);
    process.exit(1);
  });
}
// Start server in CLI mode
else if (isCliEnabled) {
  main().catch((error) => {
    console.error("Fatal error in main():", error);
    for (const manager of connectionManagers.values()) {
      manager.close();
    }
    process.exit(1);
  });
}

export { parseArgv, validateConfig };
