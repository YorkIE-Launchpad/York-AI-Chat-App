import { describe, expect, it } from 'vitest';
import {
  buildDefaultGtmLaunchpadMcpServer,
  isGtmLaunchpadMcpServer,
  isLaunchpadMcpServer,
} from '../../main/mcp/mcp-config-store';
import { DEFAULT_GTM_LAUNCHPAD_MCP_NAME } from '../../shared/mcp-defaults';

describe('GTM Launchpad MCP identification', () => {
  it('builds streamable-http config pointing at gtm-launchpad /api/mcp', () => {
    const built = buildDefaultGtmLaunchpadMcpServer();
    expect(built).toMatchObject({
      name: DEFAULT_GTM_LAUNCHPAD_MCP_NAME,
      type: 'streamable-http',
    });
    expect(built.url).toBe('https://gtm-launchpad.yorkdevs.link/api/mcp');
  });

  it('recognizes GTM Launchpad by name and host', () => {
    expect(
      isGtmLaunchpadMcpServer({
        name: 'GTM Launchpad',
        type: 'streamable-http',
        url: 'https://gtm-launchpad.yorkdevs.link/api/mcp',
      })
    ).toBe(true);
    expect(
      isGtmLaunchpadMcpServer({
        name: 'Custom',
        type: 'streamable-http',
        url: 'https://gtm-launchpad.yorkdevs.link/api/mcp',
      })
    ).toBe(true);
  });

  it('does not treat gtm-launchpad host as R&D Launchpad', () => {
    expect(
      isLaunchpadMcpServer({
        name: 'GTM Launchpad',
        type: 'streamable-http',
        url: 'https://gtm-launchpad.yorkdevs.link/api/mcp',
      })
    ).toBe(false);
    expect(
      isLaunchpadMcpServer({
        name: 'Other',
        type: 'streamable-http',
        url: 'https://gtm-launchpad.yorkdevs.link/api/mcp',
      })
    ).toBe(false);
  });

  it('still recognizes R&D Launchpad production host', () => {
    expect(
      isLaunchpadMcpServer({
        name: 'R&D Launchpad',
        type: 'stdio',
        args: ['-y', 'mcp-remote', 'https://launchpad.yorkdevs.link/mcp'],
      })
    ).toBe(true);
    expect(
      isGtmLaunchpadMcpServer({
        name: 'R&D Launchpad',
        type: 'stdio',
        args: ['-y', 'mcp-remote', 'https://launchpad.yorkdevs.link/mcp'],
      })
    ).toBe(false);
  });
});
