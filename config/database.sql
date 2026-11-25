-- ============================================================
-- REGIMATH - DATABASE SCHEMA PROFISSIONAL
-- ============================================================
-- Banco de dados para:
-- • Plataforma educacional adaptativa
-- • Gamificação
-- • Trilha inteligente
-- • Revisão espaçada
-- • Proficiência por habilidade
-- • Pré-requisitos conceituais
-- ============================================================

CREATE DATABASE IF NOT EXISTS b1lixrtur5vjhqxxowvt
CHARACTER SET utf8mb4
COLLATE utf8mb4_unicode_ci;

USE b1lixrtur5vjhqxxowvt;

-- ============================================================
-- CONFIGURAÇÕES
-- ============================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ============================================================
-- TABELA: ADMINS
-- ============================================================

CREATE TABLE IF NOT EXISTS admins (
    id                      VARCHAR(255) PRIMARY KEY,
    nome                    VARCHAR(150) NOT NULL,
    email                   VARCHAR(255) NOT NULL UNIQUE,
    senha                   CHAR(60) NOT NULL,
    role                    ENUM('admin', 'superadmin') NOT NULL DEFAULT 'admin',
    criado_em               TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em           TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;


-- ============================================================
-- TABELA: ALUNOS
-- ============================================================

CREATE TABLE alunos (
    id                      VARCHAR(255) PRIMARY KEY,
    nome                    VARCHAR(150) NOT NULL,
    email                   VARCHAR(255) NOT NULL UNIQUE,
    senha                   CHAR(60) NOT NULL,
    status                  ENUM('ativo', 'suspenso', 'banido') NOT NULL DEFAULT 'ativo',
    suspenso_ate            TIMESTAMP NULL DEFAULT NULL,
    foto_perfil             LONGTEXT,

    xp_total                INT NOT NULL DEFAULT 0,
    nivel                   INT NOT NULL DEFAULT 1,

    streak_atual            INT NOT NULL DEFAULT 0,
    streak_acertos          INT NOT NULL DEFAULT 0,

    ultima_atividade_em     DATETIME NULL,

    criado_em               TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em           TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                                ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE passes_estudo (
    id INT AUTO_INCREMENT PRIMARY KEY,
    aluno_id VARCHAR(255) NOT NULL,
    tipo ENUM('quantidade', 'diario', 'semanal') NOT NULL,
    atividades_restantes INT DEFAULT NULL,
    data_compra TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    data_validade TIMESTAMP NULL DEFAULT NULL,
    FOREIGN KEY (aluno_id) REFERENCES alunos(id)
);


-- ============================================================
-- TABELA: PROFESSORES
-- ============================================================

CREATE TABLE professores (
    id                      VARCHAR(255) PRIMARY KEY,
    nome                    VARCHAR(150) NOT NULL,
    email                   VARCHAR(255) NOT NULL UNIQUE,
    senha                   CHAR(60) NOT NULL,
    foto                    LONGTEXT,
    foto_perfil             LONGTEXT,
    
    descricao               TEXT,
    link_previa             VARCHAR(500) DEFAULT '',
    previa_arquivo          VARCHAR(500) DEFAULT NULL,
    status                  ENUM(
                                'disponivel',
                                'indisponivel'
                             ) DEFAULT 'disponivel',
    aprovacao_status        ENUM('pending', 'approved', 'rejected', 'suspended', 'banned') NOT NULL DEFAULT 'pending',
    aprovado_por            VARCHAR(255) NULL,
    aprovado_em             TIMESTAMP NULL,
    suspenso_ate            TIMESTAMP NULL DEFAULT NULL,
    motivo_reprovacao       TEXT NULL,

    -- Perfil profissional (preenchido pelo professor após o cadastro)
    perfil_enviado_em       TIMESTAMP NULL DEFAULT NULL,
    formacao                ENUM('estudante_universitario', 'graduado', 'pos_graduado', 'mestre') NULL,
    comprovante_formacao    LONGTEXT NULL,
    pagamentos_bloqueados   BOOLEAN DEFAULT FALSE,
    criado_em               TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em           TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                                ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_prof_aprovado_por FOREIGN KEY (aprovado_por) REFERENCES admins(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  user_type ENUM('aluno', 'professor') NOT NULL,
  token_hash VARCHAR(255) NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- TABELA: DISCIPLINAS
-- ============================================================

CREATE TABLE disciplinas (
    id                      INT AUTO_INCREMENT PRIMARY KEY,
    professor_id            VARCHAR(255) NOT NULL,

    nome                    VARCHAR(200) NOT NULL,

    criado_em               TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_disciplina_professor
        FOREIGN KEY (professor_id)
        REFERENCES professores(id)
        ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- TABELA: HORÁRIOS DISPONÍVEIS
-- ============================================================

CREATE TABLE horarios_disponiveis (
    id                      INT AUTO_INCREMENT PRIMARY KEY,

    professor_id            VARCHAR(255) NOT NULL,
    aluno_id                VARCHAR(255) NULL,

    data                    DATE NOT NULL,

    hora_inicio             TIME NOT NULL,
    hora_fim                TIME NOT NULL,

    preco                   DECIMAL(10,2)
                                NOT NULL DEFAULT 50.00,

    status                  ENUM(
                                'disponivel',
                                'agendado',
                                'cancelado'
                             ) DEFAULT 'disponivel',

    criado_em               TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_horario_professor
        FOREIGN KEY (professor_id)
        REFERENCES professores(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_horario_aluno
        FOREIGN KEY (aluno_id)
        REFERENCES alunos(id)
        ON DELETE SET NULL
) ENGINE=InnoDB;

-- ============================================================
-- TABELA: AGENDAMENTOS
-- ============================================================

CREATE TABLE agendamentos (
    id                      INT AUTO_INCREMENT PRIMARY KEY,
    aluno_id                VARCHAR(255) NOT NULL,
    professor_id            VARCHAR(255) NOT NULL,
    horario_id              INT NOT NULL,
    sala_id                 VARCHAR(100),
    gravacao_url            VARCHAR(500) NULL,

    -- Metadados de gravação (20260911000000_add_recording_metadata.js)
    gravacao_status         ENUM(
                                    'processando',
                                    'disponivel',
                                    'falhou',
                                    'indisponivel'
                                ) NULL,
    gravacao_path           VARCHAR(500) NULL,
    gravacao_duracao        INT NULL,
    gravacao_tamanho        BIGINT NULL,
    data                    DATE NOT NULL,
    hora                    TIME NOT NULL,
    no_show                 BOOLEAN DEFAULT FALSE,
    status                  ENUM(
                                'ativo',
                                'cancelado',
                                'concluido'
                             ) DEFAULT 'ativo',
    criado_em               TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    data_cancelamento       TIMESTAMP NULL,
    motivo_cancelamento     TEXT NULL,
    aluno_entrou_em         TIMESTAMP NULL,
    aluno_saiu_em           TIMESTAMP NULL,
    professor_entrou_em     TIMESTAMP NULL,
    professor_saiu_em       TIMESTAMP NULL,
    CONSTRAINT fk_agendamento_aluno
        FOREIGN KEY (aluno_id)
        REFERENCES alunos(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_agendamento_professor
        FOREIGN KEY (professor_id)
        REFERENCES professores(id)
        ON DELETE CASCADE,
    CONSTRAINT fk_agendamento_horario
        FOREIGN KEY (horario_id)
        REFERENCES horarios_disponiveis(id)
        ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE recomendacao_eventos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  aluno_id VARCHAR(255) NOT NULL,
  professor_id VARCHAR(255) NOT NULL,
  tentativa_id INT NULL,
  posicao TINYINT NULL,
  score INT NULL,
  evento ENUM('impressao', 'clique', 'contato', 'agendamento_criado') NOT NULL,
  origem VARCHAR(30) DEFAULT 'recomendados',
  criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_aluno_prof (aluno_id, professor_id),
  INDEX idx_evento_data (evento, criado_em)
);


-- ============================================================
-- TABELA: ATIVIDADES
-- ============================================================

CREATE TABLE atividades (
    id                      VARCHAR(255) PRIMARY KEY,

    professor_id            VARCHAR(255) NULL,

    titulo                  VARCHAR(300) NOT NULL,
    descricao               TEXT,

    criado_em               TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em           TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                                ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_atividade_professor
        FOREIGN KEY (professor_id)
        REFERENCES professores(id)
        ON DELETE SET NULL
) ENGINE=InnoDB;

-- ============================================================
-- TABELA: HABILIDADES
-- ============================================================

CREATE TABLE habilidades (
    id                      INT AUTO_INCREMENT PRIMARY KEY,

    codigo                  VARCHAR(200) NOT NULL UNIQUE,
    descricao               TEXT NOT NULL,

    ano_escolar             INT,

    criado_em               TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ============================================================
-- TABELA: PRÉ-REQUISITOS ENTRE HABILIDADES
-- ============================================================

CREATE TABLE habilidade_prerequisitos (
    habilidade_id           INT NOT NULL,
    prerequisito_id         INT NOT NULL,

    PRIMARY KEY (
        habilidade_id,
        prerequisito_id
    ),

    CONSTRAINT fk_habilidade_principal
        FOREIGN KEY (habilidade_id)
        REFERENCES habilidades(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_habilidade_prerequisito
        FOREIGN KEY (prerequisito_id)
        REFERENCES habilidades(id)
        ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- TABELA: QUESTÕES
-- ============================================================

CREATE TABLE questoes (
    id                          INT AUTO_INCREMENT PRIMARY KEY,

    atividade_id               VARCHAR(255) NOT NULL,
    habilidade_id              INT NULL,

    enunciado                  TEXT NOT NULL,

    alternativa_a              VARCHAR(500),
    alternativa_b              VARCHAR(500),
    alternativa_c              VARCHAR(500),
    alternativa_d              VARCHAR(500),

    distrator_a                VARCHAR(255) NULL
                                   COMMENT 'Erro comum da alternativa A',

    distrator_b                VARCHAR(255) NULL
                                   COMMENT 'Erro comum da alternativa B',

    distrator_c                VARCHAR(255) NULL
                                   COMMENT 'Erro comum da alternativa C',

    distrator_d                VARCHAR(255) NULL
                                   COMMENT 'Erro comum da alternativa D',

    resposta                   VARCHAR(255) NOT NULL,

    dificuldade                ENUM(
                                    'facil',
                                    'medio',
                                    'dificil'
                                ) NOT NULL DEFAULT 'facil',

    tempo_esperado_seg         INT NULL,

    explicacao                 TEXT NULL,

    criado_em                  TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,

    -- Metadados pedagógicos e validação de conteúdo (trilha adaptativa)
    status_validacao          VARCHAR(20) NOT NULL DEFAULT 'aprovado',
    objetivo_pedagogico        VARCHAR(255) NULL,
    formato                    VARCHAR(30) NULL,
    dificuldade_calibrada      DECIMAL(4,2) NULL,
    competencia_cognitiva     VARCHAR(60) NULL,
    origem                    VARCHAR(20) NULL,
    versao                    INT NOT NULL DEFAULT 1,
    numero_aplicacoes          INT NOT NULL DEFAULT 0,


    CONSTRAINT fk_questao_atividade
        FOREIGN KEY (atividade_id)
        REFERENCES atividades(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_questao_habilidade
        FOREIGN KEY (habilidade_id)
        REFERENCES habilidades(id)
        ON DELETE SET NULL
) ENGINE=InnoDB;
-- ============================================================
-- TABELA: SESSÕES ADAPTATIVAS
-- ============================================================

CREATE TABLE sessoes_adaptativas (
    id                          INT AUTO_INCREMENT PRIMARY KEY,

    aluno_id                    VARCHAR(255) NOT NULL,

    habilidade_foco_id          INT NULL,

    tipo_sessao                 ENUM(
                                    'avaliacao',
                                    'pratica',
                                    'reforco',
                                    'desafio'
                                ) NOT NULL,

    status                      ENUM(
                                    'ativa',
                                    'concluida',
                                    'pausada',
                                    'abandonada'
                                ) NOT NULL DEFAULT 'ativa',

    criado_em                   TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,

    -- Ciclo de vida e rastreabilidade da sessão
    ultima_atividade_em         TIMESTAMP NULL,
    pausada_em                  TIMESTAMP NULL,
    retomada_em                 TIMESTAMP NULL,
    objetivo                    VARCHAR(255) NULL,
    contexto_json               JSON NULL,
    status_termino              VARCHAR(120) NULL,
    inicio_em                   TIMESTAMP NULL,
    fim_em                      TIMESTAMP NULL,

    CONSTRAINT fk_sessao_aluno
        FOREIGN KEY (aluno_id)
        REFERENCES alunos(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_sessao_habilidade
        FOREIGN KEY (habilidade_foco_id)
        REFERENCES habilidades(id)
        ON DELETE SET NULL
) ENGINE=InnoDB;

-- ============================================================
-- TABELA: TENTATIVAS DE TESTE
-- ============================================================

CREATE TABLE IF NOT EXISTS tentativas_teste (
    id                          INT AUTO_INCREMENT PRIMARY KEY,

    aluno_id                    VARCHAR(255) NOT NULL,
    atividade_id                VARCHAR(255) NULL,

    tipo                        ENUM(
                                    'diagnostico',
                                    'checkpoint'
                                ) DEFAULT 'diagnostico',

    pontuacao_total             DECIMAL(5,2)
                                    NOT NULL DEFAULT 0,

    total_questoes              INT
                                    NOT NULL DEFAULT 0,

    acertos                     INT
                                    NOT NULL DEFAULT 0,

    erros                       INT
                                    NOT NULL DEFAULT 0,
    data_conclusao              TIMESTAMP,
    trilha_gerada               BOOLEAN NOT NULL DEFAULT FALSE,
    usou_passe                  BOOLEAN NOT NULL DEFAULT FALSE,

    criado_em                   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_tentativa_aluno
        FOREIGN KEY (aluno_id)
        REFERENCES alunos(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_tentativa_atividade
        FOREIGN KEY (atividade_id)
        REFERENCES atividades(id)
        ON DELETE SET NULL
) ENGINE=InnoDB;

-- ============================================================
-- TABELA: RESPOSTAS DE TESTE
-- ============================================================

CREATE TABLE respostas_teste (
    id                          INT AUTO_INCREMENT PRIMARY KEY,

    tentativa_id                INT NOT NULL,
    questao_id                  INT NOT NULL,

    resposta_marcada            VARCHAR(500),

    acertou                     BOOLEAN
                                    NOT NULL DEFAULT FALSE,

    criado_em                   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_resposta_tentativa
        FOREIGN KEY (tentativa_id)
        REFERENCES tentativas_teste(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_resposta_questao
        FOREIGN KEY (questao_id)
        REFERENCES questoes(id)
        ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- TABELA: RESULTADO POR HABILIDADE
-- ============================================================

CREATE TABLE resultado_habilidade (
    id                          INT AUTO_INCREMENT PRIMARY KEY,

    tentativa_id                INT NOT NULL,
    aluno_id                    VARCHAR(255) NOT NULL,
    habilidade_id               INT NOT NULL,

    acertos                     INT NOT NULL DEFAULT 0,
    erros                       INT NOT NULL DEFAULT 0,

    percentual                  DECIMAL(5,2)
                                    NOT NULL DEFAULT 0,

    nivel                       ENUM(
                                    'reforco',
                                    'pratica',
                                    'avanco'
                                ) NOT NULL,

    criado_em                   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_resultado_tentativa
        FOREIGN KEY (tentativa_id)
        REFERENCES tentativas_teste(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_resultado_aluno
        FOREIGN KEY (aluno_id)
        REFERENCES alunos(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_resultado_habilidade
        FOREIGN KEY (habilidade_id)
        REFERENCES habilidades(id)
        ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- TABELA: TRILHAS
-- ============================================================

CREATE TABLE trilhas (
    id                              INT AUTO_INCREMENT PRIMARY KEY,

    aluno_id                        VARCHAR(255) NOT NULL,
    tentativa_origem_id             INT NULL,
    nome                            VARCHAR(300) NULL,

    tipo                            ENUM(
                                        'diagnostico',
                                        'reforco',
                                        'aprendizagem',
                                        'pratica',
                                        'revisao',
                                        'dominio'
                                    ) NOT NULL DEFAULT 'diagnostico',

    pontuacao_diagnostico           DECIMAL(5,2),
    habilidade_atual_id             INT NULL,

    status                          ENUM(
                                        'ativa',
                                        'concluida',
                                        'cancelada'
                                    ) DEFAULT 'ativa',

    criado_em                       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    atualizado_em                   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                                        ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_trilha_aluno
        FOREIGN KEY (aluno_id)
        REFERENCES alunos(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_trilha_tentativa
        FOREIGN KEY (tentativa_origem_id)
        REFERENCES tentativas_teste(id)
        ON DELETE SET NULL,

    CONSTRAINT fk_trilha_habilidade_atual
        FOREIGN KEY (habilidade_atual_id)
        REFERENCES habilidades(id)
        ON DELETE SET NULL
) ENGINE=InnoDB;

-- ============================================================
-- TABELA: ITENS DA TRILHA
-- ============================================================

CREATE TABLE trilha_itens (
    id                          INT AUTO_INCREMENT PRIMARY KEY,

    sessao_id                   INT NOT NULL,
    trilha_id                   INT NOT NULL,

    ordem                       INT NOT NULL,

    questao_id                  INT,

    -- Metadados da atividade (20260829_add_activity_state.js)
    atividade_tipo              VARCHAR(120) NULL,
    meta_json                   JSON NULL,

    bloco                       ENUM(
                                    'revisao',
                                    'pratica',
                                    'checkpoint',
                                    'diagnostico',
                                    'aprendizagem',
                                    'reforco',
                                    'dominio',
                                    'microcheck'
                                ) NOT NULL DEFAULT 'pratica',

    status                      ENUM(
                                    'pendente',
                                    'concluido',
                                    'erro'
                                ) DEFAULT 'pendente',

    resposta_aluno              TEXT NULL,
    acertou                     BOOLEAN NULL,
    tentativa                   INT NOT NULL DEFAULT 1,
    decisao_motor               VARCHAR(80) NULL,

    criado_em                   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    concluido_em                TIMESTAMP NULL,

    CONSTRAINT fk_item_sessao
        FOREIGN KEY (sessao_id)
        REFERENCES sessoes_adaptativas(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_item_trilha
        FOREIGN KEY (trilha_id)
        REFERENCES trilhas(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_item_questao
        FOREIGN KEY (questao_id)
        REFERENCES questoes(id)
        ON DELETE CASCADE,

    UNIQUE KEY uk_trilha_ordem (
        trilha_id,
        ordem
    )
) ENGINE=InnoDB;

-- ============================================================
-- TABELA: PROFICIÊNCIA DO ALUNO
-- ============================================================

CREATE TABLE usuario_habilidades (
    id                                  INT AUTO_INCREMENT PRIMARY KEY,

    aluno_id                            VARCHAR(255) NOT NULL,
    habilidade_id                       INT NOT NULL,

    percentual_dominio                  DECIMAL(5,2)
                                            DEFAULT 0.00,

    status_dominio                      ENUM(
                                            'nao_iniciado',
                                            'em_progresso',
                                            'dominado',
                                            'reforco',
                                            'precisa_reforco',
                                            'em_desenvolvimento',
                                            'proficiente',
                                            'dominada'
                                        ) NOT NULL DEFAULT 'nao_iniciado',

    respostas_consistentes_acerto       INT DEFAULT 0,
    n_tentativas                        INT NOT NULL DEFAULT 0,
    n_acertos_consecutivos             INT NOT NULL DEFAULT 0,
    n_erros_consecutivos                INT NOT NULL DEFAULT 0,

    -- Perfil probabilístico de domínio
    probabilidade_dominio               DECIMAL(6,4) NULL,
    incerteza                           DECIMAL(6,4) NULL,
    tendencia                           VARCHAR(30) NULL,
    risco_esquecimento                  DECIMAL(6,4) NULL,
    ultima_resposta_em                  TIMESTAMP NULL,

    ultima_vez_praticado                TIMESTAMP NULL,

    criado_em                           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    atualizado_em                       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                                            ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY uk_aluno_habilidade (
        aluno_id,
        habilidade_id
    ),

    INDEX idx_usuario_habilidades_aluno (aluno_id),

    CONSTRAINT fk_usuario_habilidade_aluno
        FOREIGN KEY (aluno_id)
        REFERENCES alunos(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_usuario_habilidade
        FOREIGN KEY (habilidade_id)
        REFERENCES habilidades(id)
        ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- TABELA: HISTÓRICO DE QUESTÕES
-- ============================================================

CREATE TABLE historico_questoes (
    id                              INT AUTO_INCREMENT PRIMARY KEY,

    aluno_id                        VARCHAR(255) NOT NULL,
    questao_id                      INT NOT NULL,
    habilidade_id                   INT NOT NULL,

    resposta_dada                   VARCHAR(255),

    acertou                         BOOLEAN NOT NULL,

    tempo_resposta_seg              INT NULL,

    data_resposta                   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_historico_aluno
        FOREIGN KEY (aluno_id)
        REFERENCES alunos(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_historico_questao
        FOREIGN KEY (questao_id)
        REFERENCES questoes(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_historico_habilidade
        FOREIGN KEY (habilidade_id)
        REFERENCES habilidades(id)
        ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- TABELA: REVISÃO ESPAÇADA
-- ============================================================

CREATE TABLE revisao_agendada (
    id                              INT AUTO_INCREMENT PRIMARY KEY,

    aluno_id                        VARCHAR(255) NOT NULL,
    questao_id                      INT NOT NULL,

    data_revisao                    DATE NOT NULL,

    fator_facilidade                DECIMAL(4,2)
                                        NOT NULL DEFAULT 2.50,

    intervalo_dias                  INT NOT NULL DEFAULT 1,

    criado_em                       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    atualizado_em                   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                                        ON UPDATE CURRENT_TIMESTAMP,

    ultima_apresentacao_em          TIMESTAMP NULL,
    n_apresentacoes                 INT NOT NULL DEFAULT 0,

    UNIQUE KEY uk_revisao_aluno_questao (
        aluno_id,
        questao_id
    ),

    CONSTRAINT fk_revisao_aluno
        FOREIGN KEY (aluno_id)
        REFERENCES alunos(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_revisao_questao
        FOREIGN KEY (questao_id)
        REFERENCES questoes(id)
        ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- TABELA: PRÉ-REQUISITOS CONCEITUAIS
-- ============================================================

CREATE TABLE prerequisitos (
    id                              INT AUTO_INCREMENT PRIMARY KEY,

    nome                            VARCHAR(150)
                                        NOT NULL UNIQUE,

    descricao                       TEXT NULL
) ENGINE=InnoDB;

-- ============================================================
-- RELAÇÃO: QUESTÕES ↔ PRÉ-REQUISITOS
-- ============================================================

CREATE TABLE questoes_prerequisitos (
    id                              INT AUTO_INCREMENT PRIMARY KEY,

    questao_id                      INT NOT NULL,
    prerequisito_id                 INT NOT NULL,

    peso                            DECIMAL(3,2)
                                        NOT NULL DEFAULT 1.00,

    CONSTRAINT fk_qp_questao
        FOREIGN KEY (questao_id)
        REFERENCES questoes(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_qp_prerequisito
        FOREIGN KEY (prerequisito_id)
        REFERENCES prerequisitos(id)
        ON DELETE CASCADE,

    UNIQUE KEY uk_questao_prerequisito (
        questao_id,
        prerequisito_id
    )
) ENGINE=InnoDB;

-- ============================================================
-- PROFICIÊNCIA EM PRÉ-REQUISITOS
-- ============================================================

CREATE TABLE aluno_prerequisito_proficiencia (
    id                              INT AUTO_INCREMENT PRIMARY KEY,

    aluno_id                        VARCHAR(255) NOT NULL,
    prerequisito_id                 INT NOT NULL,

    proficiencia                    DECIMAL(5,4)
                                        NOT NULL DEFAULT 0.5000,

    erros_consecutivos              INT NOT NULL DEFAULT 0,
    acertos_consecutivos            INT NOT NULL DEFAULT 0,

    ultima_atualizacao              TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                                        ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_app_aluno
        FOREIGN KEY (aluno_id)
        REFERENCES alunos(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_app_prerequisito
        FOREIGN KEY (prerequisito_id)
        REFERENCES prerequisitos(id)
        ON DELETE CASCADE,

    UNIQUE KEY uk_aluno_prerequisito (
        aluno_id,
        prerequisito_id
    )
) ENGINE=InnoDB;

-- ============================================================
-- TABELA: CHAT
-- ============================================================

CREATE TABLE mensagens_chat (
    id                              INT AUTO_INCREMENT PRIMARY KEY,

    sala                            VARCHAR(200) NOT NULL,

    user_id                         VARCHAR(255) NOT NULL,
    user_nome                       VARCHAR(150) NOT NULL,

    texto                           TEXT NOT NULL,

    enviado_em                      BIGINT NOT NULL
) ENGINE=InnoDB;

-- ============================================================
-- TABELA: COMENTÁRIOS
-- ============================================================

CREATE TABLE comentarios (
    id                              INT AUTO_INCREMENT PRIMARY KEY,

    professor_id                    VARCHAR(255) NOT NULL,
    aluno_id                        VARCHAR(255) NULL,

    usuario_nome                    VARCHAR(150) NOT NULL,

    texto                           TEXT NOT NULL,

    nota                            TINYINT NULL,

    criado_em                       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    respondido BOOLEAN DEFAULT FALSE,

    CONSTRAINT fk_comentario_professor
        FOREIGN KEY (professor_id)
        REFERENCES professores(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_comentario_aluno
        FOREIGN KEY (aluno_id)
        REFERENCES alunos(id)
        ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE respostas_feedback (
    id INT AUTO_INCREMENT PRIMARY KEY,
    feedback_id INT,
    professor_id VARCHAR(255),
    texto_resposta TEXT,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (feedback_id) REFERENCES comentarios(id),
    FOREIGN KEY (professor_id) REFERENCES professores(id)
);

-- ============================================================
-- TABELA: DENÚNCIAS
-- ============================================================

CREATE TABLE denuncias (
    id                              INT AUTO_INCREMENT PRIMARY KEY,
    denunciante_id                  VARCHAR(255) NULL,
    denunciado_id                   VARCHAR(255) NULL, -- ID do usuário (aluno ou professor) que está sendo denunciado
    tipo                            VARCHAR(100) NOT NULL,
    titulo                          VARCHAR(300) NOT NULL,
    descricao                       TEXT NOT NULL,
    conteudo_info                   JSON NULL, -- Ex: { "tipo": "comentario", "id": 123 }
    email                           VARCHAR(255),
    evidencia                       VARCHAR(500),
    evidencia_arquivo               VARCHAR(500),
    anonimo                         BOOLEAN DEFAULT FALSE,
    prioridade                      VARCHAR(255) DEFAULT 'baixa',
    sla                             DATETIME,
    responsavel_id                  VARCHAR(255),
    status                          VARCHAR(255) DEFAULT 'aberta',
    criado_em                       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_denuncia_responsavel FOREIGN KEY (responsavel_id) REFERENCES admins(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS denuncia_historico (
    id INT AUTO_INCREMENT PRIMARY KEY,
    denuncia_id INT NOT NULL,
    usuario_id VARCHAR(255),
    acao VARCHAR(255) NOT NULL,
    detalhes TEXT,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (denuncia_id) REFERENCES denuncias(id) ON DELETE CASCADE,
    FOREIGN KEY (usuario_id) REFERENCES admins(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS alertas_operacionais (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tipo VARCHAR(255) NOT NULL,
    entidade_id VARCHAR(255) NOT NULL,
    mensagem TEXT NOT NULL,
    resolvido BOOLEAN DEFAULT FALSE,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- TABELA: PAGAMENTOS
-- ============================================================

CREATE TABLE IF NOT EXISTS platform_config (
    id INT AUTO_INCREMENT PRIMARY KEY,
    chave VARCHAR(100) NOT NULL UNIQUE,
    valor VARCHAR(500) NOT NULL,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Valor padrão da taxa da plataforma (20%)
INSERT IGNORE INTO platform_config (chave, valor) VALUES ('platform_fee_percent', '20');

CREATE TABLE pagamentos (
      id                              INT AUTO_INCREMENT PRIMARY KEY,

      checkout_id                     VARCHAR(36) UNIQUE,

      preference_id                   VARCHAR(200),
      payment_id                      VARCHAR(200),

      sala                            VARCHAR(200),

      descricao                       VARCHAR(300),

      valor                           DECIMAL(10,2)
                                          NOT NULL DEFAULT 0,

      taxa_plataforma                 DECIMAL(10,2)
                                          NOT NULL DEFAULT 0,

      valor_liquido                   DECIMAL(10,2)
                                          NOT NULL DEFAULT 0,

      criado_por                      VARCHAR(255),

      professor_id                    VARCHAR(255),

      status                          VARCHAR(50)
                                          DEFAULT 'pending',

      criado_em                       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      pago_em                         TIMESTAMP NULL,
      liberado_em                     TIMESTAMP NULL,

      INDEX idx_pagamentos_checkout_id (checkout_id),
      INDEX idx_pagamentos_preference_id (preference_id),
      INDEX idx_pagamentos_payment_id (payment_id)
  ) ENGINE=InnoDB;

CREATE TABLE repasses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    professor_id VARCHAR(255) NOT NULL,
    valor DECIMAL(10, 2) NOT NULL,
    status ENUM('retido', 'pendente', 'pago', 'falhou', 'estornado') NOT NULL DEFAULT 'retido',
    data_solicitacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    data_pagamento TIMESTAMP NULL,
    metodo_pagamento VARCHAR(255),
    referencia_transacao VARCHAR(255),
    INDEX idx_repasses_referencia_transacao (referencia_transacao),
    FOREIGN KEY (professor_id) REFERENCES professores(id)
);

CREATE TABLE reembolsos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    agendamento_id INT NOT NULL UNIQUE,
    aluno_id VARCHAR(255) NOT NULL,
    professor_id VARCHAR(255) NOT NULL,
    valor_reembolso DECIMAL(10,2) NOT NULL,
    status ENUM('pendente', 'processando', 'concluido', 'recusado') NOT NULL DEFAULT 'pendente',
    tipo ENUM('inteiro', 'parcial') NOT NULL DEFAULT 'inteiro',
    motivo TEXT,
    data_solicitacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    data_processamento TIMESTAMP NULL,
    FOREIGN KEY (agendamento_id) REFERENCES agendamentos(id) ON DELETE CASCADE
);

CREATE TABLE reembolso_pagamentos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    reembolso_id INT NOT NULL,
    payment_id VARCHAR(200) NOT NULL UNIQUE,
    mercadopago_refund_id VARCHAR(200),
    valor_reembolso DECIMAL(10,2) NOT NULL,
    status ENUM('pendente', 'processando', 'concluido', 'recusado') NOT NULL DEFAULT 'pendente',
    data_processamento TIMESTAMP NULL,
    FOREIGN KEY (reembolso_id) REFERENCES reembolsos(id) ON DELETE CASCADE
);

-- ============================================================
-- TABELA: NOTIFICAÇÕES
-- ============================================================

CREATE TABLE notificacoes (
    id                              INT AUTO_INCREMENT PRIMARY KEY,

    usuario_id                      VARCHAR(255) NOT NULL,

    usuario_tipo                    ENUM(
                                        'aluno',
                                        'professor'
                                    ) NOT NULL,

    tipo                            VARCHAR(100) NOT NULL,

    mensagem                        TEXT NOT NULL,

    lida                            BOOLEAN DEFAULT FALSE,

    link_relacionado VARCHAR(255) DEFAULT NULL,

    resolvida BOOLEAN DEFAULT FALSE,

    criado_em                       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ============================================================
-- TABELA: AUDITORIA ADMINISTRATIVA
-- ============================================================

CREATE TABLE admin_audit_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  admin_id VARCHAR(255) NOT NULL,
  acao VARCHAR(255) NOT NULL,
  entidade VARCHAR(255) NOT NULL,
  entidade_id VARCHAR(255) NOT NULL,
  diff_json JSON NULL,
  motivo TEXT NULL,
  criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_audit_admin
    FOREIGN KEY (admin_id)
    REFERENCES admins(id)
    ON DELETE RESTRICT
) ENGINE=InnoDB;


-- ============================================================
-- ÍNDICES PARA PERFORMANCE
-- ============================================================

CREATE INDEX idx_questoes_habilidade
    ON questoes(habilidade_id);

CREATE INDEX idx_historico_aluno
    ON historico_questoes(aluno_id);

CREATE INDEX idx_historico_questao
    ON historico_questoes(questao_id);

CREATE INDEX idx_trilhas_aluno
    ON trilhas(aluno_id);

CREATE INDEX idx_resultado_aluno
    ON resultado_habilidade(aluno_id);

CREATE INDEX idx_sessao_aluno
    ON sessoes_adaptativas(aluno_id);

CREATE INDEX idx_revisao_data
    ON revisao_agendada(data_revisao);

CREATE INDEX idx_qp_prerequisito
    ON questoes_prerequisitos(prerequisito_id);

CREATE INDEX idx_app_aluno
    ON aluno_prerequisito_proficiencia(aluno_id);

-- ============================================================
-- FINALIZAÇÃO
-- ============================================================

SET FOREIGN_KEY_CHECKS = 1;

-- Índices adicionais consolidados das migrations de performance.
CREATE INDEX idx_trilha_itens_trilha_status_ordem
    ON trilha_itens (trilha_id, status, ordem);

CREATE INDEX idx_historico_questoes_aluno_questao_data
    ON historico_questoes (aluno_id, questao_id, data_resposta);

CREATE INDEX idx_historico_questoes_aluno_habilidade_data
    ON historico_questoes (aluno_id, habilidade_id, data_resposta);

CREATE INDEX idx_revisao_agendada_aluno_data
    ON revisao_agendada (aluno_id, data_revisao);

CREATE INDEX idx_historico_questoes_aluno_questao
    ON historico_questoes (aluno_id, questao_id);

-- Tabelas adicionais da trilha adaptativa.
CREATE TABLE IF NOT EXISTS trilha_decisoes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    trilha_id INT NOT NULL,
    aluno_id VARCHAR(255) NOT NULL,
    habilidade_id INT NULL,
    acao VARCHAR(50) NOT NULL,
    etapa VARCHAR(50) NOT NULL,
    dificuldade ENUM('facil','medio','dificil') NULL,
    motivo VARCHAR(120) NOT NULL,
    contexto_json JSON NULL,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_decisao_trilha
        FOREIGN KEY (trilha_id) REFERENCES trilhas(id) ON DELETE CASCADE,
    CONSTRAINT fk_decisao_aluno
        FOREIGN KEY (aluno_id) REFERENCES alunos(id) ON DELETE CASCADE,
    CONSTRAINT fk_decisao_habilidade
        FOREIGN KEY (habilidade_id) REFERENCES habilidades(id) ON DELETE SET NULL,
    INDEX idx_decisao_aluno_trilha (aluno_id, trilha_id, criado_em)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS curriculo_aluno (
    id INT AUTO_INCREMENT PRIMARY KEY,
    aluno_id VARCHAR(255) NOT NULL,
    disciplina_id VARCHAR(255) NOT NULL,
    ano_escolar INT NOT NULL,
    objetivo VARCHAR(255) NULL,
    versao_mapa VARCHAR(120) NULL,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_curriculo_aluno
        FOREIGN KEY (aluno_id) REFERENCES alunos(id) ON DELETE CASCADE,
    INDEX idx_curriculo_aluno_ano (aluno_id, disciplina_id, ano_escolar)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS habilidades_curriculo (
    id INT AUTO_INCREMENT PRIMARY KEY,
    curriculo_id INT NOT NULL,
    habilidade_id INT NOT NULL,
    ordem INT NOT NULL DEFAULT 0,
    obrigatoria BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT fk_hc_curriculo
        FOREIGN KEY (curriculo_id) REFERENCES curriculo_aluno(id) ON DELETE CASCADE,
    CONSTRAINT fk_hc_habilidade
        FOREIGN KEY (habilidade_id) REFERENCES habilidades(id) ON DELETE CASCADE,
    UNIQUE KEY uk_curriculo_habilidade (curriculo_id, habilidade_id),
    INDEX idx_curriculo_habilidade_ordem (curriculo_id, ordem)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS revisao_habilidades (
    id INT AUTO_INCREMENT PRIMARY KEY,
    aluno_id VARCHAR(255) NOT NULL,
    habilidade_id INT NOT NULL,
    data_revisao DATE NOT NULL,
    intervalo_dias INT NOT NULL DEFAULT 1,
    fator_facilidade DECIMAL(4,2) NOT NULL DEFAULT 2.50,
    motivo VARCHAR(120) NULL,
    criado_em TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_revisao_habilidade (aluno_id, habilidade_id),
    CONSTRAINT fk_revisao_habilidad_aluno
        FOREIGN KEY (aluno_id) REFERENCES alunos(id) ON DELETE CASCADE,
    CONSTRAINT fk_revisao_habilidad_skill
        FOREIGN KEY (habilidade_id) REFERENCES habilidades(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS questoes_habilidades_secundarias (
    id INT AUTO_INCREMENT PRIMARY KEY,
    questao_id INT NOT NULL,
    habilidade_id INT NOT NULL,
    UNIQUE KEY uk_questao_habilidade_secundaria (questao_id, habilidade_id),
    CONSTRAINT fk_qhs_questao
        FOREIGN KEY (questao_id) REFERENCES questoes(id) ON DELETE CASCADE,
    CONSTRAINT fk_qhs_habilidade
        FOREIGN KEY (habilidade_id) REFERENCES habilidades(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Reabilita a verificacao de chaves estrangeiras ao concluir a instalacao.
SET FOREIGN_KEY_CHECKS = 1;
