-- Fotografía consistente de varios tópicos en una sola lectura (RF-3): dos lecturas separadas
-- podrían mostrar un municipio y un puesto de ventanas distintas. Lee `pub`, nunca `tally`: el
-- cliente debe ver lo mismo que quien recibió los deltas, no un valor aún no publicado.
--
-- ARGV: 1 prefijo | 2 JSON con la lista de tópicos | 3 candidatos en el ranking
local prefix = ARGV[1]
local topics = cjson.decode(ARGV[2])
local rankingSize = tonumber(ARGV[3])
local result = {}

for _, topic in ipairs(topics) do
  local entry = {
    topic = topic,
    fields = redis.call('HGETALL', prefix .. 'pub:' .. topic),
    ranking = redis.call('ZREVRANGE', prefix .. 'rank:' .. topic, 0, rankingSize - 1, 'WITHSCORES'),
    corrections = redis.call('LRANGE', prefix .. 'corr:' .. topic, 0, -1),
  }
  table.insert(result, entry)
end

return cjson.encode(result)
