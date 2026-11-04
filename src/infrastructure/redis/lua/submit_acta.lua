-- Registra una versión de un acta como UNA sola operación indivisible (RF-1, RF-2, RF-3).
-- Redis ejecuta el script completo sin intercalar otro comando: ningún lector puede ver el
-- municipio actualizado sin el puesto. Varios comandos seguidos desde la aplicación no dan esa
-- garantía, y una caída a mitad de camino dejaría los niveles descuadrados para siempre.
--
-- Convergencia (RF-2): el estado de un acta es el máximo de sus envíos según (version, fp).
-- Ese máximo es conmutativo, asociativo e idempotente: el resultado depende del conjunto de actas
-- recibidas y no del orden de llegada. Todo lo demás se deriva únicamente del ganador.
--
-- KEYS: 1 acta | 2 idem | 3 tally mesa | 4 tally puesto | 5 tally municipio | 6 tally departamento
--       7 scopes sucios | 8 cola de verificación | 9 correcciones pendientes
--       10 recepción más antigua sin publicar | 11 catálogo | 12 actas por minuto
-- ARGV: 1 JSON { acta, version, fp, doubtful, priority, votos, sufragantes, mesa, puesto, municipio,
--                jurado, hash_foto, idem, idemTtl, location, scopes = { mesa, puesto, mun, dep } }
local input = cjson.decode(ARGV[1])
local CONFLICT_PRIORITY = -1000000000

local function reply(fields) return cjson.encode(fields) end

local function accepted(status, appliedVersion, receivedAt)
  return { outcome = 'accepted', status = status, acta = input.acta, version = input.version,
           appliedVersion = appliedVersion, receivedAt = receivedAt }
end

-- 1. Clave de idempotencia: el reenvío recibe la respuesta original, nunca silencio.
local cached = redis.call('GET', KEYS[2])
if cached then
  local previous = cjson.decode(cached)
  if previous.fp ~= input.fp then
    return reply({ outcome = 'rejected', code = 'IDEM_MISMATCH' })
  end
  return reply(accepted('duplicate', previous.appliedVersion, previous.receivedAt))
end

-- 2. La mesa debe existir y pertenecer al puesto y municipio declarados.
if redis.call('HGET', KEYS[11], tostring(input.mesa)) ~= input.location then
  return reply({ outcome = 'rejected', code = 'UNKNOWN_MESA' })
end

local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)

local function remember(result)
  redis.call('SET', KEYS[2], cjson.encode({ fp = input.fp, appliedVersion = result.appliedVersion,
    receivedAt = result.receivedAt }), 'EX', input.idemTtl)
  return reply(result)
end

-- 3. Comparar con la versión vigente. Si la clave de idempotencia expiró antes que el reintento, la
--    protección sigue aquí: la identidad natural (acta, versión, contenido) detecta el duplicado.
local current = redis.call('HMGET', KEYS[1], 'version', 'fp', 'doubtful', 'counted', 'votos',
  'sufragantes', 'receivedAt')
local currentVersion = tonumber(current[1])
local currentFp = current[2]
local currentReceivedAt = tonumber(current[7])
local conflict = false

if currentVersion then
  if input.version < currentVersion then
    return remember(accepted('superseded', currentVersion, currentReceivedAt))
  end
  if input.version == currentVersion then
    if input.fp == currentFp then
      return remember(accepted('duplicate', currentVersion, currentReceivedAt))
    end
    conflict = true
  end
end

-- 4. Ganador. En un conflicto gana la huella mayor, para no depender del orden, y el acta queda
--    dudosa: dos envíos contradictorios de la misma versión los resuelve un humano.
local inputWins = (not conflict) or input.fp > currentFp
local doubtful = conflict or input.doubtful
local wasCounted = current[4] == '1'
local wasDoubtful = current[3] == '1'
local counted = not doubtful

local function applyToLevels(votos, sufragantes, sign)
  for level = 3, 6 do
    for option, votes in pairs(votos) do
      redis.call('HINCRBY', KEYS[level], 'v:' .. option, sign * votes)
    end
    redis.call('HINCRBY', KEYS[level], 'sufragantes', sign * sufragantes)
    redis.call('HINCRBY', KEYS[level], 'mesas_informadas', sign)
  end
end

local winnerVotos = inputWins and input.votos or cjson.decode(current[5])
local winnerSufragantes = inputWins and input.sufragantes or tonumber(current[6])

-- 5. Revertir lo vigente y aplicar lo nuevo sobre los cuatro niveles.
if wasCounted then applyToLevels(cjson.decode(current[5]), tonumber(current[6]), -1) end
if counted then applyToLevels(winnerVotos, winnerSufragantes, 1) end

local reviewDelta = (doubtful and 1 or 0) - (wasDoubtful and 1 or 0)
if reviewDelta ~= 0 then
  for level = 3, 6 do redis.call('HINCRBY', KEYS[level], 'en_verificacion', reviewDelta) end
end

-- 6. Un número publicado que cambia siempre lleva su explicación.
if wasCounted then
  redis.call('RPUSH', KEYS[9], cjson.encode({
    acta = input.acta, mesa = input.mesa, puesto = input.puesto, municipio = input.municipio,
    fromVersion = currentVersion, toVersion = input.version,
    reason = counted and 'correction' or 'under_review', at = now,
    scopes = { input.scopes.puesto, input.scopes.mun, input.scopes.dep } }))
end

-- 7. Cola de verificación.
if doubtful then
  redis.call('ZADD', KEYS[8], conflict and CONFLICT_PRIORITY or input.priority, input.acta)
else
  redis.call('ZREM', KEYS[8], input.acta)
end

-- 8. Estado del acta.
local appliedVersion = input.version
redis.call('HSET', KEYS[1], 'version', appliedVersion, 'doubtful', doubtful and '1' or '0',
  'counted', counted and '1' or '0', 'receivedAt', now)
if inputWins then
  redis.call('HSET', KEYS[1], 'fp', input.fp, 'votos', cjson.encode(input.votos),
    'sufragantes', input.sufragantes, 'mesa', input.mesa, 'puesto', input.puesto,
    'municipio', input.municipio, 'jurado', input.jurado, 'hash_foto', input.hash_foto)
end

-- 9. Marcar para la siguiente ventana de publicación y medir.
redis.call('SADD', KEYS[7], input.scopes.mesa, input.scopes.puesto, input.scopes.mun,
  input.scopes.dep)
redis.call('SET', KEYS[10], now, 'NX')
redis.call('HINCRBY', KEYS[12], tostring(math.floor(now / 60000)), 1)

local status = 'registered'
if conflict then status = 'conflict' elseif doubtful then status = 'in_review' end
return remember(accepted(status, appliedVersion, now))
