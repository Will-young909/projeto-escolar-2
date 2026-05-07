-- ============================================================
-- Script de criacao do banco de dados - Regimath (CORRIGIDO)
-- ============================================================

CREATE DATABASE IF NOT EXISTS b3yigwtafba02ntosynz
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE b3yigwtafba02ntosynz;

-- ------------------------------------------------------------
-- Tabela: alunos (ID corrigido para VARCHAR)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alunos (
  id         VARCHAR(255)   NOT NULL PRIMARY KEY,
  nome       VARCHAR(150)   NOT NULL,
  email      VARCHAR(255)   NOT NULL UNIQUE,
  senha      VARCHAR(255)   NOT NULL,
  criado_em  DATETIME       DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Tabela: professores (ID corrigido para VARCHAR)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS professores (
  id              VARCHAR(255)   NOT NULL PRIMARY KEY,
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
-- Tabela: disciplinas (ID do professor corrigido)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS disciplinas (
  id            INT            AUTO_INCREMENT PRIMARY KEY,
  professor_id  VARCHAR(255)   NOT NULL,
  nome          VARCHAR(200)   NOT NULL,
  FOREIGN KEY (professor_id) REFERENCES professores(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Tabela: horarios_disponiveis (IDs corrigidos)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS horarios_disponiveis (
  id            INT            AUTO_INCREMENT PRIMARY KEY,
  professor_id  VARCHAR(255)   NOT NULL,
  data          DATE           NOT NULL,
  hora_inicio   TIME           NOT NULL,
  hora_fim      TIME           NOT NULL,
  preco         DECIMAL(10,2)  NOT NULL DEFAULT 50.00,
  status        ENUM('disponivel','agendado','cancelado') DEFAULT 'disponivel',
  aluno_id      VARCHAR(255)   DEFAULT NULL,
  criado_em     DATETIME       DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (professor_id) REFERENCES professores(id) ON DELETE CASCADE,
  FOREIGN KEY (aluno_id)     REFERENCES alunos(id)      ON DELETE SET NULL
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Tabela: agendamentos (IDs corrigidos)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agendamentos (
  id            INT            AUTO_INCREMENT PRIMARY KEY,
  aluno_id      VARCHAR(255)   NOT NULL,
  professor_id  VARCHAR(255)   NOT NULL,
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
-- Tabela: atividades (ID da atividade e professor corrigidos)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS atividades (
  id            VARCHAR(255)   NOT NULL PRIMARY KEY,
  professor_id  VARCHAR(255)   NULL, -- Pode ser nulo para testes de nivelamento
  titulo        VARCHAR(300)   NOT NULL,
  descricao     TEXT,
  criado_em     DATETIME       DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (professor_id) REFERENCES professores(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Tabela: questoes (ID da atividade corrigido)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS questoes (
  id            INT            AUTO_INCREMENT PRIMARY KEY,
  atividade_id  VARCHAR(255)   NOT NULL,
  enunciado     TEXT           NOT NULL,
  alternativa_a VARCHAR(500),
  alternativa_b VARCHAR(500),
  alternativa_c VARCHAR(500),
  alternativa_d VARCHAR(500),
  resposta      CHAR(1),
  habilidade    VARCHAR(120)   NULL,
  dificuldade   ENUM('facil','medio','dificil') DEFAULT 'facil',
  FOREIGN KEY (atividade_id) REFERENCES atividades(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Tabela: mensagens_chat (ID do usuário corrigido)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mensagens_chat (
  id         INT            AUTO_INCREMENT PRIMARY KEY,
  sala       VARCHAR(200)   NOT NULL,
  user_id    VARCHAR(255)   NOT NULL,
  user_nome  VARCHAR(150)   NOT NULL,
  texto      TEXT           NOT NULL,
  enviado_em BIGINT         NOT NULL
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Tabela: comentarios (ID do professor corrigido)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS comentarios (
  id            INT            AUTO_INCREMENT PRIMARY KEY,
  professor_id  VARCHAR(255)   NOT NULL,
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
-- Tabela: pagamentos (ID criado_por corrigido)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pagamentos (
  id              INT            AUTO_INCREMENT PRIMARY KEY,
  preference_id   VARCHAR(200)   DEFAULT NULL,
  sala            VARCHAR(200)   DEFAULT NULL,
  descricao       VARCHAR(300)   DEFAULT NULL,
  valor           DECIMAL(10,2)  NOT NULL DEFAULT 0,
  criado_por      VARCHAR(255)   DEFAULT NULL,
  status          VARCHAR(50)    DEFAULT 'pending',
  payment_id      VARCHAR(200)   DEFAULT NULL,
  criado_em       DATETIME       DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Tabela: notificacoes (ID do usuário corrigido)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notificacoes (
  id            INT            AUTO_INCREMENT PRIMARY KEY,
  usuario_id    VARCHAR(255)   NOT NULL,
  usuario_tipo  ENUM('aluno','professor') NOT NULL,
  tipo          VARCHAR(100)   NOT NULL,
  mensagem      TEXT           NOT NULL,
  lida          TINYINT(1)     DEFAULT 0,
  criado_em     DATETIME       DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ============================================================
-- Schema da Trilha Adaptativa (Corrigido)
-- ============================================================

-- ------------------------------------------------------------
-- Tabela: tentativas_teste (IDs corrigidos)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tentativas_teste (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  aluno_id          VARCHAR(255)   NOT NULL,
  atividade_id      VARCHAR(255)   NULL,
  tipo              ENUM('diagnostico','checkpoint') NOT NULL DEFAULT 'diagnostico',
  pontuacao_total   DECIMAL(5,2)   NOT NULL DEFAULT 0,
  total_questoes    INT            NOT NULL DEFAULT 0,
  criado_em         DATETIME       DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (aluno_id) REFERENCES alunos(id) ON DELETE CASCADE,
  FOREIGN KEY (atividade_id) REFERENCES atividades(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Tabela: respostas_teste (ID da questão corrigido)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS respostas_teste (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  tentativa_id      INT NOT NULL,
  questao_id        INT NOT NULL, -- Mantido como INT, pois se refere ao `questoes.id` que é INT
  resposta_marcada  CHAR(1) NULL,
  acertou           TINYINT(1) NOT NULL DEFAULT 0,
  habilidade        VARCHAR(120) NULL,
  dificuldade       ENUM('facil','medio','dificil') DEFAULT 'facil',
  criado_em         DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tentativa_id) REFERENCES tentativas_teste(id) ON DELETE CASCADE,
  FOREIGN KEY (questao_id) REFERENCES questoes(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Tabela: resultado_habilidade (ID do aluno corrigido)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS resultado_habilidade (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  tentativa_id      INT NOT NULL,
  aluno_id          VARCHAR(255) NOT NULL,
  habilidade        VARCHAR(120) NOT NULL,
  acertos           INT NOT NULL DEFAULT 0,
  erros             INT NOT NULL DEFAULT 0,
  percentual        DECIMAL(5,2) NOT NULL DEFAULT 0,
  nivel             ENUM('reforco','pratica','avanco') NOT NULL,
  criado_em         DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tentativa_id) REFERENCES tentativas_teste(id) ON DELETE CASCADE,
  FOREIGN KEY (aluno_id) REFERENCES alunos(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Tabela: trilhas (ID do aluno corrigido)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trilhas (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  aluno_id            VARCHAR(255) NOT NULL,
  tentativa_origem_id INT NOT NULL,
  status              ENUM('ativa','concluida','cancelada') DEFAULT 'ativa',
  criado_em           DATETIME DEFAULT CURRENT_TIMESTAMP,
  atualizado_em       DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (aluno_id) REFERENCES alunos(id) ON DELETE CASCADE,
  FOREIGN KEY (tentativa_origem_id) REFERENCES tentativas_teste(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- Tabela: trilha_itens (ID da questão corrigido)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trilha_itens (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  trilha_id         INT NOT NULL,
  ordem             INT NOT NULL,
  questao_id        INT NOT NULL, -- Mantido como INT, pois se refere ao `questoes.id` que é INT
  habilidade        VARCHAR(120) NOT NULL,
  dificuldade       ENUM('facil','medio','dificil') NOT NULL,
  bloco             ENUM('revisao','pratica','checkpoint') DEFAULT 'pratica',
  status            ENUM('pendente','concluido','erro') DEFAULT 'pendente',
  resposta_aluno    TEXT NULL,
  acertou           TINYINT(1) NULL,
  criado_em         DATETIME DEFAULT CURRENT_TIMESTAMP,
  concluido_em      DATETIME NULL,
  FOREIGN KEY (trilha_id) REFERENCES trilhas(id) ON DELETE CASCADE,
  FOREIGN KEY (questao_id) REFERENCES questoes(id) ON DELETE CASCADE,
  UNIQUE KEY uk_trilha_ordem (trilha_id, ordem)
) ENGINE=InnoDB;
