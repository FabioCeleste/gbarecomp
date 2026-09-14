# WEB_WASM_PORT — suporte a navegador via WebAssembly

**Status:** pesquisa / levantamento original. **Atualização:** o host de navegador foi
decidido e implementado conforme `docs/WEB_WASM_CANVAS_IMPLEMENTATION_PLAN.md`
(WebGL da página + buffer triplo compartilhado + AudioWorklet, sem SDL no wasm).
As referências a `-sUSE_SDL=2` e ao branch `EMSCRIPTEN` do SDL abaixo são históricas.
**Data:** 2026-09-13
**Escopo:** onde o suporte web moraria na estrutura atual e quais arquivos mudam.

Referências cruzadas: `docs/ARCHITECTURE.md`, `CLAUDE.md` (regra de dispatch
miss), `README.md` (seção Android — o precedente que este documento segue).

---

## Resumo

O suporte web segue **exatamente o padrão do Android**: nenhuma pasta nova no
core, só um branch no CMake e blocos `#if defined(__EMSCRIPTEN__)` nos mesmos
arquivos de host que já têm `__ANDROID__`.

Mas há **uma decisão arquitetural que precede qualquer arquivo** (seção 1), e
**um bloqueio de pré-requisito** que não é código (seção 3).

---

## 1. O obstáculo real: o loop bloqueante e o *present-in-place*

O navegador não permite bloquear a thread principal. E este runtime não só
bloqueia — ele faz algo mais agressivo (`src/runtime/runtime.cpp:3160`):

```cpp
if (args.window && present_in_place) {
    // "frame-boundary resume misses eliminated structurally"
    runtime_set_frame_present_hook([&]() -> bool {
        ...
        if (present_frame) win.present(live_fb.data());
        ...
        if (pacer) pacer->wait_for_next_frame();   // ← bloqueia AQUI
```

Como diz o comentário em `runtime.cpp:3192`: *"Present-in-place can remain
inside a single `step_once()` for the entire windowed session."* Ou seja: a
sessão inteira roda dentro de **uma única chamada** ao código recompilado, e o
`present` + o pacer acontecem num hook no fundo da pilha de chamadas do jogo.

### Três opções

| Abordagem | Veredito |
|---|---|
| `emscripten_set_main_loop` no loop externo (`runtime.cpp:3469`) | ❌ Exige desligar present-in-place → reintroduz *frame-boundary resume misses*, que no navegador **não têm como se auto-curar** (seção 3). Vai contra o `CLAUDE.md`. |
| `-sASYNCIFY` | ❌ O ponto de yield está no fundo do código do jogo → instrumentaria **todo** o código recompilado (centenas de MB de C gerado). Tamanho e lentidão inviáveis. |
| **`-sPROXY_TO_PTHREAD`** | ✅ `main()` roda num Web Worker, onde bloquear é legal. Preserva o loop, o `FramePacer`, o `game_thread` (`runtime.cpp:2134`), o worker do `overlay_loader` (`overlay_loader.cpp:473`) e o sampler do bus bridge. Custo: exige `SharedArrayBuffer` → headers **COOP/COEP** no servidor. |

**Recomendação: `PROXY_TO_PTHREAD`.** É o que casa com a arquitetura existente
e o caminho que ports sérios (RetroArch, Dolphin) usam. Isso muda a natureza do
trabalho: em vez de reescrever o loop principal, você reconfigura o build.

---

## 2. Onde o suporte fica

| Camada | Onde |
|---|---|
| SDL2 vindo do ambiente | `CMakeLists.txt:98` — branch `elseif(EMSCRIPTEN)` ao lado do `if(ANDROID ...)` |
| Flags de link web | `cmake/runtime.cmake.in` — estender `gbarecomp_target_link_host_stack` + novo `gbarecomp_add_web_target` |
| Comportamento em runtime | blocos `#if defined(__EMSCRIPTEN__)` nos mesmos arquivos que já têm `__ANDROID__` |
| Shell HTML compartilhado (**novo**) | `packaging/web/` — espelhando `packaging/flatpak/` |
| Casca por jogo | `index.html` + servidor com COOP/COEP no repo do jogo (equivalente ao projeto Gradle do Android) |

Vale repetir o modelo mental do Android aqui: **o suporte é código
compartilhado**, escrito uma vez no core. O que se repete por jogo é apenas a
casca de empacotamento, porque cada jogo é um binário próprio (código
recompilado específico do ROM).

---

## 3. BLOQUEANTE: auto-cura é impossível no navegador

Este é o achado que muda o planejamento.

`src/runtime/overlay_compile.cpp:218` faz `std::system("gcc ... -shared")` e
`overlay_compile.cpp:231` faz `dlopen`. Nada disso existe no navegador — não há
como compilar e carregar código nativo novo em tempo de execução.

> **Consequência:** um build web só é válido se a cobertura daquele jogo já
> estiver `FULLY STATIC`. Um dispatch miss no navegador não se auto-cura — ele
> simplesmente mata a sessão.

Logo o pré-requisito não é código, é o **loop de build do `CLAUDE.md` fechado**
para o jogo-alvo. E `overlay_compile.cpp` está incondicionalmente na lista de
fontes (`CMakeLists.txt:328`), então precisa de um gate novo.

---

## 4. Arquivos a alterar

### Build

