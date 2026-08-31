import { randomUUID } from 'node:crypto';
import { RedisClient, type RedisClientType } from '@redis/client';
import { ExpirableRedisAdapter, RedisAdapter, toDb, toNormal } from '@slipher/redis-adapter';
import type {
	CoordinatedMutationRequest,
	CoordinatedMutationResult,
	CoordinatedReadRequest,
	CoordinatedStorage,
	CoordinatorBindInput,
	CoordinatorBinding,
	ReconciliationCoordinator,
} from '../coordinator';
import type { DeleteClaim, RemoveAttempt, ShardGeneration, WriteAttempt } from '../reconciliation-state';

const VALUE_WRITE_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
if ARGV[2] ~= '' then
  if redis.call('HGET', KEYS[2], 'owner') ~= ARGV[1] then return -1 end
  if redis.call('HGET', KEYS[2], 'generation') ~= ARGV[2] then return -1 end
  if redis.call('HGET', KEYS[2], 'epoch') ~= ARGV[3] then return -1 end
end
local stateKey = ARGV[4]
local epoch = tonumber(ARGV[3])
local fence = tonumber(ARGV[7])
local encoded = redis.call('HGET', KEYS[3], stateKey)
local current = encoded and cjson.decode(encoded) or nil
if ARGV[5] == 'shard' and current and current.he and (current.he > epoch or (current.he == epoch and current.hf > fence)) then
  return 0
end
if ARGV[8] == 'set' then redis.call('DEL', KEYS[5]) end
if #ARGV >= 10 then redis.call('HSET', KEYS[5], unpack(ARGV, 10)) end
local highEpoch = epoch
local highFence = fence
if current and current.he and (current.he > highEpoch or (current.he == highEpoch and current.hf > highFence)) then
  highEpoch = current.he
  highFence = current.hf
end
local flushEpoch = tonumber(redis.call('GET', KEYS[4]) or '0')
local record = {scope=ARGV[5], shard=ARGV[6], generation=ARGV[2], he=highEpoch, hf=highFence, ve=epoch, vf=fence, visibility='visible', flush=flushEpoch, causal=ARGV[9]}
redis.call('HSET', KEYS[3], stateKey, cjson.encode(record))
return 1
`;

const VALUE_REMOVE_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
if ARGV[2] ~= '' then
  if redis.call('HGET', KEYS[2], 'owner') ~= ARGV[1] then return -1 end
  if redis.call('HGET', KEYS[2], 'generation') ~= ARGV[2] then return -1 end
  if redis.call('HGET', KEYS[2], 'epoch') ~= ARGV[3] then return -1 end
end
local stateKey = ARGV[4]
local epoch = tonumber(ARGV[3])
local fence = tonumber(ARGV[7])
local encoded = redis.call('HGET', KEYS[3], stateKey)
local current = encoded and cjson.decode(encoded) or nil
if ARGV[5] == 'shard' and current and current.he and (current.he > epoch or (current.he == epoch and current.hf > fence)) then
  return 0
end
if ARGV[8] ~= '' then
  local guardEpoch = tonumber(ARGV[9])
  local guardFence = tonumber(ARGV[10])
  local rootEncoded = redis.call('HGET', KEYS[3], ARGV[8])
  local root = rootEncoded and cjson.decode(rootEncoded) or nil
  if root and root.he and (root.he > guardEpoch or (root.he == guardEpoch and root.hf > guardFence)) then return 0 end
  if root and root.claim and root.claim ~= ARGV[11] and (not root.he or root.he > guardEpoch or (root.he == guardEpoch and root.hf >= guardFence)) then return 0 end
  local previous = root and (root.claim and root.previous or rootEncoded) or nil
  root = {scope='shard', shard=ARGV[12], generation=ARGV[13], he=guardEpoch, hf=guardFence, ve=guardEpoch, vf=guardFence, visibility='hidden', flush=tonumber(redis.call('GET', KEYS[4]) or '0'), claim=ARGV[11]}
  if previous then root.previous = previous end
  redis.call('HSET', KEYS[3], ARGV[8], cjson.encode(root))
  if ARGV[8] == stateKey then current = root end
end
redis.call('DEL', KEYS[5])
local highEpoch = epoch
local highFence = fence
if current and current.he and (current.he > highEpoch or (current.he == highEpoch and current.hf > highFence)) then
  highEpoch = current.he
  highFence = current.hf
end
local record = {scope=ARGV[5], shard=ARGV[6], generation=ARGV[2], he=highEpoch, hf=highFence, ve=epoch, vf=fence, visibility='hidden', flush=tonumber(redis.call('GET', KEYS[4]) or '0')}
if current and current.claim then
  record.claim = current.claim
  record.previous = current.previous
  if ARGV[8] == stateKey then record.finalized = '1' end
end
redis.call('HSET', KEYS[3], stateKey, cjson.encode(record))
return 1
`;

const RELATION_ADD_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
if ARGV[2] ~= '' then
  if redis.call('HGET', KEYS[2], 'owner') ~= ARGV[1] then return -1 end
  if redis.call('HGET', KEYS[2], 'generation') ~= ARGV[2] then return -1 end
  if redis.call('HGET', KEYS[2], 'epoch') ~= ARGV[3] then return -1 end
end
local epoch = tonumber(ARGV[3])
local fence = tonumber(ARGV[8])
local encoded = redis.call('HGET', KEYS[3], ARGV[4])
local current = encoded and cjson.decode(encoded) or nil
local clearEncoded = redis.call('HGET', KEYS[3], ARGV[10])
local clear = clearEncoded and cjson.decode(clearEncoded) or nil
if ARGV[6] == 'shard' then
  if current and current.he and (current.he > epoch or (current.he == epoch and current.hf > fence)) then return 0 end
  if clear and clear.he and (clear.he > epoch or (clear.he == epoch and clear.hf > fence)) then return 0 end
else
  redis.call('HDEL', KEYS[3], ARGV[10])
end
redis.call('SADD', KEYS[5], ARGV[5])
local flushEpoch = tonumber(redis.call('GET', KEYS[4]) or '0')
local highEpoch = epoch
local highFence = fence
if current and current.he and (current.he > highEpoch or (current.he == highEpoch and current.hf > highFence)) then
  highEpoch = current.he
  highFence = current.hf
end
local relation = {scope=ARGV[6], shard=ARGV[7], generation=ARGV[2], he=highEpoch, hf=highFence, ve=epoch, vf=fence, visibility='visible', flush=flushEpoch, causal=ARGV[11]}
redis.call('HSET', KEYS[3], ARGV[4], cjson.encode(relation))
if ARGV[9] ~= '' then
  local entityEncoded = redis.call('HGET', KEYS[3], ARGV[9])
  local entity = entityEncoded and cjson.decode(entityEncoded) or {}
  if not entity.he or entity.he < epoch or (entity.he == epoch and entity.hf < fence) then
    entity.he = epoch
    entity.hf = fence
    redis.call('HSET', KEYS[3], ARGV[9], cjson.encode(entity))
  end
end
return 1
`;

const RELATION_REMOVE_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
if ARGV[2] ~= '' then
  if redis.call('HGET', KEYS[2], 'owner') ~= ARGV[1] then return -1 end
  if redis.call('HGET', KEYS[2], 'generation') ~= ARGV[2] then return -1 end
  if redis.call('HGET', KEYS[2], 'epoch') ~= ARGV[3] then return -1 end
end
local epoch = tonumber(ARGV[3])
local fence = tonumber(ARGV[8])
local encoded = redis.call('HGET', KEYS[3], ARGV[4])
local current = encoded and cjson.decode(encoded) or nil
if ARGV[6] == 'shard' and current and current.he and (current.he > epoch or (current.he == epoch and current.hf > fence)) then
  return 0
end
if ARGV[9] ~= '' then
  local guardEpoch = tonumber(ARGV[10])
  local guardFence = tonumber(ARGV[11])
  local rootEncoded = redis.call('HGET', KEYS[3], ARGV[9])
  local root = rootEncoded and cjson.decode(rootEncoded) or nil
  if root and root.he and (root.he > guardEpoch or (root.he == guardEpoch and root.hf > guardFence)) then return 0 end
  if root and root.claim and root.claim ~= ARGV[12] and (not root.he or root.he > guardEpoch or (root.he == guardEpoch and root.hf >= guardFence)) then return 0 end
  local previous = root and (root.claim and root.previous or rootEncoded) or nil
  root = {scope='shard', shard=ARGV[13], generation=ARGV[14], he=guardEpoch, hf=guardFence, ve=guardEpoch, vf=guardFence, visibility='hidden', flush=tonumber(redis.call('GET', KEYS[4]) or '0'), claim=ARGV[12]}
  if previous then root.previous = previous end
  redis.call('HSET', KEYS[3], ARGV[9], cjson.encode(root))
end
redis.call('SREM', KEYS[5], ARGV[5])
local highEpoch = epoch
local highFence = fence
if current and current.he and (current.he > highEpoch or (current.he == highEpoch and current.hf > highFence)) then
  highEpoch = current.he
  highFence = current.hf
end
local record = {scope=ARGV[6], shard=ARGV[7], generation=ARGV[2], he=highEpoch, hf=highFence, ve=epoch, vf=fence, visibility='hidden', flush=tonumber(redis.call('GET', KEYS[4]) or '0')}
redis.call('HSET', KEYS[3], ARGV[4], cjson.encode(record))
return 1
`;

