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

CREATE DATABASE IF NOT EXISTS b3yigwtafba02ntosynz
CHARACTER SET utf8mb4
COLLATE utf8mb4_unicode_ci;

USE b3yigwtafba02ntosynz;

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

    xp_total                INT NOT NULL DEFAULT 0,
    nivel                   INT NOT NULL DEFAULT 1,

    streak_atual            INT NOT NULL DEFAULT 0,
    streak_acertos          INT NOT NULL DEFAULT 0,

    ultima_atividade_em     DATETIME NULL,

    criado_em               TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em           TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                                ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ============================================================
-- TABELA: PROFESSORES
-- ============================================================

CREATE TABLE professores (
    id                      VARCHAR(255) PRIMARY KEY,
    nome                    VARCHAR(150) NOT NULL,
    email                   VARCHAR(255) NOT NULL UNIQUE,
    senha                   CHAR(60) NOT NULL,
    foto                    VARCHAR(500)
                                DEFAULT '/imagens/imagem_perfil.jpg',
    descricao               TEXT,
    link_previa             VARCHAR(500) DEFAULT '',
    status                  ENUM(
                                'disponivel',
                                'indisponivel'
                             ) DEFAULT 'disponivel',
    aprovacao_status        ENUM('pending', 'approved', 'rejected', 'suspended') NOT NULL DEFAULT 'pending',
    aprovado_por            VARCHAR(255) NULL,
    aprovado_em             TIMESTAMP NULL,
    motivo_reprovacao       TEXT NULL,
    pagamentos_bloqueados   BOOLEAN DEFAULT FALSE,
    criado_em               TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    atualizado_em           TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                                ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_prof_aprovado_por FOREIGN KEY (aprovado_por) REFERENCES admins(id) ON DELETE SET NULL
) ENGINE=InnoDB;

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
    data                    DATE NOT NULL,
    hora                    TIME NOT NULL,
    no_show                 BOOLEAN DEFAULT FALSE,
    status                  ENUM(
                                'ativo',
                                'cancelado',
                                'concluido'
                             ) DEFAULT 'ativo',
    criado_em               TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
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

    criado_em                  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

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
                                    'concluida'
                                ) DEFAULT 'ativa',

    criado_em                   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

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

CREATE TABLE tentativas_teste (
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
    data_conclusao TIMESTAMP,

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

    tipo                            ENUM(
                                        'diagnostico',
                                        'reforco'
                                    ) DEFAULT 'diagnostico',

    pontuacao_diagnostico           DECIMAL(5,2),

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

    questao_id                  INT NOT NULL,

    bloco                       ENUM(
                                    'revisao',
                                    'pratica',
                                    'checkpoint'
                                ) DEFAULT 'pratica',

    status                      ENUM(
                                    'pendente',
                                    'concluido',
                                    'erro'
                                ) DEFAULT 'pendente',

    resposta_aluno              TEXT NULL,
    acertou                     BOOLEAN NULL,

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
                                            'reforco'
                                        ) DEFAULT 'nao_iniciado',

    respostas_consistentes_acerto       INT DEFAULT 0,

    ultima_vez_praticado                TIMESTAMP NULL,

    criado_em                           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    atualizado_em                       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                                            ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY uk_aluno_habilidade (
        aluno_id,
        habilidade_id
    ),

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
-- TABELA: CONTEÚDOS DE APOIO
-- ============================================================

CREATE TABLE conteudos_apoio (
    id                              INT AUTO_INCREMENT PRIMARY KEY,

    tipo                            ENUM(
                                        'video',
                                        'artigo',
                                        'link_externo',
                                        'flashcard'
                                    ) NOT NULL,

    titulo                          VARCHAR(255) NOT NULL,

    url_ou_conteudo                 TEXT NOT NULL,

    duracao_estimada_seg            INT NULL,

    criado_em                       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ============================================================
-- RELAÇÃO: PRÉ-REQUISITOS ↔ CONTEÚDOS
-- ============================================================

CREATE TABLE prerequisito_conteudos_apoio (
    id                              INT AUTO_INCREMENT PRIMARY KEY,

    prerequisito_id                 INT NOT NULL,
    conteudo_id                     INT NOT NULL,

    CONSTRAINT fk_pca_prerequisito
        FOREIGN KEY (prerequisito_id)
        REFERENCES prerequisitos(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_pca_conteudo
        FOREIGN KEY (conteudo_id)
        REFERENCES conteudos_apoio(id)
        ON DELETE CASCADE,

    UNIQUE KEY uk_prerequisito_conteudo (
        prerequisito_id,
        conteudo_id
    )
) ENGINE=InnoDB;

-- ============================================================
-- TABELA: CONSUMO DE CONTEÚDO
-- ============================================================

CREATE TABLE aluno_conteudo_consumido (
    id                              INT AUTO_INCREMENT PRIMARY KEY,

    aluno_id                        VARCHAR(255) NOT NULL,
    conteudo_id                     INT NOT NULL,

    consumido_em                    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_acc_aluno
        FOREIGN KEY (aluno_id)
        REFERENCES alunos(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_acc_conteudo
        FOREIGN KEY (conteudo_id)
        REFERENCES conteudos_apoio(id)
        ON DELETE CASCADE,

    UNIQUE KEY uk_aluno_conteudo (
        aluno_id,
        conteudo_id
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

    CONSTRAINT fk_comentario_professor
        FOREIGN KEY (professor_id)
        REFERENCES professores(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_comentario_aluno
        FOREIGN KEY (aluno_id)
        REFERENCES alunos(id)
        ON DELETE SET NULL
) ENGINE=InnoDB;

-- ============================================================
-- TABELA: DENÚNCIAS
-- ============================================================

CREATE TABLE denuncias (
    id                              INT AUTO_INCREMENT PRIMARY KEY,
    tipo                            VARCHAR(100) NOT NULL,
    titulo                          VARCHAR(300) NOT NULL,
    descricao                       TEXT NOT NULL,
    email                           VARCHAR(255),
    evidencia                       VARCHAR(500),
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

CREATE TABLE pagamentos (
    id                              INT AUTO_INCREMENT PRIMARY KEY,

    preference_id                   VARCHAR(200),
    payment_id                      VARCHAR(200),

    sala                            VARCHAR(200),

    descricao                       VARCHAR(300),

    valor                           DECIMAL(10,2)
                                        NOT NULL DEFAULT 0,

    criado_por                      VARCHAR(255),

    status                          VARCHAR(50)
                                        DEFAULT 'pending',

    criado_em                       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS repasses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    professor_id VARCHAR(255) NOT NULL,
    valor DECIMAL(10, 2) NOT NULL,
    status ENUM('pendente', 'pago', 'falhou') NOT NULL DEFAULT 'pendente',
    data_solicitacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    data_pagamento TIMESTAMP NULL,
    metodo_pagamento VARCHAR(255),
    referencia_transacao VARCHAR(255),
    FOREIGN KEY (professor_id) REFERENCES professores(id)
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