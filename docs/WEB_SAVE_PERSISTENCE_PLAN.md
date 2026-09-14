# Plano de implementação: saves persistentes no navegador

Data: 2026-09-13 (revisado no mesmo dia contra o código). Base:
`feat/web-support` em `e56a7e3` (host web WebGL/AudioWorklet commitado; pausa
compartilhada dentro do present-in-place em `0c709cb`). Emscripten 6.0.9.

Números de linha abaixo são desse commit; confira antes de editar.

## 1. Objetivo e restrições

- O save do jogo (bateria: SRAM/EEPROM/Flash) e os save states ficam **na
  máquina de quem abre a URL**, no armazenamento do navegador daquele visitante.
- **Nada vai para o servidor.** O deploy serve só arquivos estáticos (com
  COOP/COEP, que já são obrigatórios). Nenhum `fetch`/POST de save.
- **Sem dependências externas:** nenhuma biblioteca JS, CDN ou serviço. Só o que
  vem no Emscripten (IDBFS, `MAIN_THREAD_ASYNC_EM_ASM`) e APIs padrão do
  navegador (IndexedDB, File/Blob, `navigator.storage`, `navigator.locks`).
- O caminho nativo não muda de comportamento. Única exceção declarada: a
  gravação atômica de save state (§6.2), que vale nos dois alvos e entra no A/B.
  Todo o resto (flush ao pausar, aviso de escrita, `--state-dir` na web) fica
  atrás de `GBARECOMP_WEB_HOST` ou só muda algo quando o argumento é passado.
- Regras do projeto continuam valendo: nada de HLE, nada em `generated/`,
  cobertura reportada honestamente em toda execução de teste.

### Definição de pronto

1. Jogar, salvar no jogo, recarregar a página → o save volta, sem ação manual.
2. Save state em slot sobrevive a recarregar a página.
3. Ocultar a aba, pausar ou parar grava o save pendente imediatamente.
4. Falhas de armazenamento aparecem na página e no log (nunca silenciosas).
5. Exportar/importar `.sav` funciona e é compatível com o formato cru de chip.
6. Duas abas do mesmo jogo não sobrescrevem o save uma da outra.
7. Testes de §9 verdes em Chrome; Firefox e Safari verificados manualmente.

### Fatia mínima que corrige o bug

F1 (só aviso + wrapper) + F2 + `persist()` no `onExit`/`onAbort` (§6.5). Com
isso o save de bateria gravado pelo jogo volta depois de recarregar. F3–F5 são
robustez (aba oculta, locks, export/import, save states).

## 2. Estado atual e causa raiz (verificado no código)

