-- Publica los cambios acumulados de una ventana de tiempo (RF-4, RF-6). Las ocho instancias lo
-- intentan en cada ventana y la guarda deja pasar a una sola: no hace falta líder, y si una
-- instancia muere la siguiente ventana la toma otra.
--
-- Por cada scope sucio compara el acumulado vivo (tally) con el publicado (pub) y emite SOLO los
-- campos distintos, con su valor absoluto. Valores absolutos y no incrementos: reproducir una
-- entrada dos veces, o aplicarla después de una fotografía, no puede contar doble.
--
-- Todos los scopes de la ventana comparten el mismo `seq` y se publican en la misma ejecución: un
-- lector nunca ve el municipio con un acta cuyo puesto aún no se publicó (RF-3).
--
-- KEYS: 1 guarda | 2 scopes sucios | 3 secuencia | 4 correcciones pendientes
--       5 recepción más antigua sin publicar | 6 último retraso de publicación
-- ARGV: 1 prefijo | 2 TTL guarda (ms) | 3 instancia | 4 máximo de entradas por tópico
--       5 expiración del historial (s) | 6 correcciones retenidas por tópico
local prefix, guardTtl, instance = ARGV[1], ARGV[2], ARGV[3]
local maxEntries, historyTtl, maxCorrections = ARGV[4], ARGV[5], tonumber(ARGV[6])

if not redis.call('SET', KEYS[1], instance, 'NX', 'PX', guardTtl) then return nil end

local dirty = redis.call('SMEMBERS', KEYS[2])
if #dirty == 0 then return nil end

local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local seq = redis.call('INCR', KEYS[3])

local correctionsByScope = {}
for _, raw in ipairs(redis.call('LRANGE', KEYS[4], 0, -1)) do
  local correction = cjson.decode(raw)
  local scopes = correction.scopes
  correction.scopes = nil
  for _, scope in ipairs(scopes) do
    correctionsByScope[scope] = correctionsByScope[scope] or {}
    table.insert(correctionsByScope[scope], correction)
  end
end

local function isPublicTopic(scope) return string.sub(scope, 1, 5) ~= 'mesa:' end

local published = 0
for _, scope in ipairs(dirty) do
  local pubKey = prefix .. 'pub:' .. scope
  local rankKey = prefix .. 'rank:' .. scope
  local tally = redis.call('HGETALL', prefix .. 'tally:' .. scope)
  local changes, changed = {}, false

  for i = 1, #tally, 2 do
    local field, value = tally[i], tonumber(tally[i + 1])
    local pubValue = tonumber(redis.call('HGET', pubKey, field) or '0')
    if pubValue ~= value then
      changes[field] = value
      changed = true
      redis.call('HSET', pubKey, field, value)
      if string.sub(field, 1, 3) == 'v:C' then
        redis.call('ZADD', rankKey, value, string.sub(field, 3))
      end
    end
  end

  local corrections = correctionsByScope[scope]
  if changed or corrections then
    local prev = tonumber(redis.call('HGET', pubKey, 'seq') or '0')
    redis.call('HSET', pubKey, 'seq', seq)

    if isPublicTopic(scope) then
      local message = { topic = scope, seq = seq, prev = prev, at = now, changes = changes }
      if corrections then
        message.corrections = corrections
        local corrKey = prefix .. 'corr:' .. scope
        for _, correction in ipairs(corrections) do
          redis.call('LPUSH', corrKey, cjson.encode(correction))
        end
        redis.call('LTRIM', corrKey, 0, maxCorrections - 1)
      end
      -- Si nada cambió, `changes` vacío se codifica como {} igual que un objeto: es lo que se quiere.
      local encoded = cjson.encode(message)
      local historyKey = prefix .. 'hist:' .. scope
      -- ID explícito seq-0: identificador monótono común a todos los tópicos de la ventana.
      redis.call('XADD', historyKey, 'MAXLEN', maxEntries, seq .. '-0', 'm', encoded)
      redis.call('EXPIRE', historyKey, historyTtl)
      redis.call('PUBLISH', prefix .. 'ch:' .. scope, encoded)
      published = published + 1
    end
  end
end

redis.call('DEL', KEYS[2], KEYS[4])

local oldest = redis.call('GET', KEYS[5])
local lag = oldest and (now - tonumber(oldest)) or 0
redis.call('DEL', KEYS[5])
redis.call('SET', KEYS[6], lag)

return cjson.encode({ seq = seq, published = published, lagMs = lag })
