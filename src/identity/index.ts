export {
  ChannelIdentitySchema,
  NewChannelIdentitySchema,
  IDENTITY_CHANNELS,
  identityDocId,
} from './types.js';
export type {
  ChannelIdentity,
  NewChannelIdentity,
  IdentityChannel,
  ResolveRequest,
  ResolveResult,
} from './types.js';

export {
  bindIdentity,
  revokeIdentity,
  resolveIdentity,
  listIdentitiesForUid,
} from './resolver.js';