| Fato | Evidência |
|---|---|
| ROM e BIOS são gravadas em `/data` (MEMFS, só memória) | `packaging/web/bootstrap.js` (`preRun`) |
| Não existe IDBFS/`syncfs`/IndexedDB em `packaging/` nem `src/`; a página avisa "Saves are volatile (MEMFS)" | `grep -rn "IDBFS\|syncfs\|indexedDB" packaging src` vazio; `packaging/web/index.html:40` |
| Sem `--save-path`, o save é `<rom>.sav` → `/data/game.sav` em MEMFS: some ao recarregar | `runtime.cpp:1620-1624` (SRAM), idem EEPROM e Flash |
| Save states usam o caminho da ROM com `.stateN` → `/data/game.stateN`, também voláteis | `runtime.cpp:2685-2689` (`slot_path`) |
| `flush_save` grava `<save>.tmp` e renomeia (atômico) e devolve `true` tanto para "gravou" quanto para "nada a gravar" | `runtime.cpp:1744-1790` |
| `flush_save` é definido **antes** de `HostWindow win` e não pode chamá-lo | `runtime.cpp:1744` × `:2285` |
| O flush periódico do laço externo (60 frames) **não roda** com present-in-place: o guest fica dentro de um único `step_once()`, e o hook é chamado de dentro do dispatch | chamada do hook `runtime_bus_bridge.cpp:995`; flush externo `runtime.cpp:3681-3687` |
| O host web já faz flush dentro do hook, com a constante `60` literal | `runtime.cpp:3257-3260` (`web_save_last_flush`); `kSaveFlushIntervalFrames` só é declarado depois, em `:3539` |
| No hook, a checagem de 60 frames vem **antes** de `service_host_pause()`: aba oculta pausa com o save sujo só na RAM, pelo tempo que ela ficar oculta | `runtime.cpp:3257` × `:3264`; `service_host_pause` em `:3169` |
| Aba oculta → `hidden=1` no bloco compartilhado → `auto_paused()` | `host_web.js:155`; `host_window_web.cpp:121` |
| Ao sair (`Stop`/`quit`), o loop termina, `win.close()` roda e **só depois** vem o `flush_save()` final | `runtime.cpp:3741` (`win.close()`) × `:3744` |
| `HostWindow::close()` apaga o backend e zera `impl_` | `host_window_web.cpp:82-96` |
| `save_state` grava direto no arquivo final com `trunc` (não atômico) | `src/debug/snapshot.cpp:153-169` |
| Save states e saves já rejeitam ROM errada/versão errada/truncamento de forma explícita | `snapshot.cpp:171-200`; `runtime.cpp:1634-1650` |
| Formato do `.sav` é o dump cru do chip; arquivo menor é preenchido com `0xFF`, maior é recusado | `gba_save.cpp:40-48`, `:149-161`, `:282-292`; recusa em `runtime.cpp:1634` e equivalentes |
| Save/Load de slot já chegam da página por comando | `host_window_web.cpp:131`; `bootstrap.js` botões `save`/`load` |
| Os testes web (`browser.py`, `test_game.py`, `host_unit_test.js`) **não estão no checkout**; só existem na branch `feat/web-canvas-host` | `git ls-tree -r --name-only feat/web-canvas-host tests/web` |

### Fatos do Emscripten (lidos no código-fonte local do emsdk)

- Com pthreads e o FS em JS, **toda syscall de arquivo é repassada de forma
  síncrona para a thread principal** (`src/lib/libcore.js`,
  `__proxy ??= 'sync'`). O MEMFS/IDBFS vive na thread da página, e a página
  enxerga os arquivos que o worker escreveu.
- IDBFS precisa de `-lidbfs.js` no link e fica em `FS.filesystems.IDBFS`
  (`src/lib/libfs.js:1589`). Com WasmFS o link falha (`libidbfs.js`, fim do
  arquivo).
- `MAIN_THREAD_ASYNC_EM_ASM` existe (`system/include/emscripten/em_asm.h:275`).
- O nome do banco IndexedDB é o ponto de montagem (`getDB(mount.mountpoint)`).
- `IDBFS.syncfs` (`libidbfs.js:116-128`) tem três etapas:
  1. `getLocalSet` — **síncrono**, varre a árvore e guarda `mtime` de cada
     caminho;
  2. `getRemoteSet` — **assíncrono** (abre o banco, transação `readonly`);
  3. `reconcile` — **uma única transação `readwrite`** com todas as
     criações/remoções; `onerror`/`onabort` entregam o erro (ex.:
     `QuotaExceededError`). Se a aba fechar no meio, a transação aborta e o
     IndexedDB fica com a versão anterior completa.
- A comparação é `mtime.getTime()` (igualdade em milissegundos).
- **Corrida entre etapas:** entre (1) e (3) a página processa mensagens, e as
  syscalls repassadas do worker rodam ali. Se um caminho listado em (1) for
  renomeado ou apagado antes de (3) (típico: `battery.sav.tmp` ou `state1.tmp`
  de uma escrita concorrente), `loadLocalEntry` falha com `ErrnoError` ENOENT
  (`libidbfs.js:246-251`) e o `syncfs` inteiro devolve erro, sem gravar nada.
  Um `.tmp` pela metade também pode ser gravado; ele some na sincronização
  seguinte e é apagado na montagem. Tratamento em §6.4.
- `autoPersist: true` agenda a sincronização com `setTimeout(0)` ao criar arquivo,
  fechar arquivo modificado e em `rename`/`unlink`, mas **ignora o erro** da
  sincronização (`onPersistComplete` não recebe `err`). Isso esconderia
  `QuotaExceededError`, o que contraria a regra de falhar alto.