const RELATION_CLEAR_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
if ARGV[2] ~= '' then
  if redis.call('HGET', KEYS[2], 'owner') ~= ARGV[1] then return -1 end
  if redis.call('HGET', KEYS[2], 'generation') ~= ARGV[2] then return -1 end
  if redis.call('HGET', KEYS[2], 'epoch') ~= ARGV[3] then return -1 end
end
local epoch = tonumber(ARGV[3])
local fence = tonumber(ARGV[7])
local encoded = redis.call('HGET', KEYS[3], ARGV[4])
local current = encoded and cjson.decode(encoded) or nil
if ARGV[5] == 'shard' and current and current.he and (current.he > epoch or (current.he == epoch and current.hf > fence)) then
  return 0
end
if ARGV[8] ~= '' then
  local guardEpoch = tonumber(ARGV[9])
  local guardFence = tonumber(ARGV[10])
  local rootEncoded = redis.call('HGET', KEYS[3], ARGV[8])
  local root = rootEncoded and cjson.decode(rootEncoded) or nil
  if root and root.he and (root.he > guardEpoch or (root.he == guardEpoch and root.hf > guardFence)) then return 0 end
  if root and root.claim and root.claim ~= ARGV[11] and (not root.he or root.he > guardEpoch or (root.he == guardEpoch and root.hf >= guardFence)) then return 0 end
  local previous = root and (root.claim and root.previous or rootEncoded) or nil
  root = {scope='shard', shard=ARGV[12], generation=ARGV[13], he=guardEpoch, hf=guardFence, ve=guardEpoch, vf=guardFence, visibility='hidden', flush=tonumber(redis.call('GET', KEYS[4]) or '0'), claim=ARGV[11]}
  if previous then root.previous = previous end
  redis.call('HSET', KEYS[3], ARGV[8], cjson.encode(root))
end
redis.call('DEL', KEYS[5])
local highEpoch = epoch
local highFence = fence
if current and current.he and (current.he > highEpoch or (current.he == highEpoch and current.hf > highFence)) then
  highEpoch = current.he
  highFence = current.hf
end
local record = {scope=ARGV[5], shard=ARGV[6], generation=ARGV[2], he=highEpoch, hf=highFence, ve=epoch, vf=fence, visibility='hidden', flush=tonumber(redis.call('GET', KEYS[4]) or '0')}
redis.call('HSET', KEYS[3], ARGV[4], cjson.encode(record))
return 1
`;

const CLAIM_DELETE_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
if redis.call('HGET', KEYS[2], 'owner') ~= ARGV[1] then return -1 end
if redis.call('HGET', KEYS[2], 'generation') ~= ARGV[2] then return -1 end
if redis.call('HGET', KEYS[2], 'epoch') ~= ARGV[3] then return -1 end
local encoded = redis.call('HGET', KEYS[3], ARGV[4])
local current = encoded and cjson.decode(encoded) or nil
local epoch = tonumber(ARGV[3])
local fence = tonumber(ARGV[6])
if current and current.he and (current.he > epoch or (current.he == epoch and current.hf > fence)) then return 0 end
if current and current.claim and current.claim ~= ARGV[7] and (not current.he or current.he > epoch or (current.he == epoch and current.hf >= fence)) then return 0 end
local previous = current and (current.claim and current.previous or encoded) or nil
local record = {scope='shard', shard=ARGV[5], generation=ARGV[2], he=epoch, hf=fence, ve=epoch, vf=fence, visibility='hidden', flush=tonumber(redis.call('GET', KEYS[4]) or '0'), claim=ARGV[7], finalized='1'}
if previous then record.previous = previous end
redis.call('HSET', KEYS[3], ARGV[4], cjson.encode(record))
redis.call('DEL', KEYS[5])
if ARGV[8] ~= '' then
  local relationEncoded = redis.call('HGET', KEYS[3], ARGV[9])
  local relation = relationEncoded and cjson.decode(relationEncoded) or nil
  if not relation or not relation.he or relation.he < epoch or (relation.he == epoch and relation.hf <= fence) then
    redis.call('SREM', KEYS[6], ARGV[8])
    local relationRecord = {scope='shard', shard=ARGV[5], generation=ARGV[2], he=epoch, hf=fence, ve=epoch, vf=fence, visibility='hidden', flush=tonumber(redis.call('GET', KEYS[4]) or '0')}
    redis.call('HSET', KEYS[3], ARGV[9], cjson.encode(relationRecord))
  end
end
return 1
`;

const READ_VALUE_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return {-1} end
if ARGV[2] ~= '' then
  if redis.call('HGET', KEYS[2], 'owner') ~= ARGV[1] then return {-1} end
  if redis.call('HGET', KEYS[2], 'generation') ~= ARGV[2] then return {-1} end
  if redis.call('HGET', KEYS[2], 'epoch') ~= ARGV[3] then return {-1} end
end
local flushEpoch = tonumber(redis.call('GET', KEYS[4]) or '0')
if ARGV[8] ~= '' then
  local guardEpoch = tonumber(ARGV[9])
  local guardFence = tonumber(ARGV[10])
  local rootEncoded = redis.call('HGET', KEYS[3], ARGV[8])
  local root = rootEncoded and cjson.decode(rootEncoded) or nil
  if root and root.he and (root.he > guardEpoch or (root.he == guardEpoch and root.hf > guardFence)) then return {} end
  if root and root.claim and root.claim ~= ARGV[11] and (not root.he or root.he > guardEpoch or (root.he == guardEpoch and root.hf >= guardFence)) then return {} end
  local previous = root and (root.claim and root.previous or rootEncoded) or nil
  root = {scope='shard', shard=ARGV[12], generation=ARGV[13], he=guardEpoch, hf=guardFence, ve=guardEpoch, vf=guardFence, visibility='hidden', flush=flushEpoch, claim=ARGV[11]}
  if previous then root.previous = previous end
  redis.call('HSET', KEYS[3], ARGV[8], cjson.encode(root))
end
local encoded = redis.call('HGET', KEYS[3], ARGV[4])
local record = encoded and cjson.decode(encoded) or nil
if not record then
  if flushEpoch > 0 or (ARGV[5] == '1' and (ARGV[6] ~= '1' or ARGV[2] == '')) then return {} end
elseif not record.flush then
  if flushEpoch > 0 or ARGV[6] ~= '1' or (ARGV[5] == '1' and ARGV[2] == '') then return {} end
elseif record.flush < flushEpoch then
  return {}
else
  if record.scope == 'shard' then
    local allowed = cjson.decode(ARGV[14])
    local localLease = allowed[tostring(record.shard)]
    if not localLease then return {} end
    local leaseKey = ARGV[7] .. ':lease:' .. record.shard
    local generationKey = ARGV[7] .. ':generation:' .. record.shard
    if redis.call('HGET', leaseKey, 'generation') ~= localLease.generation then return {} end
    if tonumber(redis.call('HGET', leaseKey, 'epoch') or '-1') ~= tonumber(localLease.epoch) then return {} end
    if redis.call('HGET', generationKey, 'generation') ~= localLease.generation then return {} end
    if ARGV[6] ~= '1' and (record.generation ~= localLease.generation or redis.call('HGET', generationKey, 'committed') ~= '1') then return {} end
  end
  if ARGV[6] ~= '1' and record.visibility ~= 'visible' then return {} end