| Arquivo | Mudança |
|---|---|
| `CMakeLists.txt:98` | Branch `EMSCRIPTEN` (`-sUSE_SDL=2`, sem `find_path`) |
| `CMakeLists.txt:328` | Gate para `overlay_compile.cpp` (nova opção `GBARECOMP_ENABLE_SELFHEAL_COMPILE`) |
| `CMakeLists.txt:636+` | Envolver `bios_smoke`, `gba_recompile`, oracle e todos os testes em `if(NOT EMSCRIPTEN)`. O recompilador **tem** que rodar nativo → usar duas árvores de build: uma nativa para gerar o C, uma `emcmake` para o runtime |
| `cmake/runtime.cmake.in:24` | `gbarecomp_target_link_host_stack` precisa de branch Emscripten com **`-sSTACK_SIZE=16777216`**. Crítico e fácil de esquecer: o stack padrão do wasm é 64 KB, e o código recompilado assume os 16 MB que `GBARECOMP_HOST_STACK_RESERVE_BYTES` reserva. Somar `-sPROXY_TO_PTHREAD`, `-sPTHREAD_POOL_SIZE`, `-sALLOW_MEMORY_GROWTH`, `--preload-file` |

Não é preciso toolchain próprio: o Emscripten já traz `Emscripten.cmake`
(configure com `emcmake cmake`).

**`-mtail-call` é obrigatório** na compilação e no link de tudo (runtime e lib do jogo). O
código gerado depende de tail calls garantidas (`GBARECOMP_TAIL_*` em `runtime_arm.h`); sem a
flag o header dá `#error`. O `CMakeLists.txt`, o `cmake/runtime.cmake.in` e o template do
`tools/cli.py` já a adicionam sob `EMSCRIPTEN`. Ver `docs/WEB_WASM_TAILCALL_IMPLEMENTATION.md`.

Suporte de navegador a tail calls wasm: "Baseline Newly available" desde dez/2024. Versões
mínimas **a confirmar** em webassembly.org/features antes do lançamento (de memória: Chrome 112,
Firefox 121, Safari 18.2).

Build de navegador de teste: `packaging/web/build_web.sh <projeto> <BIOS gerado> [rom] [bios]`
e `packaging/web/serve.py` (COOP/COEP). Estado atual em `docs/WEB_WASM_EXPERIMENTS.md` §11.

### Runtime

| Arquivo | Mudança |
|---|---|
| `src/runtime/host_window.cpp` | **O maior.** `SDL_CreateRenderer` (`:1150`) vira WebGL, ok. Áudio por callback (`:883`, `:1255`) precisa de AudioWorklet + gesto do usuário para iniciar. `SDL_HINT_ORIENTATIONS`/fullscreen (`:1109`, `:1747`) exige gesto. **Bônus:** os ~12 blocos `__ANDROID__` (touch, D-pad, escala de UI 1.75×) são reaproveitáveis para web mobile — preferir um teste de "dispositivo touch" em runtime a duplicar as condições de compilação |
| `src/runtime/host_platform.cpp` | `FramePacer`; num worker o `sleep_until` funciona, mas vale um branch |
| `src/runtime/asset_picker.cpp:221` | Branch POSIX; web precisa de `<input type=file>` ou arquivo pré-carregado |
| `src/runtime/overlay_compile.cpp`, `overlay_loader.cpp` | Stubs para wasm (ver seção 3) |
| `src/runtime/runtime.cpp:2550` | O gate `!__ANDROID__` de fullscreen/window-scale do menu |
| `src/runtime/runtime.cpp:1622-1715` | **Saves.** Gravam `.sav` via `std::filesystem`. **Resolvido (2026-09-13):** o bundle monta IDBFS em `/saves/<rom sha1>` (`--save-path .../battery.sav --state-dir ...`); o runtime só avisa que gravou (`web_notify_storage_write`) e a página sincroniza com `FS.syncfs` explícito (`packaging/web/save_store.js`). Ver `docs/WEB_SAVE_PERSISTENCE_PLAN.md` |
| `src/debug/tcp_debug_server.cpp`, `src/debug/cosim.cpp` | Sockets crus. `gbarecomp_debug` é sempre linkado (`CMakeLists.txt:423`), então o stub tem que ser interno |

### Casca por jogo

- `index.html` + glue JS
- Servidor com headers COOP/COEP (requisito do `SharedArrayBuffer`)
- ROM/BIOS pré-carregados (`--preload-file`) ou via `fetch`
- Botão de início (áudio e fullscreen exigem gesto do usuário)

---

## 5. O que vem de graça

Melhor do que o esperado:

- `src/gba/foreign_screen_overlay.h:37` **já trata ponteiro de 32 bits**
  (`sizeof(void*) == 8 ? 40u : 28u`) — wasm32 não é terreno virgem.
- `gba_recompile`, o BIOS recompilado, `armv4t`, PPU e APU são C++ portável puro.
- Gamepad USB funciona via Gamepad API.
- Giroscópio não existe no navegador → cai no fallback de mouse que o
  `README.md:116` já descreve.

---

## 6. O risco que se mede primeiro

**Tamanho do `.wasm`.** Centenas de MB de C gerado podem produzir um binário que
nenhum navegador carrega em tempo razoável.

Antes de escrever qualquer código: compilar o C já gerado de *um* jogo com
`emcc -Os -c` e medir o tamanho do objeto. **Se isso não fechar, nada mais
importa.**

---

## Ordem sugerida

1. Medir o tamanho do wasm (seção 6) — pode matar a ideia antes de gastar esforço.
2. Confirmar cobertura `FULLY STATIC` do jogo-alvo (seção 3) — pré-requisito duro.
3. Decidir `PROXY_TO_PTHREAD` (seção 1).
4. Branch de build + stack de 16 MB (seção 4, Build).
5. Camada de host: janela, áudio, saves em IDBFS (seção 4, Runtime).
6. Shell web compartilhado em `packaging/web/` + casca do jogo.