- Como o `mknod` também agenda sincronização, um `setTimeout` pode rodar entre
  duas escritas repassadas e persistir um arquivo **pela metade**. Por isso todo
  arquivo persistido deve ser escrito como `.tmp` + `rename` (§6.2).

## 3. Opções avaliadas

| Opção | Veredito | Motivo |
|---|---|---|
| **IDBFS com `FS.syncfs` explícito controlado pela página** | **Escolhida** | Vem no Emscripten; o runtime continua usando `std::filesystem`; transação atômica; cabe save state; erros tratáveis |
| IDBFS com `autoPersist` | Rejeitada | Erro de gravação silencioso; sincroniza arquivo pela metade (ver acima) |
| `localStorage` | Rejeitada | Só string (base64), ~5 MB, não existe no worker onde o jogo roda, síncrono na thread da página, não cabe save state |
| WasmFS + backend OPFS | Adiada | Exige trocar o FS inteiro do build (IDBFS não funciona com WasmFS), mexe no carregamento da ROM e em tudo que usa `Module.FS`; risco maior sem ganho necessário agora |
| Ponte própria C++ → IndexedDB/OPFS | Rejeitada | Duplica o IDBFS e exige ponte assíncrona nova |
| Servidor | Proibida pelo requisito | O save precisa ficar no visitante |

## 4. Arquitetura

```
pthread do jogo (worker)                    thread da página
────────────────────────                    ────────────────
flush_save / save_state
  └ escreve /saves/<sha1>/*.tmp + rename ── syscalls síncronas ──> MEMFS (montado como IDBFS)
  └ web_notify_storage_write(kind, ok)      (função livre, não
        MAIN_THREAD_ASYNC_EM_ASM             depende de HostWindow)
        ────────────────────────────────────────────────────────> GbrSaves.onWrite()
                                                                    └ persist(): FS.syncfs(false)
                                                                         (coalescido, ENOENT → repete,
                                                                          erro de IDB → visível)
visibilitychange(hidden) ─────────────────────────────────────────> GbrSaves.persist() imediato
onExit / onAbort ─────────────────────────────────────────────────> persist() + await flush()
                                                                         └ IndexedDB "/saves"
                                                                           (origem do deploy,
                                                                            máquina do visitante)
Início:  preRun → mount IDBFS em /saves → FS.syncfs(true) → limpa *.tmp → main()
```

- A página decide **quando** sincronizar; o runtime só avisa que escreveu.
- A página **não depende** do aviso para os momentos críticos: ao ocultar a aba,
  ao sair e ao abortar ela sincroniza por conta própria o que já está completo
  em MEMFS. O aviso cobre o caso normal (jogo gravou durante a partida).
- `MAIN_THREAD_ASYNC_EM_ASM` não bloqueia o guest. Passar só inteiros: um ponteiro
  de string poderia ser liberado antes de a chamada assíncrona rodar.
- O aviso é uma **função livre** em `host_window_web.cpp`, não um método de
  `HostWindow`: o flush final roda depois de `win.close()`, quando `impl_` já é
  `nullptr`.
- A ordem de entrega entre uma chamada `MAIN_THREAD_ASYNC_EM_ASM` e o `onExit`
  não é garantida; por isso o `onExit` sempre chama `persist()` antes de
  `flush()`, em vez de confiar que o último aviso já chegou.
- Mensagens entre threads continuam sendo entregues com a aba oculta (timers são
  estrangulados, mensagens não), o que importa para o flush de aba oculta.

### Layout dos arquivos

```
/saves/                         (IDBFS; banco IndexedDB "/saves")
  <rom_sha1>/
    battery.sav                 dump cru do chip
    battery.sav.bak             cópia anterior, criada só por import
    state1 … state10            save states (formato GBAS)
```

- A chave é o SHA-1 **verificado** da ROM (o runtime recusa hash errado), então
  vários jogos no mesmo domínio não colidem.
- `/data` continua MEMFS: a ROM (16–32 MB) nunca vai para o IndexedDB.

## 5. Garantias e limites (documentar na página)

- **Janela de perda:** até 60 frames (~1 s) de escrita do jogo ainda não gravada
  + a duração de uma transação IndexedDB. Pausar e parar forçam gravação
  imediata. Ocultar a aba dispara na hora a sincronização do que já estava em
  MEMFS e, no frame seguinte, o runtime grava o pendente e avisa de novo.
