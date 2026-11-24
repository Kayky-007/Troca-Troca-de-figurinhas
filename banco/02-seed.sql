-- dados de teste
-- 48 selecoes + especiais, 980 figurinhas, 200 colecionadores, colecao aleatoria e umas trocas

USE figurinhas;

-- tabela auxiliar com numeros de 1 a 1000 pra gerar os dados sem precisar de script
CREATE TABLE numeros (n INT PRIMARY KEY);
INSERT INTO numeros (n)
SELECT a.d + b.d * 10 + c.d * 100 + 1
FROM (SELECT 0 d UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) a,
     (SELECT 0 d UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) b,
     (SELECT 0 d UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) c;

-- selecoes da copa de 2026
INSERT INTO selecoes (codigo, nome) VALUES
('FWC', 'Especiais'),
('USA', 'Estados Unidos'),
('MEX', 'Mexico'),
('CAN', 'Canada'),
('BRA', 'Brasil'),
('ARG', 'Argentina'),
('URU', 'Uruguai'),
('COL', 'Colombia'),
('ECU', 'Equador'),
('PAR', 'Paraguai'),
('JPN', 'Japao'),
('KOR', 'Coreia do Sul'),
('IRN', 'Ira'),
('AUS', 'Australia'),
('UZB', 'Uzbequistao'),
('JOR', 'Jordania'),
('QAT', 'Catar'),
('KSA', 'Arabia Saudita'),
('IRQ', 'Iraque'),
('MAR', 'Marrocos'),
('SEN', 'Senegal'),
('TUN', 'Tunisia'),
('EGY', 'Egito'),
('ALG', 'Argelia'),
('GHA', 'Gana'),
('CPV', 'Cabo Verde'),
('RSA', 'Africa do Sul'),
('CIV', 'Costa do Marfim'),
('COD', 'RD Congo'),
('NZL', 'Nova Zelandia'),
('PAN', 'Panama'),
('HAI', 'Haiti'),
('CUW', 'Curacao'),
('ENG', 'Inglaterra'),
('FRA', 'Franca'),
('ESP', 'Espanha'),
('GER', 'Alemanha'),
('POR', 'Portugal'),
('NED', 'Holanda'),
('BEL', 'Belgica'),
('CRO', 'Croacia'),
('SUI', 'Suica'),
('AUT', 'Austria'),
('NOR', 'Noruega'),
('SCO', 'Escocia'),
('ITA', 'Italia'),
('TUR', 'Turquia'),
('DEN', 'Dinamarca'),
('UKR', 'Ucrania');

-- 20 figurinhas por selecao
-- 1 = escudo, 2 = foto do time, 3 a 20 = jogadores
-- FWC sao as especiais (taca, mascote, estadios...)
-- tem que ser num insert so, se separar o mysql pula ids no auto increment
INSERT INTO figurinhas (codigo, selecao_id, numero, nome, tipo)
SELECT CONCAT(s.codigo, n.n), s.id, n.n,
  CASE
    WHEN s.codigo = 'FWC' THEN ELT(n.n, 'Logo da Copa', 'Taca', 'Mascote', 'Bola oficial', 'Poster oficial',
      'Estadio Azteca', 'Estadio MetLife', 'Estadio SoFi', 'Estadio BC Place', 'Estadio BMO Field',
      'Estadio AT&T', 'Estadio Lumen Field', 'Estadio Hard Rock', 'Estadio Akron', 'Estadio BBVA',
      'Campeao 1930', 'Campeao 1970', 'Campeao 1994', 'Campeao 2002', 'Campeao 2022')
    WHEN n.n = 1 THEN CONCAT('Escudo ', s.nome)
    WHEN n.n = 2 THEN CONCAT('Time ', s.nome)
    ELSE CONCAT('Jogador ', n.n - 2, ' ', s.codigo)
  END,
  CASE
    WHEN s.codigo = 'FWC' THEN 'especial'
    WHEN n.n = 1 THEN 'escudo'
    WHEN n.n = 2 THEN 'time'
    ELSE 'jogador'
  END
FROM selecoes s
JOIN numeros n ON n.n <= 20
ORDER BY s.id, n.n;

-- 200 colecionadores com nome e cidade misturados
INSERT INTO colecionadores (nome, cidade)
SELECT
  CONCAT(
    ELT(1 + (n % 20), 'Lucas', 'Ana', 'Pedro', 'Julia', 'Gabriel', 'Beatriz', 'Mateus', 'Larissa', 'Rafael', 'Camila',
        'Gustavo', 'Fernanda', 'Felipe', 'Amanda', 'Bruno', 'Leticia', 'Thiago', 'Mariana', 'Diego', 'Isabela'),
    ' ',
    ELT(1 + ((n * 7) % 20), 'Silva', 'Santos', 'Oliveira', 'Souza', 'Lima', 'Pereira', 'Costa', 'Rodrigues', 'Almeida', 'Nascimento',
        'Carvalho', 'Gomes', 'Martins', 'Araujo', 'Ribeiro', 'Barbosa', 'Rocha', 'Dias', 'Teixeira', 'Moreira')
  ),
  ELT(1 + (n % 10), 'Sao Paulo', 'Rio de Janeiro', 'Belo Horizonte', 'Curitiba', 'Porto Alegre',
      'Salvador', 'Recife', 'Fortaleza', 'Goiania', 'Campinas')
FROM numeros
WHERE n <= 200;

-- colecao de cada um
-- cada colecionador tem uma % diferente do album (entre 15% e 85%)
-- quantidade quase sempre 1, as vezes 2 ou 3 (repetidas)
INSERT INTO colecao (colecionador_id, figurinha_id, quantidade)
SELECT c.id, f.id, 1 + FLOOR(RAND() * RAND() * 3)
FROM colecionadores c
CROSS JOIN figurinhas f
WHERE RAND() < 0.15 + (c.id % 8) * 0.1;

-- 500 trocas antigas
INSERT INTO trocas (quem_oferece_id, quem_recebe_id, figurinha_oferecida_id, figurinha_pedida_id, status, criado_em)
SELECT
  1 + (n % 200),
  1 + ((n + 37) % 200),
  1 + FLOOR(RAND() * 980),
  1 + FLOOR(RAND() * 980),
  ELT(1 + FLOOR(RAND() * 3), 'pendente', 'aceita', 'recusada'),
  NOW() - INTERVAL FLOOR(RAND() * 30) DAY
FROM numeros
WHERE n <= 500;

DROP TABLE numeros;
