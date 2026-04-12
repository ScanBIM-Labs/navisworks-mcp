# Navisworks MCP

**Navisworks coordination and clash detection via APS** — Upload NWD files, extract clashes, generate reports, retrieve viewpoints.

[![Live](https://img.shields.io/badge/status-live-brightgreen)](https://navisworks-mcp.itmartin24.workers.dev/)
[![MCP](https://img.shields.io/badge/protocol-MCP%202024--11--05-blue)](https://modelcontextprotocol.io)

## Tools (5)

| Tool | Description |
|------|-------------|
| `nwd_upload` | Upload NWD files for coordination |
| `nwd_get_clashes` | Extract clash detection results |
| `nwd_export_report` | Generate coordination reports (PDF/XLSX/HTML) |
| `nwd_get_viewpoints` | Retrieve saved viewpoints |
| `nwd_list_objects` | List model objects and properties |

## Quick Start

```json
{
  "mcpServers": {
    "navisworks": {
      "url": "https://navisworks-mcp.itmartin24.workers.dev/mcp"
    }
  }
}
```

## Architecture

- **Runtime**: Cloudflare Workers
- **Auth**: APS OAuth2 (client_credentials)

## Part of [ScanBIM Labs AEC MCP Ecosystem](https://github.com/ScanBIM-Labs)

MIT — ScanBIM Labs LLC