- **Fechar a aba:** o `visibilitychange` chega, mas o worker só percebe `hidden`
  no próximo frame, e a página costuma morrer antes da segunda sincronização.
  Fechar a aba perde no máximo a janela acima; **o save no IndexedDB nunca fica
  corrompido pela metade** (transação atômica).
- **Remoção pelo navegador:** armazenamento do site é "best-effort" e pode ser
  apagado pelo navegador. Pedir `navigator.storage.persist()` após o primeiro save
  e mostrar o resultado. *A confirmar:* política do Safari de apagar dados de sites
  sem interação por 7 dias. Por isso exportar `.sav` é parte do plano, não extra.
- **Aba anônima/privada:** IndexedDB pode não existir ou sumir ao fechar. Detectar
  e avisar; o jogo roda, exportação funciona.
- **Mesmo domínio:** trocar de domínio (staging → produção) perde os saves;
  exportar/importar migra. Escolher uma origem estável para o deploy.
- **Iframe em outro site:** navegadores particionam o armazenamento pelo site de
  topo; o save do embed é separado do save da página direta.
- **Atualizações do deploy:** `.sav` sobrevive a qualquer build novo (é o chip).
  Save states estão presos à versão do snapshot e ao SHA-1 da ROM e podem ser
  recusados após atualização do runtime; a recusa é explícita, nunca corrompe.
- **Duas abas:** a segunda aba do mesmo jogo não inicia (Web Locks), senão a
  última a gravar venceria e a outra carregaria save velho.

## 6. Mudanças por arquivo

### 6.1 `src/runtime/runtime.cpp`

1. **`--state-dir <dir>`**: novo argumento em `parse_args` (junto de
   `--save-path`, `runtime.cpp:956`). Quando definido, `slot_path(n)`
   (`:2685`) retorna `<dir>/state<n>`; sem ele, comportamento nativo idêntico
   ao atual. Incluir na lista de opções que recebem valor (`runtime.cpp:770-778`).
2. **Distinguir "gravou" de "nada a gravar":** `flush_save` passa a devolver um
   enum pequeno (`SaveFlush::Clean`, `Written`, `Failed`), ou `bool` + `bool*
   wrote`. Os usos que só olham sucesso (`:2277`, `:3744`) passam a comparar
   com `Failed`.
3. **Wrapper com aviso**, definido logo depois de `HostWindow win` (`:2285`) e
   antes de `service_host_pause`. O aviso não usa `win`; o wrapper só existe
   para ter um único ponto que chama `flush_save` e avisa:
   ```cpp
   auto flush_save_notify = [&]() -> bool {
       const SaveFlush r = flush_save();
   #if defined(GBARECOMP_WEB_HOST)
       if (r != SaveFlush::Clean)
           web_notify_storage_write(WebStorageWrite::Battery, r == SaveFlush::Written);
   #endif
       return r != SaveFlush::Failed;
   };
   ```
   Usar o wrapper nos quatro pontos do caminho com janela: hook present-in-place
   (`:3258`), laço externo (`:3685`), pausa (item 5) e flush final (`:3744`).
   O caminho TCP (`:2277`) continua chamando `flush_save` direto.
4. **Aviso de save state:** depois de `do_savestate_save` no tratamento de
   `ev.save_slot` (`:3055-3066`), chamar
   `web_notify_storage_write(WebStorageWrite::State, ok)` sob
   `GBARECOMP_WEB_HOST`.
5. **Flush imediato ao pausar/parar (só web):** em `service_host_pause`
   (`:3169`), na primeira iteração (`!waited`), dentro de
   `#if defined(GBARECOMP_WEB_HOST)`, chamar `flush_save_notify()` antes de
   esperar. Motivo: no hook a checagem de 60 frames (`:3257`) roda antes da
   pausa (`:3264`), então sem isso o save sujo fica na RAM enquanto a aba estiver
   oculta. No nativo não muda nada (a regra "nativo inalterado" do §1 vale); se
   um dia quiserem o mesmo no nativo, é mudança separada, declarada e com A/B.
   Como `service_host_pause` é declarado depois de `win`, ele enxerga o wrapper.
