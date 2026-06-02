-- Tabla de tokens ML por usuario
CREATE TABLE ml_tokens (
  user_id       TEXT PRIMARY KEY,
  access_token  TEXT NOT NULL,
  refresh_token TEXT,
  expires_at    TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Tabla de ventas
CREATE TABLE ventas (
  id            BIGSERIAL PRIMARY KEY,
  nro_venta     TEXT UNIQUE NOT NULL,
  user_id       TEXT NOT NULL,
  fecha         TIMESTAMPTZ,
  sku           TEXT,
  titulo        TEXT,
  unidades      INT DEFAULT 1,
  precio        NUMERIC,
  comision      NUMERIC DEFAULT 0,
  costo_envio   NUMERIC DEFAULT 0,
  logistic_type TEXT,
  provincia     TEXT,
  estado        TEXT,
  con_cuotas    BOOLEAN DEFAULT FALSE,
  pack_id       TEXT,
  raw           JSONB,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Índices para consultas rápidas
CREATE INDEX idx_ventas_user_fecha ON ventas(user_id, fecha DESC);
CREATE INDEX idx_ventas_sku ON ventas(sku);
CREATE INDEX idx_ventas_estado ON ventas(estado);

-- Habilitar Row Level Security
ALTER TABLE ml_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE ventas ENABLE ROW LEVEL SECURITY;

-- Políticas: el service key puede todo
CREATE POLICY "Service key full access tokens" ON ml_tokens USING (true);
CREATE POLICY "Service key full access ventas" ON ventas USING (true);
