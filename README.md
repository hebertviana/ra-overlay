# RA Overlay

[![Build](https://github.com/hebertviana/ra-overlay-pcsx2/actions/workflows/build.yml/badge.svg)](https://github.com/hebertviana/ra-overlay-pcsx2/actions/workflows/build.yml)

Overlay externo de conquistas do RetroAchievements, pensado para rodar por cima do PCSX2.

## Instalar

Precisa do Node.js 18 ou superior.

```
cd ra-overlay
npm install
npm start
```

Na primeira execução a janela de configuração abre sozinha. Preencha o usuário e a chave de API web (retroachievements.org → Settings → Keys).

Para gerar um .exe portátil:

```
npm run build
```

O executável sai em `dist/`.

## Atalhos globais

| Atalho | Ação |
| --- | --- |
| Ctrl+Alt+O | Destrava o overlay para arrastar / trava de novo |
| Ctrl+Alt+P | Abre as configurações |
| Ctrl+Alt+R | Força uma atualização imediata |
| Ctrl+Alt+B | Faz um backup manual do memory card |
| Ctrl+Alt+Q | Fecha o overlay (encerra o app) |

Travado, o clique atravessa o overlay e vai direto para o jogo. Destravado, aparece um contorno tracejado e você arrasta o painel para onde quiser. A posição é salva automaticamente.

## Como ele descobre o jogo

No modo automático ele consulta `API_GetUserProfile.php` e usa o campo `LastGameID`, que o PCSX2 atualiza quando você carrega uma ISO com set de conquistas. Se preferir travar em um jogo, mude para "Fixar um jogo" e informe o ID que aparece na URL da página do jogo no site.

## Filtros

- **Só as que faltam / só as conquistadas / todas** — o filtro principal.
- **Quantidade** — quantas linhas mostrar.
- **Ordem** — ordem do set, menos pontos primeiro (útil para achar as fáceis restantes), mais raras primeiro, ou conquistadas recentemente.
- **Tipo** — progressão/final ou perdíveis, usando o campo `Type` da API.
- **IDs específicos** — se preenchido, ignora tudo acima e mostra exatamente aquelas conquistas, na ordem digitada.

## Backup do memory card

Ative em Configurações → Backup e aponte a pasta onde estão os `Mcd001.ps2` e `Mcd002.ps2`. A cada ciclo o app compara as conquistas ganhas com as do ciclo anterior; se apareceu alguma nova, os cartões são compactados na hora.

```
<pasta dos memory cards>/
└── backups/
    └── 4265_Shadow-of-the-Colossus/                             ← ID + título do jogo no RA
        ├── 2026-09-10_21-45-03_manual.zip
        ├── 2026-09-10_22-03-17_ach79434_Primeiro-Colosso.zip
        └── 2026-09-10_22-31-50_ach79440_Segundo-Colosso_mais1.zip
```

Cada zip contém todos os cartões da pasta (`.ps2`, `.mcd`, `.mcr`) e um `backup.txt` com a data, o jogo e a conquista que disparou o backup. Cartões de 8 MB praticamente vazios comprimem para poucas dezenas de KB, então o custo em disco é baixo.

Detalhes de comportamento:

- O primeiro ciclo de cada jogo só registra a base. Sem isso, abrir um jogo com 30 conquistas já feitas geraria 30 backups de uma vez.
- Se mais de uma conquista sair no mesmo ciclo, é gerado um arquivo só — o estado do cartão é o mesmo nos dois casos. O nome usa a de maior pontuação e recebe o sufixo `_maisN`.
- "Manter no máximo" apaga os mais antigos daquele jogo quando o limite é passado. Como o nome começa pela data, a ordem alfabética já é a cronológica.
- O backup sai com o estado **atual** do cartão. O PCSX2 só grava nele quando o jogo salva, então a foto é do último save, não do instante exato do desbloqueio. Para conquistas perdíveis isso costuma bastar, mas se você desbloqueou algo logo depois de salvar, o ponto de retorno é o save anterior.
- Ao detectar a conquista, o app espera o cartão ser regravado (útil quando o jogo pede confirmação pra salvar) antes de compactar. Esse tempo é configurável em "Esperar gravação do cartão por até" (padrão 40s); se esgotar sem gravação nova, o backup sai do jeito que o cartão estiver e a notificação avisa que o save pode não estar atualizado.

## Limitações conhecidas

- Os dados vêm da API web por polling, então há um atraso de até um intervalo (mínimo de 10 segundos) entre desbloquear no emulador e o overlay refletir.
- Não aparece em gravação da Steam, que captura a swapchain do processo do jogo, e não a composição do desktop. Para gravar, use OBS e adicione a janela do overlay como uma fonte separada.
- Não funciona sobre fullscreen exclusivo. Rode o PCSX2 em janela ou borderless.
- A chave de API é cifrada em disco (`%APPDATA%/ra-overlay/config.json`) via `safeStorage` do Electron, que usa o DPAPI do Windows atrelado à conta do usuário — só decifra na mesma máquina/conta que gravou. Configs antigos com a chave em texto puro são migrados automaticamente na primeira abertura.