6. **Unificar a constante:** mover `constexpr uint64_t kSaveFlushIntervalFrames
   = 60;` (`:3539`) para antes do hook (junto de `web_save_last_flush`, `:3142`)
   e usá-la em `:3257` no lugar do `60` literal.
7. O `quit` do hook (`host_quit`) continua caindo no `flush_save` final
   (`:3744`), agora pelo wrapper. Não reordenar com `win.close()`: o aviso não
   depende do HostWindow.
8. Não mudar ordem de carga do save, validação de tamanho nem a precedência de
   `resolve_save_configuration`.

### 6.2 `src/debug/snapshot.cpp`

`save_state` passa a gravar `<path>.tmp` e `rename` sobre o destino, igual a
`flush_save` (inclusive o fallback remove+rename). Motivos: no nativo, um crash
no meio deixava o slot truncado; na web, evita persistir arquivo pela metade.
Esta é a única mudança do nativo; validar com o procedimento de "nativo
inalterado" (A/B de saída) e ctest.

### 6.3 `src/runtime/host_window.h` e `host_window_web.cpp`

Função livre, fora da classe (o flush final roda com `impl_ == nullptr`):

```cpp
#if defined(GBARECOMP_WEB_HOST)
enum class WebStorageWrite : uint32_t { Battery = 1, State = 2 };
// Worker → page, non-blocking. Integers only (async proxy). Independent of
// HostWindow lifetime: the final battery flush runs after HostWindow::close().
void web_notify_storage_write(WebStorageWrite kind, bool ok);
#endif
```

Implementação:
`MAIN_THREAD_ASYNC_EM_ASM({ globalThis.GbrSaves?.onWrite($0, $1); },
static_cast<int>(kind), ok ? 1 : 0);`
no mesmo estilo do `MAIN_THREAD_EM_ASM` já usado em `load_input_config`
(`host_window_web.cpp:142`). Não muda o layout de `host_web_shared.h` (sem bump
de ABI).

### 6.4 `packaging/web/save_store.js` (novo)

Classe `GbrSaveStore`, sem dependências, exposta como `globalThis.GbrSaves`:

- `constructor(log, onStatus)`.
- `async acquireLock(sha1)`: `navigator.locks.request('gbarecomp:'+sha1,
  {ifAvailable:true}, lock => …)`; com `lock` não nulo, devolver uma promessa
  que só resolve no fim da sessão. `lock === null` → status "jogo aberto em
  outra aba", não inicia. Sem suporte a Web Locks → aviso e segue (a confirmar
  versões mínimas).
- `mount(Module, sha1)` (dentro do `preRun`): `FS.mkdir('/saves')`,
  `FS.mount(FS.filesystems.IDBFS, {}, '/saves')`, `addRunDependency('saves')`,
  `FS.syncfs(true, cb)`. No callback: criar `/saves/<sha1>`, apagar `*.tmp`
  órfãos, `removeRunDependency('saves')`. Erro → status `unavailable`, log alto,
  `removeRunDependency` e o jogo inicia sem persistência (decisão de produto:
  jogar sem save persistente, com aviso fixo na página).
- `onWrite(kind, ok)`: `ok=0` → status `error` + log; senão `persist()`.
- `persist()`: coalescência própria com erro visível — estados `idle`,
  `syncing`, `again`. Chamado com `syncing` → vira `again`; ao terminar com
  `again`, roda outra vez.
  - Sucesso: `lastPersisted = Date.now()`; na primeira vez,
    `navigator.storage.persist()` e registrar o resultado.
  - **Erro do FS** (`err instanceof FS.ErrnoError`, tipicamente ENOENT da corrida
    de §2): não é falha de armazenamento. Contar em `retries`, logar em nível
    informativo e repetir (máx. 3 tentativas seguidas com ~50 ms entre elas;
    passou disso → status `error`).
  - **Erro do IndexedDB** (`QuotaExceededError`, `AbortError`, outros
    `DOMException`) → status `error` com a mensagem, sem repetir em loop.
- `async flush()`: resolve quando não há sincronização pendente (`idle`),
  rejeita se o estado final for `error`. Usado no `onExit`/`onAbort` e antes de
  import/delete.
