import { describe, expect, it } from 'vitest';
import {
  normalizeRemoteMcpUrl,
  validateRemoteMcpConnection,
  validateRemoteMcpUrl,
} from '@/lib/remote-mcp';

describe('remote MCP validation', () => {
  it('accepts remote HTTPS MCP URLs', () => {
    expect(validateRemoteMcpUrl('https://mcp.example.com/mcp')).toEqual([]);
    expect(normalizeRemoteMcpUrl('https://mcp.example.com/mcp#ignored')).toBe('https://mcp.example.com/mcp');
  });

  it('rejects non-remote or non-HTTPS URLs', () => {
    expect(validateRemoteMcpUrl('http://mcp.example.com/mcp')).toContain('Remote MCP server URL must use HTTPS');
    expect(validateRemoteMcpUrl('https://localhost:3000/mcp')).toContain('Remote MCP server URL must not point to a local hostname');
    expect(validateRemoteMcpUrl('https://127.0.0.1/mcp')).toContain('Remote MCP server URL must not point to a private, loopback, or link-local IP address');
    expect(validateRemoteMcpUrl('https://[::ffff:127.0.0.1]/mcp')).toContain('Remote MCP server URL must not point to a private, loopback, or link-local IP address');
    expect(validateRemoteMcpUrl('https://10.0.0.5/mcp')).toContain('Remote MCP server URL must not point to a private, loopback, or link-local IP address');
    expect(validateRemoteMcpUrl('file:///tmp/mcp.sock')).toContain('Remote MCP server URL must use HTTPS');
  });

  it('requires token metadata only when auth needs it', () => {
    expect(validateRemoteMcpConnection({
      server_url: 'https://mcp.example.com/mcp',
      auth_type: 'none',
    })).toEqual([]);

    expect(validateRemoteMcpConnection({
      server_url: 'https://mcp.example.com/mcp',
      auth_type: 'bearer',
    })).toContain('Token is required');

    expect(validateRemoteMcpConnection({
      server_url: 'https://mcp.example.com/mcp',
      auth_type: 'custom_header',
      auth_header: 'X-API-Key',
    }, { token: 'secret' })).toEqual([]);

    expect(validateRemoteMcpConnection({
      server_url: 'https://mcp.example.com/mcp',
      auth_type: 'oauth',
    })).toEqual([]);
  });
});
