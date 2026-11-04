-- Contador por ventana fija y por credencial. INCR y PEXPIRE van juntos: si fueran comandos
-- separados, una caída entre ambos dejaría un contador sin expiración que bloquea para siempre.
--
-- KEYS: 1 contador | ARGV: 1 ventana (ms)
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return { count, redis.call('PTTL', KEYS[1]) }