- `exportBattery()` → `Uint8Array` de `/saves/<sha1>/battery.sav` (versão já
  gravada pelo runtime). Nome sugerido: título e código do cabeçalho da ROM
  (bytes `0xA0..0xAF` do arquivo já baixado) + `.sav`.
- `async importBattery(bytes)`: só com o jogo **parado** (não iniciado ou já
  saído). Aceita tamanhos 512, 8192, 32768, 65536 ou 131072; copia
  `battery.sav` atual para `battery.sav.bak`, grava via `.tmp` + `rename`,
  `persist()`, `await flush()`, depois `location.reload()`. O runtime continua
  sendo a autoridade: tamanho maior que o chip é recusado no início, com log.
- `restoreBackup()`, `deleteAll()` (com confirmação), `async estimate()`
  (`navigator.storage.estimate()` para mostrar uso).
- Status exposto em `snapshot()` para o harness: `{state, lastPersisted,
  persistent, error, writes, syncs, retries}`.

### 6.5 `packaging/web/bootstrap.js` e `index.html`

- Carregar `save_store.js` antes de `bootstrap.js`.
- No Start: `sha1` obrigatório para persistir (sem SHA-1 conhecido → não montar
  IDBFS e avisar). `await saves.acquireLock(sha)` antes de baixar assets.
- Argumentos adicionais: `--save-path /saves/<sha1>/battery.sav
  --state-dir /saves/<sha1>`.
- `preRun`: depois de gravar ROM/BIOS em `/data`, `saves.mount(Module, sha)`.
- `visibilitychange` com `document.hidden`: `saves.persist()` imediatamente,
  sem esperar o aviso do runtime (grava o que já está completo em MEMFS; o
  flush do pendente chega depois pelo aviso de §6.1 item 5).
- `onExit`: **sempre** `saves.persist()` e depois `await saves.flush()`, antes de
  `host.shutdown()` e antes de liberar o botão Reload. Não confiar que o aviso
  do flush final já chegou (§4).
- `onAbort` (`fail`): mesmo `persist()` + `flush()`, sem bloquear a mensagem de
  erro. Os arquivos em MEMFS estão completos por causa do `.tmp` + `rename`.
- `beforeunload`: se `saves.state !== 'idle'`, pedir confirmação (o navegador
  mostra o diálogo padrão). `pagehide`: nada a esperar.
- Exportação de diagnósticos (`$('export')`): passar a incluir `/saves` (o
  filtro atual já pega `.sav`; acrescentar `state[0-9]+`).
- UI: status "Save no navegador: gravado há Ns / gravando / erro / indisponível /
  não persistente", botões **Exportar save**, **Importar save**
  (`<input type="file" hidden>`), **Restaurar backup** e **Apagar saves**, e
  trocar o aviso de `index.html:40` ("Saves are volatile (MEMFS)…") por "o save
  fica neste navegador; exporte para guardar uma cópia".

### 6.6 `packaging/web/build_web.sh`

- Link: acrescentar `-lidbfs.js`. Manter `-sFORCE_FILESYSTEM` e os
  `EXPORTED_RUNTIME_METHODS` atuais (`FS`, `ENV`, `addRunDependency`,
  `removeRunDependency`). Confirmar no bundle que
  `Module.FS.filesystems.IDBFS` existe; se não, exportar `IDBFS`.
- Copiar `save_store.js` para a saída e incluí-lo no `manifest.json`.
- Não usar `-sWASMFS`.
- As flags de link wasm também estão em `cmake/runtime.cmake.in` e já divergem
  (achado de review aberto). Pôr `-lidbfs.js` só no `build_web.sh`, que é o
  caminho do bundle de navegador, e registrar a divergência.

### 6.7 Testes (`tests/web/`)

- **Pré-requisito:** trazer `tests/web/browser.py`, `tests/web/test_game.py` e
  `tests/web/host_unit_test.js` da branch `feat/web-canvas-host` para o checkout
  (hoje ausentes; a worktree do laboratório foi removida).
- `test_save.py` (novo), usando `browser.py`. Precisa de uma opção no `Browser`
  para **reutilizar o diretório de perfil** entre instâncias (hoje é
  `TemporaryDirectory` apagado no `close`), necessária para o teste de fechar o
  navegador à força.
