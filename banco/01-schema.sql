-- banco do troca-troca de figurinhas
-- roda sozinho quando o container do mysql sobe pela primeira vez

CREATE DATABASE IF NOT EXISTS figurinhas;
USE figurinhas;

-- 48 selecoes + 1 grupo de especiais (FWC)
CREATE TABLE selecoes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  codigo VARCHAR(3) NOT NULL UNIQUE,
  nome VARCHAR(50) NOT NULL
);

-- cada selecao tem 20 figurinhas, 49 x 20 = 980
CREATE TABLE figurinhas (
  id INT AUTO_INCREMENT PRIMARY KEY,
  codigo VARCHAR(10) NOT NULL UNIQUE,
  selecao_id INT NOT NULL,
  numero INT NOT NULL,
  nome VARCHAR(60) NOT NULL,
  tipo ENUM('escudo', 'time', 'jogador', 'especial') NOT NULL,
  FOREIGN KEY (selecao_id) REFERENCES selecoes(id)
);

CREATE TABLE colecionadores (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nome VARCHAR(80) NOT NULL,
  cidade VARCHAR(50) NOT NULL,
  criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- figurinhas que cada colecionador tem
-- quantidade > 1 quer dizer que tem repetida
CREATE TABLE colecao (
  colecionador_id INT NOT NULL,
  figurinha_id INT NOT NULL,
  quantidade INT NOT NULL DEFAULT 1,
  PRIMARY KEY (colecionador_id, figurinha_id),
  FOREIGN KEY (colecionador_id) REFERENCES colecionadores(id),
  FOREIGN KEY (figurinha_id) REFERENCES figurinhas(id)
);

CREATE TABLE trocas (
  id INT AUTO_INCREMENT PRIMARY KEY,
  quem_oferece_id INT NOT NULL,
  quem_recebe_id INT NOT NULL,
  figurinha_oferecida_id INT NOT NULL,
  figurinha_pedida_id INT NOT NULL,
  status ENUM('pendente', 'aceita', 'recusada') NOT NULL DEFAULT 'pendente',
  criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (quem_oferece_id) REFERENCES colecionadores(id),
  FOREIGN KEY (quem_recebe_id) REFERENCES colecionadores(id),
  FOREIGN KEY (figurinha_oferecida_id) REFERENCES figurinhas(id),
  FOREIGN KEY (figurinha_pedida_id) REFERENCES figurinhas(id)
);

-- usuario que os apps usam pra conectar
CREATE USER IF NOT EXISTS 'app'@'%' IDENTIFIED BY 'app123';
GRANT ALL PRIVILEGES ON figurinhas.* TO 'app'@'%';
FLUSH PRIVILEGES;
