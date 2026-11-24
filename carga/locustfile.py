# teste de carga do troca-troca
# o mesmo arquivo serve pro monolito (porta 3001) e pro gateway (porta 3000), so muda o --host
#
# exemplo:
#   locust -f carga/locustfile.py --host http://localhost:3001

import random
from locust import HttpUser, task, between


class Colecionador(HttpUser):
    # think time: o usuario espera entre 1 e 3 segundos entre uma acao e outra
    wait_time = between(1, 3)

    def on_start(self):
        # cada usuario virtual finge ser um colecionador
        self.id = random.randint(1, 200)

    @task(3)
    def ver_album(self):
        self.client.get("/album")

    @task(2)
    def ver_meu_album(self):
        self.client.get(f"/colecionadores/{self.id}/album", name="/colecionadores/[id]/album")

    @task(3)
    def ver_perfil(self):
        self.client.get(f"/colecionadores/{self.id}", name="/colecionadores/[id]")

    @task(2)
    def ver_faltantes(self):
        self.client.get(f"/colecionadores/{self.id}/faltantes", name="/colecionadores/[id]/faltantes")

    @task(2)
    def ver_repetidas(self):
        self.client.get(f"/colecionadores/{self.id}/repetidas", name="/colecionadores/[id]/repetidas")

    @task(2)
    def abrir_pacotinho(self):
        self.client.post(f"/colecionadores/{self.id}/pacotinho", name="/colecionadores/[id]/pacotinho")

    @task(1)
    def ver_trocas(self):
        self.client.get(f"/colecionadores/{self.id}/trocas", name="/colecionadores/[id]/trocas")

    @task(1)
    def trocar(self):
        # procura alguem que tem repetida de uma figurinha que me falta
        r = self.client.get(f"/colecionadores/{self.id}/sugestoes-troca", name="/colecionadores/[id]/sugestoes-troca")
        if r.status_code != 200:
            return
        sugestoes = r.json().get("sugestoes", [])
        if not sugestoes:
            return

        # pega uma repetida minha pra oferecer
        r = self.client.get(f"/colecionadores/{self.id}/repetidas", name="/colecionadores/[id]/repetidas")
        if r.status_code != 200:
            return
        repetidas = r.json().get("repetidas", [])
        if not repetidas:
            return

        sugestao = random.choice(sugestoes)
        minha = random.choice(repetidas)

        r = self.client.post("/trocas", json={
            "quem_oferece_id": self.id,
            "quem_recebe_id": sugestao["colecionador_id"],
            "figurinha_oferecida_id": minha["id"],
            "figurinha_pedida_id": sugestao["figurinha_id"],
        })
        if r.status_code != 201:
            return

        # o outro colecionador aceita (as vezes da 409 se alguem trocou antes, faz parte)
        troca_id = r.json()["id"]
        with self.client.post(f"/trocas/{troca_id}/aceitar", name="/trocas/[id]/aceitar", catch_response=True) as resp:
            if resp.status_code == 409:
                resp.success()