- Estender `host_unit_test.js` com a máquina de estados de `persist()` usando um
  `FS.syncfs` falso: coalescência (`again`), `ErrnoError` repete e depois
  sucede, `ErrnoError` 3× vira `error`, `QuotaExceededError` vira `error` sem
  repetir, `flush()` resolve/rejeita.

## 7. Ordem de implementação e gates

| Fase | Trabalho | Gate |
|---|---|---|
| F0 | Trazer `tests/web/*` de `feat/web-canvas-host`; `build_web.sh` gera bundle que roda em Chrome | `tests/web/test_game.py` verde |
| F1 | `snapshot.cpp` atômico, `--state-dir`, enum de `flush_save`, wrapper + `web_notify_storage_write`, constante unificada, flush ao pausar (web) | Nativo inalterado (procedimento A/B do projeto; única diferença esperada: save state via `.tmp`), ctest verde, save state nativo salva/carrega |
| F2 | `save_store.js` + mount/populate + `persist()` com repetição de ENOENT + `-lidbfs.js` + `persist()` no `onExit`/`onAbort` | T1, T2, T11 |
| F3 | `persist()` no `visibilitychange`, `beforeunload`, Web Locks | T4, T5, T6 |
| F4 | Exportar/importar/backup/apagar, `storage.persist()`, status | T1, T7, T9 |
| F5 | Save states persistentes | T3, T12 |
| F6 | Firefox e Safari manuais; atualizar `docs/WEB_WASM_PORT.md` (WEB-8) e memória | checklist §9 |

Em toda execução de jogo: ler o banner de cobertura e os `recomp_master_misses`
exportados do MEMFS, conforme a regra de dispatch miss. O trabalho de save não
pode alterar cobertura.

## 8. Riscos e itens a confirmar

| Item | Como confirmar |
|---|---|
| `FS.filesystems.IDBFS` presente no bundle com `-lidbfs.js` | `Module.FS.filesystems` no console do bundle |
| Corrida `getLocalSet` × `reconcile` (§2) com escrita concorrente | T12; contador `retries` em `snapshot()` |
| Custo na thread da página de sincronizar 128 KB a cada ~1 s enquanto o jogo grava | Medir tempo de `syncfs` e frames perdidos no rAF durante um save de Flash |
| Tamanho real de um save state (estimativa: poucas centenas de KB) | Medir `state1` gerado em T3 |
| `mtime` igual em escritas no mesmo ms fazendo `syncfs` ignorar mudança | Debounce de 60 frames torna improvável; T2 compara bytes após reload |
| Ordem de entrega `MAIN_THREAD_ASYNC_EM_ASM` × `onExit` | Coberto por `persist()` incondicional no `onExit`; T11 |
| Versões mínimas de Web Locks e `storage.persist()`; política de 7 dias do Safari | Documentação oficial dos navegadores antes do deploy |
| Compatibilidade do `.sav` com mGBA (EEPROM em especial) | T9 |
| `.sav` do mGBA de jogo com RTC (ex.: Emerald) pode ter bytes extras depois do dump do chip; se tiver, o runtime recusa ("save file too large") | T9 com um `.sav` real do mGBA; se houver trailer, decidir (cortar no import da página com aviso, ou recusar) antes de liberar o import |
| Import de arquivo menor que o chip é aceito e preenchido com `0xFF` (comportamento atual) | Decidir se a página deve exigir tamanho exato; hoje o runtime aceita |

## 9. Testes de aceite

Todos em Chrome headless via `tests/web/browser.py`, com
`GBARECOMP_SELFHEAL_RECOMPILE=0` como no `test_game.py`.

- **T1 — ida e volta por import:** gerar 131072 bytes determinísticos; importar
  com o jogo parado; recarregar; iniciar. Esperado no log:
  `save_loaded path="/saves/<sha1>/battery.sav" size=131072/131072`. Exportar e
  comparar SHA-256 com o arquivo gerado.