end
return redis.call('HGETALL', KEYS[5])
`;

const READ_RELATION_IDS_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return {-1} end
if ARGV[2] ~= '' then
  if redis.call('HGET', KEYS[2], 'owner') ~= ARGV[1] then return {-1} end
  if redis.call('HGET', KEYS[2], 'generation') ~= ARGV[2] then return {-1} end
  if redis.call('HGET', KEYS[2], 'epoch') ~= ARGV[3] then return {-1} end
end
local flushEpoch = tonumber(redis.call('GET', KEYS[4]) or '0')
if ARGV[7] ~= '' then
  local guardEpoch = tonumber(ARGV[8])
  local guardFence = tonumber(ARGV[9])
  local rootEncoded = redis.call('HGET', KEYS[3], ARGV[7])
  local root = rootEncoded and cjson.decode(rootEncoded) or nil
  if root and root.he and (root.he > guardEpoch or (root.he == guardEpoch and root.hf > guardFence)) then return {} end
  if root and root.claim and root.claim ~= ARGV[10] and (not root.he or root.he > guardEpoch or (root.he == guardEpoch and root.hf >= guardFence)) then return {} end
  local previous = root and (root.claim and root.previous or rootEncoded) or nil
  root = {scope='shard', shard=ARGV[11], generation=ARGV[12], he=guardEpoch, hf=guardFence, ve=guardEpoch, vf=guardFence, visibility='hidden', flush=flushEpoch, claim=ARGV[10]}
  if previous then root.previous = previous end
  redis.call('HSET', KEYS[3], ARGV[7], cjson.encode(root))
end
local ids = cjson.decode(ARGV[17])
local result = {}
local clearEncoded = redis.call('HGET', KEYS[3], ARGV[13])
local clear = clearEncoded and cjson.decode(clearEncoded) or nil
local allowed = cjson.decode(ARGV[16])
local function generationVisible(record, unfiltered)
  if record.scope ~= 'shard' then return true end
  local localLease = allowed[tostring(record.shard)]
  if not localLease then return false end
  local generationKey = ARGV[6] .. ':generation:' .. record.shard
  local leaseKey = ARGV[6] .. ':lease:' .. record.shard
  local owned = redis.call('HGET', generationKey, 'generation') == localLease.generation and redis.call('HGET', leaseKey, 'generation') == localLease.generation and tonumber(redis.call('HGET', leaseKey, 'epoch') or '-1') == tonumber(localLease.epoch)
  if not owned or unfiltered then return owned end
  return record.generation == localLease.generation and redis.call('HGET', generationKey, 'committed') == '1'
end
for _, id in ipairs(ids) do
  if redis.call('SISMEMBER', KEYS[5], id) == 1 then
    local relationKey = cjson.encode({'relationship', ARGV[14], id})
    local relationEncoded = redis.call('HGET', KEYS[3], relationKey)
    local relation = relationEncoded and cjson.decode(relationEncoded) or nil
    local visible = false
    if ARGV[5] == '1' then
      visible = (relation and ((relation.flush and relation.flush >= flushEpoch) or (not relation.flush and flushEpoch == 0)) and generationVisible(relation, true)) or (not relation and flushEpoch == 0 and (ARGV[4] ~= '1' or ARGV[2] ~= ''))
    elseif ARGV[4] ~= '1' then
      visible = (relation and relation.visibility == 'visible' and (relation.flush or -1) >= flushEpoch and generationVisible(relation, false)) or (not relation and flushEpoch == 0)
    elseif relation and relation.visibility == 'visible' and (relation.flush or -1) >= flushEpoch and generationVisible(relation, false) then
      local entityKey = cjson.encode({'value', ARGV[15] .. id})
      local entityEncoded = redis.call('HGET', KEYS[3], entityKey)
      local entity = entityEncoded and cjson.decode(entityEncoded) or nil
      local afterClear = not clear or relation.ve > clear.ve or (relation.ve == clear.ve and relation.vf > clear.vf)
      local entityFresh = entity and entity.ve and entity.vf and (relation.causal ~= '1' or entity.ve > relation.ve or (entity.ve == relation.ve and entity.vf >= relation.vf))
      visible = entity and entity.visibility == 'visible' and (entity.flush or -1) >= flushEpoch and generationVisible(entity, false) and afterClear and entityFresh
    end
    if visible then table.insert(result, id) end
  end
end
return result
`;

const BEGIN_FLUSH_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
if not redis.call('SET', KEYS[2], ARGV[2], 'NX', 'PX', ARGV[3]) then return -2 end
local epoch = redis.call('INCR', KEYS[3])
redis.call('HSET', KEYS[4], 'token', ARGV[2], 'epoch', epoch)
return epoch
`;

const CLEAN_FLUSH_VALUE_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
if redis.call('GET', KEYS[2]) ~= ARGV[2] then return -1 end
redis.call('PEXPIRE', KEYS[2], ARGV[3])
local encoded = redis.call('HGET', KEYS[3], ARGV[4])
if encoded then
  local record = cjson.decode(encoded)
  if (record.flush or -1) >= tonumber(ARGV[5]) then return 0 end
end
return redis.call('DEL', KEYS[4])
`;

const CLEAN_FLUSH_RELATION_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
if redis.call('GET', KEYS[2]) ~= ARGV[2] then return -1 end
redis.call('PEXPIRE', KEYS[2], ARGV[3])
local encoded = redis.call('HGET', KEYS[3], ARGV[4])
if encoded then
  local record = cjson.decode(encoded)
  if (record.flush or -1) >= tonumber(ARGV[6]) then return 0 end
end
redis.call('SREM', KEYS[4], ARGV[5])
if redis.call('SCARD', KEYS[4]) == 0 then redis.call('DEL', KEYS[4]) end
return 1
`;

const REFRESH_FLUSH_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
if redis.call('GET', KEYS[2]) ~= ARGV[2] then return -1 end
redis.call('PEXPIRE', KEYS[2], ARGV[3])
return 1
`;

const FINISH_FLUSH_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
if redis.call('GET', KEYS[2]) ~= ARGV[2] then return -1 end
redis.call('DEL', KEYS[2])
if redis.call('HGET', KEYS[3], 'token') == ARGV[2] then redis.call('DEL', KEYS[3]) end
return 1
`;

const RELEASE_CLAIM_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
local encoded = redis.call('HGET', KEYS[2], ARGV[2])
if not encoded then return 0 end
local record = cjson.decode(encoded)
if record.claim ~= ARGV[3] then return 0 end
if record.finalized == '1' then return 0 end
if record.previous then
  redis.call('HSET', KEYS[2], ARGV[2], record.previous)
else
  redis.call('HDEL', KEYS[2], ARGV[2])
end
return 1
`;

const DEFAULT_LEASE_TTL = 15_000;
const COMPACTION_BATCH_SIZE = 100;
const DATA_BATCH_SIZE = 100;
const MAX_TIMER_DELAY = 2_147_483_647;
const REDIS_GLOB = /[*?[\\\]]/;

const START_SCRIPT = `
local configured = redis.call('GET', KEYS[1])
if configured and configured ~= ARGV[1] then return -2 end
local cacheOwner = redis.call('GET', KEYS[4])
if cacheOwner and cacheOwner ~= ARGV[4] then return -4 end
if redis.call('EXISTS', KEYS[3]) == 1 then return -3 end
local epoch = redis.call('INCR', KEYS[2])
if not configured then redis.call('SET', KEYS[1], ARGV[1]) end
if not cacheOwner then redis.call('SET', KEYS[4], ARGV[4]) end
redis.call('SET', KEYS[3], ARGV[2], 'PX', ARGV[3])
redis.call('ZADD', KEYS[5], epoch, ARGV[2])
return epoch
`;

const ACQUIRE_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
local owner = redis.call('HGET', KEYS[2], 'owner')
if owner and owner ~= ARGV[1] then return -2 end
local epoch = redis.call('INCR', KEYS[4])
redis.call('HSET', KEYS[2], 'owner', ARGV[1], 'generation', ARGV[2], 'epoch', epoch)
redis.call('PEXPIRE', KEYS[2], ARGV[4])
redis.call('HSET', KEYS[3], 'generation', ARGV[2], 'epoch', epoch, 'session', ARGV[3], 'committed', 0)
local watermark = epoch
if ARGV[5] ~= '' then watermark = math.min(watermark, tonumber(ARGV[5])) end
redis.call('ZADD', KEYS[5], watermark, ARGV[1])
return epoch
`;

const COMMIT_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if redis.call('HGET', KEYS[2], 'owner') ~= ARGV[1] then return 0 end
if redis.call('HGET', KEYS[2], 'generation') ~= ARGV[2] then return 0 end
if redis.call('HGET', KEYS[2], 'epoch') ~= ARGV[3] then return 0 end
if redis.call('HGET', KEYS[3], 'generation') ~= ARGV[2] then return 0 end
redis.call('HSET', KEYS[3], 'committed', 1)
return 1
`;

const RENEW_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
for index = 2, #KEYS do
  local offset = 3 + ((index - 2) * 2)
  if redis.call('HGET', KEYS[index], 'owner') ~= ARGV[1] then return 0 end
  if redis.call('HGET', KEYS[index], 'generation') ~= ARGV[offset] then return 0 end
  if redis.call('HGET', KEYS[index], 'epoch') ~= ARGV[offset + 1] then return 0 end
end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
for index = 2, #KEYS do redis.call('PEXPIRE', KEYS[index], ARGV[2]) end
return 1
`;

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end
redis.call('ZREM', KEYS[2], ARGV[1])
for index = 3, #KEYS do
  if redis.call('HGET', KEYS[index], 'owner') == ARGV[1] then redis.call('DEL', KEYS[index]) end
end
return 1
`;

const COMPACT_STATE_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return {-1} end
local cleaned = 0
local minimumEpoch = nil
while cleaned < tonumber(ARGV[5]) do
  local oldest = redis.call('ZRANGE', KEYS[2], 0, 0, 'WITHSCORES')
  if #oldest == 0 then return {ARGV[3], 0, cleaned} end
  if redis.call('GET', ARGV[2] .. oldest[1]) == oldest[1] then
    minimumEpoch = tonumber(oldest[2])
    break
  end
  redis.call('ZREM', KEYS[2], oldest[1])
  cleaned = cleaned + 1
end
if not minimumEpoch then return {ARGV[3], 0, cleaned} end
local scan = redis.call('HSCAN', KEYS[3], ARGV[3], 'COUNT', ARGV[4])
local entries = scan[2]
local deleted = 0
for index = 1, #entries, 2 do
  local decoded, record = pcall(cjson.decode, entries[index + 1])
  if decoded and type(record) == 'table' and record.visibility == 'hidden' and tonumber(record.he) and tonumber(record.he) <= minimumEpoch and (not record.claim or record.finalized == '1') then
    redis.call('HDEL', KEYS[3], entries[index])
    deleted = deleted + 1
  end
