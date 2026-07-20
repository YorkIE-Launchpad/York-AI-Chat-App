/**
 * Remote Control Module
 * Remote control module exports
 */

// Types
export * from './types';

// Core
export { RemoteGateway } from './gateway';
export { MessageRouter } from './message-router';
export {
  RemoteManager,
  remoteManager,
  type AgentExecutor,
  type RemoteInteraction,
} from './remote-manager';

// Channels
export { ChannelBase } from './channels/channel-base';
export { FeishuChannel, FeishuAPI } from './channels/feishu';

// Config
export { remoteConfigStore } from './remote-config-store';
