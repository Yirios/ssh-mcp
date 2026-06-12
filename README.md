# SSH MCP Server

[![NPM Version](https://img.shields.io/npm/v/ssh-mcp)](https://www.npmjs.com/package/ssh-mcp)
[![Downloads](https://img.shields.io/npm/dm/ssh-mcp)](https://www.npmjs.com/package/ssh-mcp)
[![Node Version](https://img.shields.io/node/v/ssh-mcp)](https://nodejs.org/)
[![License](https://img.shields.io/github/license/tufantunc/ssh-mcp)](./LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/tufantunc/ssh-mcp?style=social)](https://github.com/tufantunc/ssh-mcp/stargazers)
[![GitHub Forks](https://img.shields.io/github/forks/tufantunc/ssh-mcp?style=social)](https://github.com/tufantunc/ssh-mcp/forks)
[![Build Status](https://github.com/tufantunc/ssh-mcp/actions/workflows/publish.yml/badge.svg)](https://github.com/tufantunc/ssh-mcp/actions)
[![GitHub issues](https://img.shields.io/github/issues/tufantunc/ssh-mcp)](https://github.com/tufantunc/ssh-mcp/issues)

[![Trust Score](https://archestra.ai/mcp-catalog/api/badge/quality/tufantunc/ssh-mcp)](https://archestra.ai/mcp-catalog/tufantunc__ssh-mcp)

**SSH MCP Server** is a local Model Context Protocol (MCP) server that exposes SSH control for Linux and Windows systems, enabling LLMs and other MCP clients to execute shell commands securely via SSH.

## Contents

- [SSH MCP Server](#ssh-mcp-server)
  - [Contents](#contents)
  - [Quick Start](#quick-start)
  - [Features](#features)
    - [Tools](#tools)
  - [Installation](#installation)
  - [Client Setup](#client-setup)
    - [Claude Code](#claude-code)
  - [Testing](#testing)
  - [Disclaimer](#disclaimer)
  - [Contributing](#contributing)
  - [Code of Conduct](#code-of-conduct)
  - [Support](#support)

## Quick Start

- [Install](#installation) SSH MCP Server
- [Configure](#configuration) SSH MCP Server
- [Set up](#client-setup) your MCP Client (e.g. Claude Desktop, Cursor, etc)
- Execute remote shell commands on your Linux or Windows server via natural language

## Features

- MCP-compliant server exposing SSH capabilities
- Execute shell commands on remote Linux and Windows systems
- Upload and download files over SFTP
- Secure authentication via password or SSH key
- Built with TypeScript and the official MCP SDK
- **Configurable timeout protection** with automatic process abortion
- **Graceful timeout handling** - attempts to kill hanging processes before closing connections

### Tools

- `exec`: Execute a shell command on the remote server
  - **Parameters:**
    - `command` (required): Shell command to execute on the remote SSH server
    - `profile` (optional): SSH profile name. Required when multiple profiles are configured
    - `description` (optional): Optional description of what this command will do (appended as a comment)
  - **Timeout Configuration:**

- `sudo-exec`: Execute a shell command with sudo elevation
  - **Parameters:**
    - `command` (required): Shell command to execute as root using sudo
    - `profile` (optional): SSH profile name. Required when multiple profiles are configured
    - `description` (optional): Optional description of what this command will do (appended as a comment)
  - **Notes:**
    - Requires `--sudoPassword` to be set for password-protected sudo
    - Can be disabled by passing the `--disableSudo` flag at startup if sudo access is not needed or not available
    - For persistent root access, consider using `--suPassword` instead which establishes a root shell
    - Tool will not be available at all if server is started with `--disableSudo`

- `upload-file`: Upload file content to the remote server via SFTP
  - **Parameters:**
    - `remotePath` (required): Absolute destination path on the remote server
    - `content` (required): Raw UTF-8 text or base64-encoded binary content
    - `encoding` (optional): `utf8` (default) or `base64`
    - `profile` (optional): SSH profile name. Required when multiple profiles are configured
  - **Notes:**
    - Parent directories must already exist
    - Existing files are overwritten

- `download-file`: Download a file from the remote server via SFTP
  - **Parameters:**
    - `remotePath` (required): Absolute source path on the remote server
    - `encoding` (optional): `utf8` (default) or `base64`
    - `profile` (optional): SSH profile name. Required when multiple profiles are configured
  - **Notes:**
    - File size is limited by `--maxFileSize` (default: 10485760 bytes)
    - Use `--maxFileSize=none` or `--maxFileSize=0` to disable the limit

- **Timeout Configuration:**
  - Timeout is configured via command line argument `--timeout` (in milliseconds)
  - Default timeout: 60000ms (1 minute)
  - When a command times out, the server automatically attempts to abort the running process before closing the connection

- **Max Command Length Configuration:**
  - Max command characters are configured via `--maxChars`
  - Default: `1000`
  - No-limit mode: set `--maxChars=none` or any `<= 0` value (e.g. `--maxChars=0`)

## Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/tufantunc/ssh-mcp.git
   cd ssh-mcp
   ```
2. **Install dependencies:**
   ```bash
   npm install
   ```

## Client Setup

You can configure your IDE or LLM like Cursor, Windsurf, Claude Desktop to use this MCP Server.

**Required Parameters:**
- `host`: Hostname or IP of the Linux or Windows server
- `user`: SSH username

**Optional Parameters:**
- `port`: SSH port (default: 22)
- `password`: SSH password (or use `key` for key-based auth)
- `key`: Path to private SSH key
- `sudoPassword`: Password for sudo elevation (when executing commands with sudo)
- `suPassword`: Password for su elevation (when you need a persistent root shell)
- `timeout`: Command execution timeout in milliseconds (default: 60000ms = 1 minute)
- `maxChars`: Maximum allowed characters for the `command` input (default: 1000). Use `none` or `0` to disable the limit.
- `maxFileSize`: Maximum allowed `download-file` size in bytes (default: 10485760). Use `none` or `0` to disable the limit.
- `disableSudo`: Flag to disable the `sudo-exec` tool completely. Useful when sudo access is not needed or not available.


```commandline
{
    "mcpServers": {
        "ssh-mcp": {
            "command": "npx",
            "args": [
                "ssh-mcp",
                "-y",
                "--",
                "--host=1.2.3.4",
                "--port=22",
                "--user=root",
                "--password=pass",
                "--key=path/to/key",
                "--timeout=30000",
                "--maxChars=none",
                "--maxFileSize=10485760"
            ]
        }
    }
}
```

### Claude Code

You can add this MCP server to Claude Code using the `claude mcp add` command. This is the recommended method for Claude Code.

**Basic Installation:**

```bash
claude mcp add --transport stdio ssh-mcp -- npx -y ssh-mcp -- --host=YOUR_HOST --user=YOUR_USER --password=YOUR_PASSWORD
```

**Installation Examples:**

**With Password Authentication:**
```bash
claude mcp add --transport stdio ssh-mcp -- npx -y ssh-mcp -- --host=192.168.1.100 --port=22 --user=admin --password=your_password
```

**With SSH Key Authentication:**
```bash
claude mcp add --transport stdio ssh-mcp -- npx -y ssh-mcp -- --host=example.com --user=root --key=/path/to/private/key
```

**With Custom Timeout and No Character Limit:**
```bash
claude mcp add --transport stdio ssh-mcp -- npx -y ssh-mcp -- --host=192.168.1.100 --user=admin --password=your_password --timeout=120000 --maxChars=none
```

**With Sudo and Su Support:**
```bash
claude mcp add --transport stdio ssh-mcp -- npx -y ssh-mcp -- --host=192.168.1.100 --user=admin --password=your_password --sudoPassword=sudo_pass --suPassword=root_pass
```

**With Multiple SSH Profiles:**

Create one `.env` file per target. The file name without `.env` becomes the profile name:

```bash
# /path/to/ssh-profiles/test.env
SSH_MCP_HOST=192.168.1.100
SSH_MCP_PORT=22
SSH_MCP_USER=root
SSH_MCP_PASSWORD=your_password
SSH_MCP_TIMEOUT=10000
```

Start one MCP server with the whole directory:

```bash
node build/index.js --profilesDir=/path/to/ssh-profiles --timeout=10000
```

Then pass `profile` when calling `exec` or `sudo-exec`. Use `list-profiles` to see available profile names.

**Installation Scopes:**

You can specify the scope when adding the server:

- **Local scope** (default): For personal use in the current project
  ```bash
  claude mcp add --transport stdio ssh-mcp --scope local -- npx -y ssh-mcp -- --host=YOUR_HOST --user=YOUR_USER --password=YOUR_PASSWORD
  ```

- **Project scope**: Share with your team via `.mcp.json` file
  ```bash
  claude mcp add --transport stdio ssh-mcp --scope project -- npx -y ssh-mcp -- --host=YOUR_HOST --user=YOUR_USER --password=YOUR_PASSWORD
  ```

- **User scope**: Available across all your projects
  ```bash
  claude mcp add --transport stdio ssh-mcp --scope user -- npx -y ssh-mcp -- --host=YOUR_HOST --user=YOUR_USER --password=YOUR_PASSWORD
  ```


**Verify Installation:**

After adding the server, restart Claude Code and ask Cascade to execute a command:
```
"Can you run 'ls -la' on the remote server?"
```

For more information about MCP in Claude Code, see the [official documentation](https://docs.claude.com/en/docs/claude-code/mcp).

## Testing

You can use the [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) for visual debugging of this MCP Server.

```sh
npm run inspect
```

## Disclaimer

SSH MCP Server is provided under the [MIT License](./LICENSE). Use at your own risk. This project is not affiliated with or endorsed by any SSH or MCP provider.

## Contributing

We welcome contributions! Please see our [Contributing Guidelines](./CONTRIBUTING.md) for more information.

## Code of Conduct

This project follows a [Code of Conduct](./CODE_OF_CONDUCT.md) to ensure a welcoming environment for everyone.

## Support

If you find SSH MCP Server helpful, consider starring the repository or contributing! Pull requests and feedback are welcome.
