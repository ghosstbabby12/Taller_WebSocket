-- Lee en una sola operación la secuencia vigente y las entradas posteriores al cursor de cada
-- tópico. La decisión entre detalle y fotografía se toma en la aplicación (domain/recovery.ts).
--
-- ARGV: 1 prefijo | 2 JSON [{ topic, cursor }] | 3 máximo de entradas a devolver por tópico
local prefix = ARGV[1]
local requests = cjson.decode(ARGV[2])
local limit = ARGV[3]
local result = {}

for _, request in ipairs(requests) do
  local entries = {}
  if request.cursor then
    local rows = redis.call('XRANGE', prefix .. 'hist:' .. request.topic,
      '(' .. string.format('%.0f', request.cursor) .. '-0', '+', 'COUNT', limit)
    for _, row in ipairs(rows) do table.insert(entries, row[2][2]) end
  end
  table.insert(result, {
    topic = request.topic,
    currentSeq = tonumber(redis.call('HGET', prefix .. 'pub:' .. request.topic, 'seq') or '0'),
    entries = entries,
  })
end

return cjson.encode(result)