end
return {scan[1], deleted, cleaned}
`;

const REDIS_SCRIPTS = [
	VALUE_WRITE_SCRIPT,
	VALUE_REMOVE_SCRIPT,
	RELATION_ADD_SCRIPT,
	RELATION_REMOVE_SCRIPT,
	RELATION_CLEAR_SCRIPT,
	CLAIM_DELETE_SCRIPT,
	READ_VALUE_SCRIPT,
	READ_RELATION_IDS_SCRIPT,
	BEGIN_FLUSH_SCRIPT,
	CLEAN_FLUSH_VALUE_SCRIPT,
	CLEAN_FLUSH_RELATION_SCRIPT,
	REFRESH_FLUSH_SCRIPT,
	FINISH_FLUSH_SCRIPT,
	RELEASE_CLAIM_SCRIPT,
	START_SCRIPT,
	ACQUIRE_SCRIPT,
	COMMIT_SCRIPT,
	RENEW_SCRIPT,
	RELEASE_SCRIPT,
	COMPACT_STATE_SCRIPT,
] as const;

export interface RedisCoordinatorOptions {
	readonly cacheNamespace: string;
	readonly client: RedisClientType;
	readonly leaseTtlMs?: number;
	readonly namespace: string;
}

export interface RedisCoordinator extends ReconciliationCoordinator {
	readonly kind: 'redis';
}

interface GenerationLease {
	acquire?: Promise<void>;
	epoch?: number;
	generation: ShardGeneration;
	token: string;
}

interface OperationAuthorization {
	causal: boolean;
	epoch: number;
	fence: number;
	generationToken: string;
	leaseKey: string;
	scope: 'global' | 'shard' | 'unmanaged';
	shardId: string;
}

interface GuardAuthorization {
	claimToken: string;
	epoch: number;
	fence: number;
	generationToken: string;
	leaseKey: string;
	shardId: string;
	stateKey: string;
}

type MutationAttempt = DeleteClaim | RemoveAttempt | WriteAttempt;

class RedisSerializationError extends Error {
	constructor(readonly operationError: unknown) {
		super('Redis cache value could not be serialized.');
	}
}

function validateNamespace(name: string, value: string): void {
	if (value.length === 0 || value.endsWith(':') || REDIS_GLOB.test(value)) {
		throw new TypeError(`${name} must be non-empty and cannot end with ':' or contain Redis glob characters.`);
	}
}

function namespacesOverlap(left: string, right: string): boolean {
	return left === right || left.startsWith(`${right}:`) || right.startsWith(`${left}:`);
}

function isNoScriptError(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith('NOSCRIPT ');
}

async function mapInBatches<T, R>(
	values: readonly T[],
	operation: (value: T) => Promise<R>,
	batchSize = DATA_BATCH_SIZE,
): Promise<R[]> {
	const results: R[] = [];
	for (let offset = 0; offset < values.length; offset += batchSize) {
		const settled = await Promise.allSettled(values.slice(offset, offset + batchSize).map(operation));
		const rejected = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
		if (rejected) throw rejected.reason;
		results.push(...settled.map(result => (result as PromiseFulfilledResult<R>).value));
	}
	return results;
}

function validateLeaseTtl(value: number): void {
	if (!Number.isSafeInteger(value) || value < 300 || value > MAX_TIMER_DELAY) {
		throw new TypeError(`leaseTtlMs must be a safe integer between 300 and ${MAX_TIMER_DELAY}.`);
	}
}

class RedisReconciliationCoordinator implements RedisCoordinator, CoordinatedStorage {
	readonly kind = 'redis' as const;
	readonly #cacheNamespace: string;
	readonly #client: RedisClientType;
	readonly #incarnation = randomUUID();
	readonly #leaseTtlMs: number;
	readonly #namespace: string;
	#binding?: CoordinatorBindInput;
	#closed = false;
	#compactionCursor = '0';
	#deactivation?: Promise<void>;
	#failed = false;
	#generations = new Map<number, GenerationLease>();
	#instanceEpoch?: number;
	#nextLocalFence = 0;
	#renewal?: Promise<void>;
	#renewTimer?: ReturnType<typeof setInterval>;
	#scripts = new Map<string, Promise<string> | string>();
	#started = false;

	constructor(options: RedisCoordinatorOptions) {
		if (!options || !(options.client instanceof RedisClient)) {
			throw new TypeError('redisCoordinator() requires a standalone @redis/client RedisClient.');
		}
		validateNamespace('cacheNamespace', options.cacheNamespace);
		validateNamespace('namespace', options.namespace);
		if (namespacesOverlap(options.cacheNamespace, options.namespace)) {
			throw new TypeError('cacheNamespace and namespace must be disjoint Redis keyspaces.');
		}
		if (options.client.options.keyPrefix !== undefined) {
			throw new TypeError('redisCoordinator() does not support Redis clients configured with keyPrefix.');
		}
		this.#leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL;
		validateLeaseTtl(this.#leaseTtlMs);
		this.#cacheNamespace = options.cacheNamespace;
		this.#client = options.client;
		this.#namespace = options.namespace;
	}

	private async execute(script: string, options: { arguments: string[]; keys: string[] }): Promise<unknown> {
		let hash = await this.loadScript(script);
		try {
			return await this.#client.evalSha(hash, options);
		} catch (error) {
			if (!isNoScriptError(error)) throw error;
			hash = await this.loadScript(script, true);
			return this.#client.evalSha(hash, options);
		}
	}

	private async loadScript(script: string, reload = false): Promise<string> {
		const loaded = this.#scripts.get(script);
		if (loaded instanceof Promise || (!reload && loaded)) return loaded;
		const loading = this.#client.scriptLoad(script).then(
			hash => {
				this.#scripts.set(script, hash);
				return hash;
			},
			error => {
				if (this.#scripts.get(script) === loading) this.#scripts.delete(script);
				throw error;
			},
		);
		this.#scripts.set(script, loading);
		return loading;
	}

	private async loadScripts(): Promise<void> {
		await Promise.all(REDIS_SCRIPTS.map(script => this.loadScript(script)));
	}

	bind(input: CoordinatorBindInput): CoordinatorBinding {
		if (this.#binding) throw new Error('A Redis coordinator can only be bound once.');
		if (input.adapter instanceof ExpirableRedisAdapter) {
			throw new TypeError('redisCoordinator() does not support ExpirableRedisAdapter.');
		}
		if (Object.getPrototypeOf(input.adapter) !== RedisAdapter.prototype) {
			throw new TypeError('redisCoordinator() requires the exact @slipher/redis-adapter RedisAdapter 0.0.9 class.');
		}
		const adapter = input.adapter as RedisAdapter;
		if (adapter.client !== this.#client) {
			throw new TypeError('redisCoordinator() client must be the same client owned by RedisAdapter.');
		}
		if (adapter.namespace !== this.#cacheNamespace) {
			throw new TypeError('redisCoordinator() cacheNamespace must equal RedisAdapter.namespace.');
		}
		this.#binding = input;
		return {
			commitGeneration: generation => this.commitGeneration(generation),
			deactivate: () => this.deactivate(),
			stageReady: generation => this.stageReady(generation),
			stageResumed: generation => this.stageResumed(generation),
			storage: this,
		};
	}

	async start(): Promise<void> {
		if (!this.#binding) throw new Error('Redis coordinator must be bound before start().');
		if (this.#closed) throw new Error('Redis coordinator is closed.');
		if (this.#failed) throw new Error('Redis coordinator is not active.');
		if (this.#started) return;
		if (!this.#client.isOpen || !this.#client.isReady) {
			throw new Error('RedisAdapter client must be open and ready before redisCoordinator.start().');
		}
		await this.loadScripts();
		const reply = await this.execute(START_SCRIPT, {
			arguments: [
				JSON.stringify({ adapter: '0.0.9', cacheNamespace: this.#cacheNamespace, layout: 2 }),
				this.#incarnation,
				String(this.#leaseTtlMs),
				this.#namespace,
			],
			keys: [this.key('config'), this.key('token-epoch'), this.liveKey(), this.cacheOwnerKey(), this.liveEpochsKey()],
		});
		const epoch = this.integerReply('start', reply);
		if (epoch === -2) throw new Error('Redis coordinator namespace is configured for a different cache layout.');
		if (epoch === -4)
			throw new Error('Redis cache namespace is already paired with a different coordinator namespace.');
		if (epoch < 1) throw new Error('Redis coordinator incarnation could not acquire liveness.');
		this.#instanceEpoch = epoch;
		this.#started = true;
		this.#renewTimer = setInterval(() => this.scheduleRenewal(), Math.max(100, Math.floor(this.#leaseTtlMs / 3)));
		this.#renewTimer.unref?.();
	}

	async close(): Promise<void> {
		this.#closed = true;
		await this.deactivate();
		this.#started = false;
	}

	deactivate(): Promise<void> {
		this.#failed = true;
		if (this.#renewTimer) clearInterval(this.#renewTimer);
		this.#renewTimer = undefined;
		if (this.#deactivation) return this.#deactivation;
		const deactivation = this.releaseOwnership().finally(() => {
			if (this.#deactivation === deactivation) this.#deactivation = undefined;
		});
		this.#deactivation = deactivation;
		return deactivation;
	}

	stageReady(generation: ShardGeneration): void {
		this.#generations.set(generation.shardId, {
			generation,
			token: this.generationToken(generation),
		});
	}

	stageResumed(generation: ShardGeneration | undefined): void {
		if (!generation) return;
		const lease = this.#generations.get(generation.shardId);
		if (!lease || lease.generation !== generation) {
			throw new Error('RESUMED generation is not owned by this Redis coordinator.');
		}
	}

	async commitGeneration(generation: ShardGeneration): Promise<void> {
		try {
			const lease = await this.ensureGeneration(generation);
			if (!lease) return;
			const reply = await this.execute(COMMIT_SCRIPT, {
				arguments: [this.#incarnation, lease.token, String(lease.epoch)],
				keys: [this.liveKey(), this.leaseKey(generation.shardId), this.generationKey(generation.shardId)],
			});
			if (this.integerReply('commit generation', reply) === 1) return;
			if (this.#generations.get(generation.shardId)?.generation !== generation) return;
			this.lose('redis-lease-lost', 'Generation commit lost its lease.');
		} catch (error) {
			if (this.#failed) throw error;
			this.lose('redis-generation-commit-failed', error);
		}
	}

	async read(request: CoordinatedReadRequest): Promise<unknown> {
		if (!this.isActive()) return this.readMiss(request.kind);
		try {
			const guard = await this.guardAuthorization(request.guard);
			if (request.guard && !guard) {
				await this.releaseClaim(request.guard);
				return this.readMiss(request.kind);
			}
			const authorization = guard ?? (await this.generationReadAuthorization(request.generation));
			if (request.generation && !authorization) return this.readMiss(request.kind);
			const readAuthorization = authorization ?? this.defaultReadAuthorization();
			switch (request.kind) {
				case 'get':
					return await this.readValue(this.stringArgument(request, 0), request, guard, readAuthorization);
				case 'bulk-get': {
					const keys = this.stringArrayArgument(request, 0);
					const allowedGenerations = this.allowedGenerations();
					const values = await mapInBatches(keys, key =>
						this.readValue(key, request, guard, readAuthorization, allowedGenerations),
					);
					return values.filter(value => value !== null);
				}
				case 'scan':
					return await this.scan(request, guard, readAuthorization);
				case 'relationship-ids':
					return await this.readRelationship(this.stringArgument(request, 0), request, guard, readAuthorization);
				case 'contains': {
					const to = this.stringArgument(request, 0);
					const id = this.stringArgument(request, 1);
					return (await this.validateRelationshipIds(to, [id], request, guard, readAuthorization)).length !== 0;
				}
				case 'count':
					return (await this.readRelationship(this.stringArgument(request, 0), request, guard, readAuthorization))
						.length;
				case 'keys': {
					const to = this.stringArgument(request, 0);
					return (await this.readRelationship(to, request, guard, readAuthorization)).map(id =>
						this.physicalKey(`${this.#binding!.controller.canonicalKey(this.logicalKey(to))}.${id}`),
					);
				}
				case 'values': {
					const to = this.stringArgument(request, 0);
					const ids = await this.readRelationship(to, request, guard, readAuthorization);
					const allowedGenerations = this.allowedGenerations();
					const values = await mapInBatches(ids, id =>
						this.readValue(
							this.#binding!.controller.relationshipEntityKey(to, id),
							request,
							guard,
							readAuthorization,
							allowedGenerations,
						),
					);
					return values.filter(value => value !== null);
				}
			}
		} catch (error) {
			if (!this.#closed) this.fail('redis-read-failed', error);
			return this.readMiss(request.kind);
		}
	}

	async mutate(request: CoordinatedMutationRequest): Promise<CoordinatedMutationResult> {
		if (!this.isActive()) return { admitted: this.mutationMisses(request) };
		try {
			switch (request.kind) {
				case 'value-write':
					return { admitted: await this.mutateValues(request) };
				case 'value-remove':
					return { admitted: await this.removeValues(request) };
				case 'relationship-add':
					return { admitted: await this.addRelationships(request) };
				case 'relationship-remove':
					return { admitted: await this.removeRelationships(request) };
				case 'relationship-clear':
					return { admitted: await this.clearRelationships(request) };
				case 'claimed-delete':
					return { admitted: [await this.deleteClaimedValue(request)] };
				case 'flush':
					return { admitted: [await this.flushStorage()] };
			}
		} catch (error) {
			if (error instanceof RedisSerializationError) throw error.operationError;
			this.failDataPlane('redis-mutation-failed', error);
		}
	}

	private async mutateValues(
		request: Extract<CoordinatedMutationRequest, { kind: 'value-write' }>,
	): Promise<boolean[]> {
		return mapInBatches(request.entries, async entry => {
			const [key, value] = this.valueTuple(entry.value);
			if (!entry.attempt && this.#binding!.controller.isManagedValue(this.logicalKey(key))) {
				return false;
			}
			const authorization = await this.authorization(entry.attempt);
			if (!authorization) return false;
			const serialized = this.serialize(value);
			const operation = request.operation === 'set' || Array.isArray(value) ? 'set' : 'patch';
			const reply = await this.execute(VALUE_WRITE_SCRIPT, {
				arguments: [
					this.#incarnation,
					authorization.generationToken,
					String(authorization.epoch),
					entry.attempt?.key ?? this.#binding!.controller.valueStateKey(this.logicalKey(key)),
					authorization.scope,
					authorization.shardId,
					String(authorization.fence),
					operation,
					authorization.causal ? '1' : '0',
					...serialized,
				],
				keys: [this.liveKey(), authorization.leaseKey, this.stateKey(), this.flushKey(), this.physicalKey(key)],
			});
			return this.mutationReply('write value', reply);
		});
	}

	private async removeValues(
		request: Extract<CoordinatedMutationRequest, { kind: 'value-remove' }>,
	): Promise<boolean[]> {
		const guard = await this.guardAuthorization(request.guard);
		if (request.guard && !guard) {
			this.abortGuardedEntries(request.entries);
			await this.releaseClaim(request.guard);
			return request.entries.map(() => false);
		}
		return mapInBatches(
			request.entries,
			async entry => {
				const key = this.stringValue(entry.value);
				if (!entry.attempt && this.#binding!.controller.isManagedValue(this.logicalKey(key))) {
					return false;
				}
				const authorization = await this.authorization(entry.attempt);
				if (!authorization) {
					this.abortMutationAttempt(entry.attempt);
					return false;
				}
				const arguments_ = [
					this.#incarnation,
					authorization.generationToken,
					String(authorization.epoch),
					entry.attempt?.key ?? this.#binding!.controller.valueStateKey(this.logicalKey(key)),
					authorization.scope,
					authorization.shardId,
					String(authorization.fence),
					...this.guardArguments(guard),
				];
				const keys = [this.liveKey(), authorization.leaseKey, this.stateKey(), this.flushKey(), this.physicalKey(key)];
				if (!this.revalidateGuard(request.guard)) {
					this.abortMutationAttempt(entry.attempt);
					if (request.guard) await this.releaseClaim(request.guard, guard);
					return false;
				}
				const replyPromise = this.execute(VALUE_REMOVE_SCRIPT, { arguments: arguments_, keys });
				const accepted = this.mutationReply('remove value', await replyPromise);
				if (!accepted) {
					this.abortMutationAttempt(entry.attempt);
					if (entry.attempt && 'cut' in entry.attempt) await this.releaseClaim(entry.attempt, guard);
				}
				return accepted;
			},
			request.guard ? 1 : DATA_BATCH_SIZE,
		);
	}

	private async addRelationships(
		request: Extract<CoordinatedMutationRequest, { kind: 'relationship-add' }>,
	): Promise<boolean[]> {
		return mapInBatches(request.entries, async entry => {
			const [to, id] = this.relationshipTuple(entry.value);
			if (!entry.attempt && this.#binding!.controller.isManagedRelationship(this.logicalKey(to))) {
				return false;
			}
			const authorization = await this.authorization(entry.attempt);
			if (!authorization) return false;
			const canonicalTo = this.canonicalRelationshipTo(to, id, entry.attempt);
			const relationStateKey =
				entry.attempt?.key ?? this.#binding!.controller.relationshipStateKey(this.logicalKey(to), id);
			const reply = await this.execute(RELATION_ADD_SCRIPT, {
				arguments: [
					this.#incarnation,
					authorization.generationToken,
					String(authorization.epoch),
					relationStateKey,
					id,
					authorization.scope,
					authorization.shardId,
					String(authorization.fence),
					authorization.causal
						? JSON.stringify(['value', this.#binding!.controller.relationshipEntityKeyCanonical(canonicalTo, id)])
						: '',
					JSON.stringify(['relationship-clear', canonicalTo]),
					authorization.causal ? '1' : '0',
				],
				keys: [
					this.liveKey(),
					authorization.leaseKey,
					this.stateKey(),
					this.flushKey(),
					this.relationshipPhysicalKey(canonicalTo),
				],
			});
			return this.mutationReply('add relationship', reply);
		});
	}

	private async removeRelationships(
		request: Extract<CoordinatedMutationRequest, { kind: 'relationship-remove' }>,
	): Promise<boolean[]> {
		const guard = await this.guardAuthorization(request.guard);
		if (request.guard && !guard) {
			this.abortGuardedEntries(request.entries);
			await this.releaseClaim(request.guard);
			return request.entries.map(() => false);
		}
		return mapInBatches(
			request.entries,
			async entry => {
				const [to, id] = this.relationshipTuple(entry.value);
				if (!entry.attempt && this.#binding!.controller.isManagedRelationship(this.logicalKey(to))) {
					return false;
				}
				const authorization = await this.authorization(entry.attempt);
				if (!authorization) {
					this.abortMutationAttempt(entry.attempt);
					return false;
				}
				const canonicalTo = this.canonicalRelationshipTo(to, id, entry.attempt);
				const arguments_ = [
					this.#incarnation,
					authorization.generationToken,
					String(authorization.epoch),
					entry.attempt?.key ?? this.#binding!.controller.relationshipStateKey(this.logicalKey(to), id),
					id,
					authorization.scope,
					authorization.shardId,
					String(authorization.fence),
					...this.guardArguments(guard),
				];
				const keys = [
					this.liveKey(),
					authorization.leaseKey,
					this.stateKey(),
					this.flushKey(),
					this.relationshipPhysicalKey(canonicalTo),
				];
				if (!this.revalidateGuard(request.guard)) {
					this.abortMutationAttempt(entry.attempt);
					if (request.guard) await this.releaseClaim(request.guard, guard);
					return false;
				}
				const replyPromise = this.execute(RELATION_REMOVE_SCRIPT, { arguments: arguments_, keys });
				const accepted = this.mutationReply('remove relationship', await replyPromise);
				if (!accepted) this.abortMutationAttempt(entry.attempt);
				return accepted;
			},
			request.guard ? 1 : DATA_BATCH_SIZE,
		);
	}

	private async clearRelationships(
		request: Extract<CoordinatedMutationRequest, { kind: 'relationship-clear' }>,
	): Promise<boolean[]> {
		const guard = await this.guardAuthorization(request.guard);
		if (request.guard && !guard) {
			this.abortGuardedEntries(request.entries);
			await this.releaseClaim(request.guard);
			return request.entries.map(() => false);
		}
		return mapInBatches(
			request.entries,
			async entry => {
				const to = this.stringValue(entry.value);
				if (!entry.attempt && this.#binding!.controller.isManagedRelationship(this.logicalKey(to))) {
					return false;
				}
				const authorization = await this.authorization(entry.attempt);
				if (!authorization) {
					this.abortMutationAttempt(entry.attempt);
					return false;
				}
				const canonicalTo = this.canonicalRelationshipClearTo(to, entry.attempt);
				const arguments_ = [
					this.#incarnation,
					authorization.generationToken,
					String(authorization.epoch),
					entry.attempt?.key ?? this.#binding!.controller.relationshipClearStateKey(this.logicalKey(to)),
					authorization.scope,
					authorization.shardId,
					String(authorization.fence),
					...this.guardArguments(guard),
				];
				const keys = [
					this.liveKey(),
					authorization.leaseKey,
					this.stateKey(),
					this.flushKey(),
					this.relationshipPhysicalKey(canonicalTo),
				];
				if (!this.revalidateGuard(request.guard)) {
					this.abortMutationAttempt(entry.attempt);
					if (request.guard) await this.releaseClaim(request.guard, guard);
					return false;
				}
				const replyPromise = this.execute(RELATION_CLEAR_SCRIPT, { arguments: arguments_, keys });
				const accepted = this.mutationReply('clear relationship', await replyPromise);
				if (!accepted) this.abortMutationAttempt(entry.attempt);
				return accepted;
			},
			request.guard ? 1 : DATA_BATCH_SIZE,
		);
	}

	private async deleteClaimedValue(
		request: Extract<CoordinatedMutationRequest, { kind: 'claimed-delete' }>,
	): Promise<boolean> {
		const authorization = await this.authorization(request.claim);
		if (!authorization) {
			this.#binding!.controller.abortPhysicalDeleteBeforeMutation(request.claim);
			await this.releaseClaim(request.claim);
			return false;
		}
		const relationship = request.relationship;
		const arguments_ = [
			this.#incarnation,
			authorization.generationToken,
			String(authorization.epoch),
			request.claim.key,
			authorization.shardId,
			String(authorization.fence),
			this.claimToken(request.claim, authorization.generationToken),
			relationship?.id ?? '',
			relationship
				? this.#binding!.controller.relationshipStateKey(this.logicalKey(relationship.to), relationship.id)
				: '',
		];
		const keys = [
			this.liveKey(),
			authorization.leaseKey,
			this.stateKey(),
			this.flushKey(),
			this.physicalKey(request.key),
			relationship ? this.relationshipPhysicalKey(relationship.to) : this.stateKey(),
		];
		if (!this.#binding!.controller.isExecutingDeleteCurrent(request.claim)) {
			this.#binding!.controller.abortPhysicalDeleteBeforeMutation(request.claim);
			await this.releaseClaim(request.claim);
			return false;
		}
		const replyPromise = this.execute(CLAIM_DELETE_SCRIPT, { arguments: arguments_, keys });
		const accepted = this.mutationReply('delete claimed value', await replyPromise);
		if (!accepted) {
			this.#binding!.controller.abortPhysicalDeleteBeforeMutation(request.claim);
			await this.releaseClaim(request.claim);
		}
		return accepted;
	}

	private async flushStorage(): Promise<boolean> {
		const token = `${this.#incarnation}:${randomUUID()}`;
		let flushEpoch: number;
		for (;;) {
			const reply = await this.execute(BEGIN_FLUSH_SCRIPT, {
				arguments: [this.#incarnation, token, String(this.#leaseTtlMs)],
				keys: [this.liveKey(), this.flushOwnerKey(), this.flushKey(), this.flushProgressKey()],
			});
			flushEpoch = this.integerReply('begin flush', reply);
			if (flushEpoch !== -2) break;
			await new Promise(resolve => setTimeout(resolve, Math.max(25, Math.floor(this.#leaseTtlMs / 10))));
			if (!this.isActive()) return false;
		}
		if (flushEpoch < 0) this.lose('redis-lease-lost', 'Redis flush lost coordinator liveness.');
		await this.refreshFlush(token);
		for await (const batch of this.#client.scanIterator({
			COUNT: DATA_BATCH_SIZE,
			MATCH: this.physicalKey('*'),
			TYPE: 'hash',
		})) {
			await this.refreshFlush(token);
			const cleanedValues = await mapInBatches(batch, physicalKey => {
				const logicalKey = this.logicalKey(physicalKey);
				return this.execute(CLEAN_FLUSH_VALUE_SCRIPT, {
					arguments: [
						this.#incarnation,
						token,
						String(this.#leaseTtlMs),
						this.#binding!.controller.valueStateKey(logicalKey),
						String(flushEpoch),
					],
					keys: [this.liveKey(), this.flushOwnerKey(), this.stateKey(), physicalKey],
				});
			});
			for (const cleaned of cleanedValues) {
				if (this.integerReply('clean flushed value', cleaned) < 0) {
					this.lose('redis-lease-lost', 'Redis flush lost coordinator liveness.');
				}
			}
			await this.refreshFlush(token);
		}
		for await (const batch of this.#client.scanIterator({
			COUNT: DATA_BATCH_SIZE,
			MATCH: this.relationshipPhysicalKey('*'),
			TYPE: 'set',
		})) {
			await this.refreshFlush(token);
			for (const physicalKey of batch) {
				const to = this.relationshipLogicalKey(physicalKey);
				for await (const ids of this.#client.sScanIterator(physicalKey, { COUNT: DATA_BATCH_SIZE })) {
					await this.refreshFlush(token);
					const cleanedRelations = await mapInBatches(ids, id =>
						this.execute(CLEAN_FLUSH_RELATION_SCRIPT, {
							arguments: [
								this.#incarnation,
								token,
								String(this.#leaseTtlMs),
								this.#binding!.controller.relationshipStateKey(to, id),
								id,
								String(flushEpoch),
							],
							keys: [this.liveKey(), this.flushOwnerKey(), this.stateKey(), physicalKey],
						}),
					);
					for (const cleaned of cleanedRelations) {
						if (this.integerReply('clean flushed relationship', cleaned) < 0) {
							this.lose('redis-lease-lost', 'Redis flush lost coordinator liveness.');
						}
					}
					await this.refreshFlush(token);
				}
			}
		}
		const finished = await this.execute(FINISH_FLUSH_SCRIPT, {
			arguments: [this.#incarnation, token],
			keys: [this.liveKey(), this.flushOwnerKey(), this.flushProgressKey()],
		});
		if (this.integerReply('finish flush', finished) !== 1) {
			this.lose('redis-lease-lost', 'Redis flush lost its barrier before completion.');
		}
		return true;
	}

	private async refreshFlush(token: string): Promise<void> {
		const refreshed = await this.execute(REFRESH_FLUSH_SCRIPT, {
			arguments: [this.#incarnation, token, String(this.#leaseTtlMs)],
			keys: [this.liveKey(), this.flushOwnerKey()],
		});
		if (this.integerReply('refresh flush', refreshed) !== 1) {
			this.lose('redis-lease-lost', 'Redis flush lost its barrier.');
		}
	}

	private async authorization(attempt: MutationAttempt | undefined): Promise<OperationAuthorization | undefined> {
		let causal = false;
		let fence = ++this.#nextLocalFence;
		let generation: ShardGeneration | undefined;
		let scope: OperationAuthorization['scope'] = 'unmanaged';
		if (attempt) {
			fence = attempt.fence;
			if ('cut' in attempt) {
				generation = attempt.generation;
				scope = 'shard';
			} else {
				causal = 'causal' in attempt && attempt.causal;
				scope = attempt.generation.kind;
				generation = attempt.origin ?? (attempt.generation.kind === 'shard' ? attempt.generation : undefined);
			}
		}
		if (generation) {
			const lease = await this.ensureGeneration(generation);
			if (!lease) return;
			return {
				causal,
				epoch: lease.epoch!,
				fence,
				generationToken: lease.token,
				leaseKey: this.leaseKey(generation.shardId),
				scope,
				shardId: String(generation.shardId),
			};
		}
		return {
			causal,
			epoch: this.currentOperationEpoch(),
			fence,
			generationToken: '',
			leaseKey: this.liveKey(),
			scope,
			shardId: '',
		};
	}

	private async guardAuthorization(claim: DeleteClaim | undefined): Promise<GuardAuthorization | undefined> {
		if (!claim) return;
		const lease = await this.ensureGeneration(claim.generation);
		if (!lease || !this.revalidateGuard(claim)) return;
		return {
			claimToken: this.claimToken(claim, lease.token),
			epoch: lease.epoch!,
			fence: claim.fence,
			generationToken: lease.token,
			leaseKey: this.leaseKey(claim.generation.shardId),
			shardId: String(claim.generation.shardId),
			stateKey: claim.key,
		};
	}

	private async releaseClaim(claim: DeleteClaim, guard?: GuardAuthorization): Promise<void> {
		if (!this.isActive()) return;
		const claimToken = guard?.claimToken ?? this.claimToken(claim, this.generationToken(claim.generation));
		const reply = await this.execute(RELEASE_CLAIM_SCRIPT, {
			arguments: [this.#incarnation, claim.key, claimToken],
			keys: [this.liveKey(), this.stateKey()],
		});
		if (this.integerReply('release stale claim', reply) < 0) {
			this.lose('redis-lease-lost', 'Redis stale claim release lost coordinator liveness.');
		}
	}

	private guardArguments(guard: GuardAuthorization | undefined): string[] {
		return guard
			? [
					guard.stateKey,
					String(guard.epoch),
					String(guard.fence),
					guard.claimToken,
					guard.shardId,
					guard.generationToken,
				]
			: ['', '', '', '', '', ''];
	}

	private async readValue(
		key: string,
		request: CoordinatedReadRequest,
		guard: GuardAuthorization | undefined,
		authorization: GuardAuthorization,
		allowedGenerations = this.allowedGenerations(),
	): Promise<unknown | null> {
		if (!this.revalidateGuard(request.guard)) return null;
		const replyPromise = this.execute(READ_VALUE_SCRIPT, {
			arguments: [
				this.#incarnation,
				authorization.generationToken,
				String(authorization.epoch),
				this.#binding!.controller.valueStateKey(this.logicalKey(key)),
				this.#binding!.controller.isManagedValue(this.logicalKey(key)) ? '1' : '0',
				request.unfiltered ? '1' : '0',
				this.#namespace,
				...this.guardArguments(guard),
				allowedGenerations,
			],
			keys: [this.liveKey(), authorization.leaseKey, this.stateKey(), this.flushKey(), this.physicalKey(key)],
		});
		const reply = await replyPromise;
		if (!this.revalidateGuard(request.guard)) {
			if (request.guard) await this.releaseClaim(request.guard, guard);
			return null;
		}
		const entries = this.arrayReply('read value', reply);
		if (entries.length === 1 && entries[0] === -1) this.lose('redis-lease-lost', 'Redis value read was fenced.');
		if (entries.length === 0) return null;
		if (entries.length % 2 !== 0) throw new TypeError('Redis value read returned an invalid hash reply.');
		const value = toNormal(Object.fromEntries(this.pairs(entries)));
		return value ?? null;
	}

	private async readRelationship(
		to: string,
		request: CoordinatedReadRequest,
		guard: GuardAuthorization | undefined,
		authorization: GuardAuthorization,
	): Promise<string[]> {
		if (!this.revalidateGuard(request.guard)) return [];
		const result = new Set<string>();
		for await (const ids of this.#client.sScanIterator(this.relationshipPhysicalKey(to), {
			COUNT: DATA_BATCH_SIZE,
		})) {
			for (const id of await this.validateRelationshipIds(to, ids, request, guard, authorization)) result.add(id);
			if (!this.revalidateGuard(request.guard)) {
				if (request.guard) await this.releaseClaim(request.guard, guard);
				return [];
			}
		}
		return [...result];
	}

	private async validateRelationshipIds(
		to: string,
		ids: readonly string[],
		request: CoordinatedReadRequest,
		guard: GuardAuthorization | undefined,
		authorization: GuardAuthorization,
	): Promise<string[]> {
		if (ids.length === 0 || !this.revalidateGuard(request.guard)) return [];
		const canonicalTo = this.#binding!.controller.canonicalKey(this.logicalKey(to));
		const entityPrefix = this.#binding!.controller.relationshipEntityKey(canonicalTo, '');
		const replyPromise = this.execute(READ_RELATION_IDS_SCRIPT, {
			arguments: [
				this.#incarnation,
				authorization.generationToken,
				String(authorization.epoch),
				this.#binding!.controller.isManagedRelationship(this.logicalKey(to)) ? '1' : '0',
				request.unfiltered ? '1' : '0',
				this.#namespace,
				...this.guardArguments(guard),
				this.#binding!.controller.relationshipClearStateKey(this.logicalKey(to)),
				canonicalTo,
				entityPrefix,
				this.allowedGenerations(),
				JSON.stringify(ids),
			],
			keys: [
				this.liveKey(),
				authorization.leaseKey,
				this.stateKey(),
				this.flushKey(),
				this.relationshipPhysicalKey(to),
			],
		});
		const reply = await replyPromise;
		if (!this.revalidateGuard(request.guard)) {
			if (request.guard) await this.releaseClaim(request.guard, guard);
			return [];
		}
		const values = this.arrayReply('read relationship', reply);
		if (values.length === 1 && values[0] === -1) this.lose('redis-lease-lost', 'Redis relationship read was fenced.');
		if (values.some(value => typeof value !== 'string')) {
			throw new TypeError('Redis relationship read returned a non-string ID.');
		}
		return values as string[];
	}

	private async scan(
		request: CoordinatedReadRequest,
		guard: GuardAuthorization | undefined,
		authorization: GuardAuthorization,
	): Promise<unknown[]> {
		const query = this.stringArgument(request, 0);
		const returnKeys = request.args[1] === true;
		const result: unknown[] = [];
		const allowedGenerations = this.allowedGenerations();
		for await (const batch of this.#client.scanIterator({ MATCH: this.physicalKey(query), TYPE: 'hash' })) {
			if (!this.revalidateGuard(request.guard)) {
				if (request.guard) await this.releaseClaim(request.guard, guard);
				return [];
			}
			const values = await mapInBatches(batch, async physicalKey => {
				const value = await this.readValue(
					this.logicalKey(physicalKey),
					request,
					guard,
					authorization,
					allowedGenerations,
				);
				return { physicalKey, value };
			});
			for (const value of values) {
				if (value.value !== null) result.push(returnKeys ? value.physicalKey : value.value);
			}
		}
		return result;
	}

	private async generationReadAuthorization(
		generation: ShardGeneration | undefined,
	): Promise<GuardAuthorization | undefined> {
		if (!generation) return;
		const lease = await this.ensureGeneration(generation);
		if (!lease) return;
		return {
			claimToken: '',
			epoch: lease.epoch!,
			fence: 0,
			generationToken: lease.token,
			leaseKey: this.leaseKey(generation.shardId),
			shardId: String(generation.shardId),
			stateKey: '',
		};
	}

	private defaultReadAuthorization(): GuardAuthorization {
		return {
			claimToken: '',
			epoch: this.currentOperationEpoch(),
			fence: 0,
			generationToken: '',
			leaseKey: this.liveKey(),
			shardId: '',
			stateKey: '',
		};
	}

	private allowedGenerations(): string {
		return JSON.stringify(
			Object.fromEntries(
				[...this.#generations.values()].flatMap(lease =>
					lease.epoch === undefined
						? []
						: [[String(lease.generation.shardId), { epoch: lease.epoch, generation: lease.token }]],
				),
			),
		);
	}

	private revalidateGuard(claim: DeleteClaim | undefined): boolean {
		return (
			claim === undefined ||
			this.#binding!.controller.isDeleteClaimCurrent(claim) ||
			this.#binding!.controller.isExecutingDeleteCurrent(claim)
		);
	}

	private abortGuardedEntries(
		entries: readonly { readonly attempt?: DeleteClaim | RemoveAttempt; readonly value: unknown }[],
	): void {
		for (const entry of entries) this.abortMutationAttempt(entry.attempt);
	}

	private abortMutationAttempt(attempt: DeleteClaim | RemoveAttempt | undefined): void {
		if (!attempt) return;
		if ('cut' in attempt) this.#binding!.controller.abortPhysicalDeleteBeforeMutation(attempt);
		else this.#binding!.controller.abortRemoveBeforeMutation(attempt);
	}

	private currentOperationEpoch(): number {
		return Math.max(this.#instanceEpoch ?? 0, ...[...this.#generations.values()].map(lease => lease.epoch ?? 0));
	}

	private mutationReply(operation: string, reply: unknown): boolean {
		const value = this.integerReply(operation, reply);
		if (value < 0) this.lose('redis-lease-lost', `Redis ${operation} was fenced.`);
		return value === 1;
	}

	private mutationMisses(request: CoordinatedMutationRequest): boolean[] {
		switch (request.kind) {
			case 'claimed-delete':
			case 'flush':
				return [false];
			default:
				return request.entries.map(() => false);
		}
	}

	private readMiss(kind: CoordinatedReadRequest['kind']): unknown {
		switch (kind) {
			case 'get':
				return null;
			case 'contains':
				return false;
			case 'count':
				return 0;
			default:
				return [];
		}
	}

	private failDataPlane(code: string, error: unknown): never {
		return this.lose(code, error);
	}

	private isActive(): boolean {
		return this.#instanceEpoch !== undefined && this.#started && !this.#failed && !this.#closed;
	}

	private claimToken(claim: DeleteClaim, generationToken: string): string {
		return JSON.stringify([this.#incarnation, generationToken, claim.fence, claim.id]);
	}

	private generationToken(generation: ShardGeneration): string {
		return `${this.#incarnation}:${generation.id}:${generation.sessionId}`;
	}

	private serialize(value: unknown): string[] {
		try {
			const entries = Object.entries(toDb(value as Record<string, any>));
			if (entries.length === 0) throw new TypeError('Redis values must contain at least one serializable field.');
			return entries.flatMap(([key, field]) => {
				if (typeof field !== 'string') {
					throw new TypeError(`Redis field ${key} is not serializable.`);
				}
				return [key, field];
			});
		} catch (error) {
			throw new RedisSerializationError(error);
		}
	}

	private valueTuple(value: unknown): readonly [string, unknown] {
		if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string') {
			throw new TypeError('Redis value mutation expected a [key, value] tuple.');
		}
		return [value[0], value[1]];
	}

	private relationshipTuple(value: unknown): readonly [string, string] {
		if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' || typeof value[1] !== 'string') {
			throw new TypeError('Redis relationship mutation expected a [relationship, id] tuple.');
		}
		return [value[0], value[1]];
	}

	private canonicalRelationshipTo(to: string, id: string, attempt: MutationAttempt | undefined): string {
		if (!attempt) return this.#binding!.controller.canonicalKey(this.logicalKey(to));
		const token = JSON.parse(attempt.key) as unknown;
		if (
			!Array.isArray(token) ||
			token.length !== 3 ||
			token[0] !== 'relationship' ||
			typeof token[1] !== 'string' ||
			token[2] !== id
		) {
			throw new TypeError('Redis relationship mutation received an invalid staged state token.');
		}
		return token[1];
	}

	private canonicalRelationshipClearTo(to: string, attempt: MutationAttempt | undefined): string {
		if (!attempt) return this.#binding!.controller.canonicalKey(this.logicalKey(to));
		const token = JSON.parse(attempt.key) as unknown;
		if (
			!Array.isArray(token) ||
			token.length !== 2 ||
			token[0] !== 'relationship-clear' ||
			typeof token[1] !== 'string'
		) {
			throw new TypeError('Redis relationship clear received an invalid staged state token.');
		}
		return token[1];
	}

	private stringValue(value: unknown): string {
		if (typeof value !== 'string') throw new TypeError('Redis cache mutation expected a string key.');
		return value;
	}

	private stringArgument(request: CoordinatedReadRequest, index: number): string {
		const value = request.args[index];
		if (typeof value !== 'string') throw new TypeError(`Redis ${request.kind} expected a string argument.`);
		return value;
	}

	private stringArrayArgument(request: CoordinatedReadRequest, index: number): string[] {
		const value = request.args[index];
		if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
			throw new TypeError(`Redis ${request.kind} expected a string array argument.`);
		}
		return value;
	}

	private arrayReply(operation: string, reply: unknown): unknown[] {
		if (!Array.isArray(reply)) throw new TypeError(`Redis ${operation} script returned a non-array reply.`);
		return reply;
	}

	private pairs(values: unknown[]): [string, string][] {
		const pairs: [string, string][] = [];
		for (let index = 0; index < values.length; index += 2) {
			const key = values[index];
			const value = values[index + 1];
			if (typeof key !== 'string' || typeof value !== 'string') {
				throw new TypeError('Redis hash reply contained a non-string field.');
			}
			pairs.push([key, value]);
		}
		return pairs;
	}

	private stateKey(): string {
		return this.key('state');
	}

	private cacheOwnerKey(): string {
		return `${this.#cacheNamespace}:__slipher_cache_integrity_control`;
	}

	private liveEpochsKey(): string {
		return this.key('live-epochs');
	}

	private flushKey(): string {
		return this.key('flush-epoch');
	}

	private flushOwnerKey(): string {
		return this.key('flush-owner');
	}

	private flushProgressKey(): string {
		return this.key('flush-progress');
	}

	private physicalKey(key: string): string {
		return key.startsWith(`${this.#cacheNamespace}:`) ? key : `${this.#cacheNamespace}:${key}`;
	}

	private logicalKey(key: string): string {
		const prefix = `${this.#cacheNamespace}:`;
		return key.startsWith(prefix) ? key.slice(prefix.length) : key;
	}

	private relationshipPhysicalKey(to: string): string {
		return `${this.physicalKey(to)}:set`;
	}

	private relationshipLogicalKey(key: string): string {
		const logical = this.logicalKey(key);
		return logical.endsWith(':set') ? logical.slice(0, -4) : logical;
	}

	private async ensureGeneration(generation: ShardGeneration): Promise<GenerationLease | undefined> {
		const lease = this.#generations.get(generation.shardId);
		if (!lease || lease.generation !== generation) return;
		if (this.#failed || this.#closed || !this.#started) throw new Error('Redis coordinator is not active.');
		lease.acquire ??= this.acquire(lease);
		await lease.acquire;
		if (this.#generations.get(generation.shardId) !== lease || lease.epoch === undefined) return;
		return lease;
	}

	private async acquire(lease: GenerationLease): Promise<void> {
		const reply = await this.execute(ACQUIRE_SCRIPT, {
			arguments: [
				this.#incarnation,
				lease.token,
				lease.generation.sessionId,
				String(this.#leaseTtlMs),
				this.ownedLeaseWatermark(),
			],
			keys: [
				this.liveKey(),
				this.leaseKey(lease.generation.shardId),
				this.generationKey(lease.generation.shardId),
				this.key('token-epoch'),
				this.liveEpochsKey(),
			],
		});
		const epoch = this.integerReply('acquire shard lease', reply);
		if (this.#generations.get(lease.generation.shardId) !== lease) return;
		if (epoch === -2) this.lose('redis-shard-owned', `Shard ${lease.generation.shardId} has another live owner.`);
		if (epoch < 1) this.lose('redis-lease-lost', `Shard ${lease.generation.shardId} could not acquire its lease.`);
		lease.epoch = epoch;
	}

	private ownedLeaseWatermark(): string {
		const epochs = [...this.#generations.values()].flatMap(lease => (lease.epoch === undefined ? [] : [lease.epoch]));
		return epochs.length === 0 ? '' : String(Math.min(...epochs));
	}

	private scheduleRenewal(): void {
		if (this.#renewal || this.#failed || this.#closed || !this.#started) return;
		this.#renewal = this.renew()
			.catch(() => undefined)
			.finally(() => {
				this.#renewal = undefined;
			});
	}

	private async renew(): Promise<void> {
		try {
			const owned = [...this.#generations.values()].filter(
				(lease): lease is GenerationLease & { epoch: number } => lease.epoch !== undefined,
			);
			const reply = await this.execute(RENEW_SCRIPT, {
				arguments: [
					this.#incarnation,
					String(this.#leaseTtlMs),
					...owned.flatMap(lease => [lease.token, String(lease.epoch)]),
				],
				keys: [this.liveKey(), ...owned.map(lease => this.leaseKey(lease.generation.shardId))],
			});
			if (this.integerReply('renew leases', reply) !== 1)
				this.lose('redis-lease-lost', 'Redis lease renewal was fenced.');
			await this.compactState();
		} catch (error) {
			this.lose('redis-renewal-failed', error);
		}
	}

	private async compactState(): Promise<void> {
		const reply = this.arrayReply(
			'compact state',
			await this.execute(COMPACT_STATE_SCRIPT, {
				arguments: [
					this.#incarnation,
					this.key('live:'),
					this.#compactionCursor,
					String(COMPACTION_BATCH_SIZE),
					String(COMPACTION_BATCH_SIZE),
				],
				keys: [this.liveKey(), this.liveEpochsKey(), this.stateKey()],
			}),
		);
		if (reply.length === 1 && reply[0] === -1) {
			this.lose('redis-lease-lost', 'Redis state compaction lost coordinator liveness.');
		}
		if (reply.length !== 3 || typeof reply[0] !== 'string') {
			throw new TypeError('Redis state compaction script returned an invalid reply.');
		}
		this.#compactionCursor = reply[0];
	}

	private lose(code: string, error: unknown): never {
		throw this.fail(code, error);
	}

	private fail(code: string, error: unknown): Error {
		if (!this.#failed && !this.#closed) {
			void this.deactivate().catch(() => undefined);
			this.#binding?.onTerminal(code, error);
		}
		return error instanceof Error ? error : new Error(String(error));
	}

	private async releaseOwnership(): Promise<void> {
		if (!this.#client.isOpen) return;
		await this.execute(RELEASE_SCRIPT, {
			arguments: [this.#incarnation],
			keys: [
				this.liveKey(),
				this.liveEpochsKey(),
				...[...this.#generations.keys()].map(shardId => this.leaseKey(shardId)),
			],
		});
	}

	private integerReply(operation: string, reply: unknown): number {
		if (typeof reply !== 'number') throw new TypeError(`Redis ${operation} script returned a non-integer reply.`);
		return reply;
	}

	private key(suffix: string): string {
		return `${this.#namespace}:${suffix}`;
	}

	private liveKey(): string {
		return this.key(`live:${this.#incarnation}`);
	}

	private leaseKey(shardId: number): string {
		return this.key(`lease:${shardId}`);
	}

	private generationKey(shardId: number): string {
		return this.key(`generation:${shardId}`);
	}
}

export function redisCoordinator(options: RedisCoordinatorOptions): RedisCoordinator {
	return new RedisReconciliationCoordinator(options);
}