- **T2 — gravação feita pelo jogo:** gravar uma vez no nativo uma sessão com
  `GBARECOMP_INPUT_RECORD` que salva no jogo (Emerald, Flash 1M). No navegador,
  colocar o arquivo de replay em `/data` e rodar com `GBARECOMP_INPUT_REPLAY`.
  Esperar `save_flushed` no log e `saves.state == 'idle'` com `lastPersisted`
  posterior. `Page.reload`, iniciar sem replay → `save_loaded`. O `.sav` exportado
  deve ser **idêntico byte a byte** ao `.sav` do nativo com o mesmo replay.
  (Atenção ao aborto pré-existente com input replay no PK; se reaparecer, é
  bloqueio anterior a este trabalho.)
- **T3 — save state:** Save slot 1 → aguardar persist → reload → Load slot 1 →
  `savestate_loaded slot=1 path="/saves/<sha1>/state1"`.
- **T4 — aba oculta:** com save sujo (logo após o jogo gravar, antes de 60
  frames), simular `document.hidden=true` + `visibilitychange`; esperar persist
  sem avançar frames; reload; save presente.
- **T5 — fechamento abrupto:** após persist confirmado, matar o processo do
  Chrome; abrir novo Chrome com o mesmo perfil; save presente. Repetir matando
  durante uma sincronização: o save no IndexedDB deve ser exatamente a versão
  anterior ou a nova, nunca outra coisa.
- **T6 — duas abas:** segunda aba com o mesmo SHA-1 mostra "aberto em outra aba"
  e não inicia o runtime.
- **T7 — falha de armazenamento:** substituir `indexedDB.open` por uma função que
  lança erro; página mostra "indisponível", log tem o erro, jogo inicia,
  exportação funciona. Simular `QuotaExceededError` no `syncfs` → status `error`.
- **T8 — nativo inalterado:** sem `--state-dir`, `slot_path` e saídas iguais ao
  baseline; save state nativo continua carregando arquivos antigos; pausar no
  nativo não grava save (flush ao pausar é só web).
- **T9 — compatibilidade:** importar `.sav` gerado pelo mGBA (oráculo do projeto)
  para SRAM, Flash e EEPROM quando houver ROM de cada tipo, incluindo um jogo com
  RTC; o jogo reconhece o save.
- **T10 — cobertura:** banner e arquivos de miss de todas as execuções acima
  revisados; nenhum miss novo atribuído ao trabalho de save.
- **T11 — Stop logo após gravar:** fazer o jogo gravar (replay de T2) e clicar
  Stop antes de 60 frames. Esperado: `save_flushed` no log depois do fechamento
  da janela, `onExit` só libera Reload após `flush()`, e depois do reload
  `save_loaded` com os bytes novos.
- **T12 — escrita concorrente com sincronização:** com `FS.syncfs` instrumentado
  para atrasar `getRemoteSet` ~200 ms, disparar Save state enquanto um persist de
  bateria está em andamento. Esperado: `retries >= 1`, estado final `idle`, sem
  `error`, e depois do reload `battery.sav` e `state1` corretos e nenhum `*.tmp`
  em `/saves/<sha1>`.

## 10. Comandos de referência

```bash
# Testes web ausentes do checkout (F0)
git checkout feat/web-canvas-host -- tests/web/browser.py tests/web/test_game.py tests/web/host_unit_test.js

# Build web
packaging/web/build_web.sh output/pk build/generated_bios roms/pk.gba <bios>
python3 packaging/web/serve.py output/pk/web

# Testes
python3 tests/web/test_game.py 600 /tmp/gbr-game
python3 tests/web/test_save.py --url http://127.0.0.1:18083/ /tmp/gbr-save

# Inspeção manual no console da página
Module.FS.filesystems.IDBFS          // deve existir
Module.FS.readdir('/saves')          // diretório do sha1
GbrSaves.snapshot()                  // estado de persistência
```

## 11. Fora de escopo

- Sincronizar saves entre dispositivos (exigiria servidor ou serviço externo).
- Migrar para WasmFS/OPFS (reavaliar só se o custo de `syncfs` medido em §8 for
  um problema).
- UI de gerenciamento de múltiplos jogos no mesmo domínio.
- Slots de estado de mod (`write_mod_state_slot`): não há chamador no runtime
  hoje; quando houver, o diretório deve ficar sob `/saves/<sha1>/` e avisar com
  `WebStorageWrite::State`.
- Achados de review abertos do host web (use-after-free no detach etc.): são
  pré-existentes e independentes deste plano.
