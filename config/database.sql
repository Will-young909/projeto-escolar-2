-- ============================================================
-- Script de criacao do banco de dados - Regimath
-- ============================================================

CREATE DATABASE IF NOT EXISTS regimath
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE regimath;

-- ------------------------------------------------------------
-- Tabela: alunos
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alunos (
  id         INT            AUTO_INCREMENT PRIMARY KEY,
  nome       VARCHAR(150)   NOT NULL,
  email      VARCHAR(255)   NOT NULL UNIQUE,
  senha      VARCHAR(255)   NOT NULL,
  criado_em  DATETIME       DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Tabela: professores
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS professores (
  id              INT            AUTO_INCREMENT PRIMARY KEY,
  nome            VARCHAR(150)   NOT NULL,
  email           VARCHAR(255)   NOT NULL UNIQUE,
  senha           VARCHAR(255)   NOT NULL,
  foto            VARCHAR(500)   DEFAULT '/imagens/imagem_perfil.jpg',
  descricao       TEXT,
  link_previa     VARCHAR(500)   DEFAULT '',
  status          ENUM('disponivel','indisponivel') DEFAULT 'disponivel',
  criado_em       DATETIME       DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Tabela: disciplinas  (relacionamento N:N com professores)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS disciplinas (
  id            INT            AUTO_INCREMENT PRIMARY KEY,
  professor_id  INT            NOT NULL,
  nome          VARCHAR(200)   NOT NULL,
  FOREIGN KEY (professor_id) REFERENCES professores(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Tabela: horarios_disponiveis
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS horarios_disponiveis (
  id            INT            AUTO_INCREMENT PRIMARY KEY,
  professor_id  INT            NOT NULL,
  data          DATE           NOT NULL,
  hora_inicio   TIME           NOT NULL,
  hora_fim      TIME           NOT NULL,
  preco         DECIMAL(10,2)  NOT NULL DEFAULT 50.00,
  status        ENUM('disponivel','agendado','cancelado') DEFAULT 'disponivel',
  aluno_id      INT            DEFAULT NULL,
  criado_em     DATETIME       DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (professor_id) REFERENCES professores(id) ON DELETE CASCADE,
  FOREIGN KEY (aluno_id)     REFERENCES alunos(id)      ON DELETE SET NULL
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Tabela: agendamentos
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agendamentos (
  id            INT            AUTO_INCREMENT PRIMARY KEY,
  aluno_id      INT            NOT NULL,
  professor_id  INT            NOT NULL,
  horario_id    INT            NOT NULL,
  sala_id       VARCHAR(100),
  data          DATE           NOT NULL,
  hora          TIME           NOT NULL,
  status        ENUM('ativo','cancelado','concluido') DEFAULT 'ativo',
  criado_em     DATETIME       DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (aluno_id)     REFERENCES alunos(id)                ON DELETE CASCADE,
  FOREIGN KEY (professor_id) REFERENCES professores(id)           ON DELETE CASCADE,
  FOREIGN KEY (horario_id)   REFERENCES horarios_disponiveis(id)  ON DELETE CASCADE
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Tabela: atividades
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS atividades (
  id            INT            AUTO_INCREMENT PRIMARY KEY,
  professor_id  INT            NOT NULL,
  titulo        VARCHAR(300)   NOT NULL,
  descricao     TEXT,
  criado_em     DATETIME       DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (professor_id) REFERENCES professores(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Tabela: questoes  (pertence a uma atividade)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS questoes (
  id            INT            AUTO_INCREMENT PRIMARY KEY,
  atividade_id  INT            NOT NULL,
  enunciado     TEXT           NOT NULL,
  alternativa_a VARCHAR(500),
  alternativa_b VARCHAR(500),
  alternativa_c VARCHAR(500),
  alternativa_d VARCHAR(500),
  resposta      CHAR(1),
  FOREIGN KEY (atividade_id) REFERENCES atividades(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Tabela: mensagens_chat
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mensagens_chat (
  id         INT            AUTO_INCREMENT PRIMARY KEY,
  sala       VARCHAR(200)   NOT NULL,
  user_id    INT            NOT NULL,
  user_nome  VARCHAR(150)   NOT NULL,
  texto      TEXT           NOT NULL,
  enviado_em BIGINT         NOT NULL
) ENGINE=InnoDB;

CREATE INDEX idx_mensagens_sala ON mensagens_chat(sala);

-- ------------------------------------------------------------
-- Tabela: comentarios  (avaliacoes de professores)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS comentarios (
  id            INT            AUTO_INCREMENT PRIMARY KEY,
  professor_id  INT            NOT NULL,
  usuario_nome  VARCHAR(150)   NOT NULL,
  texto         TEXT           NOT NULL,
  nota          TINYINT        DEFAULT NULL,
  criado_em     DATETIME       DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (professor_id) REFERENCES professores(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Tabela: denuncias
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS denuncias (
  id          INT            AUTO_INCREMENT PRIMARY KEY,
  tipo        VARCHAR(100)   NOT NULL,
  titulo      VARCHAR(300)   NOT NULL,
  descricao   TEXT           NOT NULL,
  email       VARCHAR(255)   DEFAULT NULL,
  evidencia   VARCHAR(500)   DEFAULT NULL,
  anonimo     TINYINT(1)     DEFAULT 0,
  criado_em   DATETIME       DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Tabela: pagamentos
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pagamentos (
  id              INT            AUTO_INCREMENT PRIMARY KEY,
  preference_id   VARCHAR(200)   DEFAULT NULL,
  sala            VARCHAR(200)   DEFAULT NULL,
  descricao       VARCHAR(300)   DEFAULT NULL,
  valor           DECIMAL(10,2)  NOT NULL DEFAULT 0,
  criado_por      INT            DEFAULT NULL,
  status          VARCHAR(50)    DEFAULT 'pending',
  payment_id      VARCHAR(200)   DEFAULT NULL,
  criado_em       DATETIME       DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Tabela: notificacoes
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notificacoes (
  id            INT            AUTO_INCREMENT PRIMARY KEY,
  usuario_id    INT            NOT NULL,
  usuario_tipo  ENUM('aluno','professor') NOT NULL,
  tipo          VARCHAR(100)   NOT NULL,
  mensagem      TEXT           NOT NULL,
  lida          TINYINT(1)     DEFAULT 0,
  criado_em     DATETIME       DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE INDEX idx_notif_usuario ON notificacoes(usuario_id, usuario_tipo);
